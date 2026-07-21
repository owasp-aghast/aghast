/**
 * CLI entry point for aghast.
 * Usage: aghast scan <repository-path> --config-dir <path> [options]
 */

import 'dotenv/config';
import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { runMultiScanWithCost, type MultiScanOptions } from './scan-runner.js';
import type { JudgeOptions } from './judge.js';
import { loadDefaultPricing, mergePricing, formatCostSourceLabel } from './cost-calculator.js';
import type { BudgetLimits } from './budget.js';
import { saveScanRecord, queryScanHistory, type ScanRecord } from './scan-history.js';
import { writeIndividualIssueFiles, type IndividualIssueFormat } from './issue-file-writer.js';
import { createProviderByName, getProviderNames, DEFAULT_PROVIDER_NAME } from './provider-registry.js';
import {
  loadCheckRegistry,
  discoverCheckFolders,
  resolveChecks,
  filterChecksForRepositoryAsync,
  sortChecksByPriority,
  validateCheck,
  loadCheckDetails,
} from './check-library.js';
import { clearRepoSnapshotCache } from './repo-scan.js';
import { analyzeRepository } from './repository-analyzer.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { logProgress, logDebug, logWarn, setLogLevel, createTimer, isValidLogLevel, initFileHandler, closeAllHandlers, getAvailableLogTypes } from './logging.js';
import type { LogLevel } from './logging.js';
import { MOCK_MODEL_NAME, DEFAULT_MODEL, type AgentProvider } from './types.js';
import { getFormatter } from './formatters/index.js';
import { verifySemgrepInstalled } from './semgrep-runner.js';
import { verifyOpengrepInstalled } from './opengrep-runner.js';
import { verifyOpenAntInstalled } from './openant-runner.js';
import { MockAgentProvider } from './mock-agent-provider.js';
import { ERROR_CODES, formatError, formatFatalError } from './error-codes.js';
import { DEFAULT_OUTPUT_FORMAT, DEFAULT_LOG_LEVEL, DEFAULT_LOG_TYPE } from './defaults.js';
import { docsFooter } from './docs-url.js';
import { colorStatus } from './colors.js';
import { getCheckType } from './check-types.js';
import { getDiscovery, getRegisteredDiscoveries } from './discovery.js';
import { postPRComments } from './result-handlers/pr-comment-handler.js';
import { createRequire } from 'node:module';

const TAG = 'aghast';

async function createMockJudgeProvider(modelOverride?: string): Promise<AgentProvider> {
  // AGHAST_MOCK_JUDGE='true' → default TP response; AGHAST_MOCK_JUDGE=<path> → read from that file
  const mockJudgeValue = process.env.AGHAST_MOCK_JUDGE;
  let rawResponse = '{"verdict":"true_positive","confidence":1.0,"rationale":"mock"}';
  if (mockJudgeValue && mockJudgeValue !== 'true') {
    try {
      rawResponse = await readFile(resolve(mockJudgeValue), 'utf-8');
    } catch (err) {
      throw new Error(formatError(ERROR_CODES.E8001, `path: ${mockJudgeValue}`), { cause: err });
    }
  }
  // Test hook mirroring AGHAST_MOCK_FAIL_TIMES, but for the judge's own calls.
  // Kept separate so a test can fail the judge without also failing the scan
  // (and vice versa) — the two are retried independently.
  const failTimesRaw = process.env.AGHAST_MOCK_JUDGE_FAIL_TIMES;
  const parsedFailTimes = failTimesRaw ? Number(failTimesRaw) : 0;
  const failTimes = Number.isInteger(parsedFailTimes) && parsedFailTimes > 0 ? parsedFailTimes : 0;

  const provider = new MockAgentProvider({ rawResponse, failTimes });
  await provider.initialize({});
  provider.setModel?.(modelOverride ?? MOCK_MODEL_NAME);
  return provider;
}

async function createMockProvider(): Promise<AgentProvider> {
  // AGHAST_MOCK_AI='true' → default empty response; AGHAST_MOCK_AI=<path> → read from that file
  const mockAiValue = process.env.AGHAST_MOCK_AI;
  let rawResponse = '{"issues": []}';
  if (mockAiValue && mockAiValue !== 'true') {
    try {
      rawResponse = await readFile(resolve(mockAiValue), 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read AGHAST_MOCK_AI response file: ${mockAiValue}`, { cause: err });
    }
  }

  // Optional mock token usage for testing cost/budget pipelines.
  // Format: AGHAST_MOCK_TOKENS="<input>,<output>" (e.g. "1000,500")
  // When AGHAST_LOCAL_CLAUDE=true, inject a mock reportedCost so that the
  // coveredBySubscription path (banner "equivalent", label) is exercisable in tests.
  let tokenUsage: import('./types.js').TokenUsage | undefined;
  const mockTokensRaw = process.env.AGHAST_MOCK_TOKENS;
  if (mockTokensRaw) {
    const parts = mockTokensRaw.split(',').map((s) => Number(s.trim()));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
      const useLocalClaude = process.env.AGHAST_LOCAL_CLAUDE === 'true';
      tokenUsage = {
        inputTokens: parts[0],
        outputTokens: parts[1],
        totalTokens: parts[0] + parts[1],
        ...(useLocalClaude ? {
          reportedCost: {
            amountUsd: (parts[0] + parts[1]) / 1_000_000,
            source: 'claude-agent-sdk' as const,
            coveredBySubscription: true,
          },
        } : {}),
      };
    }
  }

  // Test hook: AGHAST_MOCK_FAIL_TIMES=<n> makes the mock fail its first n calls
  // with a retryable (503) error before succeeding, so retry behaviour can be
  // exercised end-to-end through the real CLI.
  const failTimesRaw = process.env.AGHAST_MOCK_FAIL_TIMES;
  const parsedFailTimes = failTimesRaw ? Number(failTimesRaw) : 0;
  const failTimes = Number.isInteger(parsedFailTimes) && parsedFailTimes > 0 ? parsedFailTimes : 0;

  const provider = new MockAgentProvider({ rawResponse, tokenUsage, failTimes });
  await provider.initialize({});
  return provider;
}

const SCAN_HELP = `Usage: aghast scan <repo-path> --config-dir <path> [options]

Run security checks against a repository.

Arguments:
  <repo-path>                Path to the repository to scan

General options:
  -h, --help                 Show this help message
  --config-dir <path>        Config directory containing checks-config.json,
                             checks/ folder, and optionally runtime-config.json.
                             Required unless AGHAST_CONFIG_DIR is set.
  --output <path>            Output file path for results
                             (default: <repo-path>/security_checks_results.<ext>)
  --output-format <fmt>      Output format: json, sarif, csv, html, markdown (default: json)
  --fail-on-check-failure    Exit with code 1 if any check FAILs or ERRORs
  --debug                    Shorthand for --log-level debug
  --log-level <level>        Console log level: error, warn, info, debug, trace
                             (default: info)
  --log-file <path>          Write all log output to a file (always at trace level
                             unless overridden by --log-type)
  --log-type <type>          Log file handler type (default: file).
                             Available types: file
  --model <model>            AI model override (e.g. claude-sonnet-4-20250514)
  --agent-provider <name>    Agent provider name (default: claude-code)
  --generic-prompt <file>    Generic prompt template filename in prompts/ dir
  --runtime-config <path>    Path to runtime config file
  --diff-ref <ref>           Git ref to diff against (e.g. HEAD~1, main, SHA).
                             Auto-activates diff filtering on every check whose
                             discovery supports it, unless the check opts out
                             via checkTarget.diffFilter: false.
  --diff-file <path>         Path to pre-generated unified diff file
                             (alternative to --diff-ref)
  --budget-limit-cost <usd>  Abort the scan when accumulated cost exceeds this
                             USD value. Warns at 80%, aborts at 100%
  --budget-limit-tokens <n>  Abort the scan when accumulated tokens exceed n.
                             Warns at 80%, aborts at 100%

PR comment options (post findings as inline GitHub PR review comments):
  --pr <number>              Pull request number to post comments on
  --repo <owner/repo>        GitHub repository in owner/repo form
                             (default: $GITHUB_REPOSITORY)
  --base-sha <sha>           Base commit SHA (default: $GITHUB_BASE_SHA)
  --head-sha <sha>           Head commit SHA
                             (default: $GITHUB_HEAD_SHA / $GITHUB_SHA)
Judge stage options (enables a post-scan LLM re-evaluation of findings):
  --judge-model <model>      Enable the judge stage using this model. Required
                             to activate the stage (no separate --judge flag).
  --judge-provider <name>    Agent provider for the judge (default: scan provider)
  --judge-concurrency <n>    Max concurrent judge calls (default: 5)
  --judge-drop-false-positives  Remove issues judged as false positives from output
  --judge-min-confidence <f> Demote true_positive verdicts with confidence < this
                             value to uncertain (0.0–1.0)
  --retry-max-attempts <n>   Retry transient provider failures up to n attempts
                             per AI call (default: 1, i.e. no retry)

Environment variables:
  ANTHROPIC_API_KEY           API key for Claude. If unset, AI-based checks fall
                              back to a logged-in local Claude session
  AGHAST_CONFIG_DIR           Default config directory (CLI --config-dir takes precedence)
  AGHAST_AI_MODEL             AI model override (CLI --model takes precedence)
  AGHAST_GENERIC_PROMPT       Generic prompt template filename (CLI --generic-prompt takes precedence)
  AGHAST_DEBUG                Set to "true" to enable debug output (same as --debug)
  AGHAST_LOG_LEVEL            Console log level (CLI --log-level takes precedence)
  AGHAST_LOG_FILE             Log file path (CLI --log-file takes precedence)
  AGHAST_LOG_TYPE             Log file handler type (CLI --log-type takes precedence)
  AGHAST_MOCK_SARIF           Use a SARIF file instead of running Semgrep or Opengrep
                              (test/development use only)
  AGHAST_OPENANT_DATASET      Use a pre-generated OpenAnt dataset JSON file
  AGHAST_DIFF_REF             Git ref to diff against (CLI --diff-ref takes precedence)
  NO_COLOR                    Set to "1" to disable colored output
  GITHUB_REPOSITORY           Default for --repo (auto-set in GitHub Actions)
  GITHUB_BASE_SHA             Default for --base-sha
  GITHUB_HEAD_SHA             Default for --head-sha
  GITHUB_SHA                  Fallback for --head-sha (auto-set in GitHub Actions)
  GH_TOKEN / GITHUB_TOKEN     Auth for the gh CLI when posting PR comments
  AGHAST_JUDGE_MODEL          Judge model (presence enables the stage; CLI --judge-model takes precedence)
  AGHAST_JUDGE_PROVIDER       Judge provider (CLI --judge-provider takes precedence)
  AGHAST_RETRY_MAX_ATTEMPTS   Retry attempts per AI call; >1 enables retry
                              (CLI --retry-max-attempts takes precedence)
  AGHAST_MOCK_JUDGE           Enables mock judge provider. Set to "true" for default
                              {"verdict":"true_positive","confidence":1.0,"rationale":"mock"},
                              or set to a file path for a custom fixture

Examples:
  aghast scan ./my-repo --config-dir ./my-checks
  aghast scan ./my-repo --config-dir ./my-checks --output results.sarif --output-format sarif
  aghast scan ./my-repo --config-dir ./my-checks --fail-on-check-failure --debug
  aghast scan ./my-repo --config-dir ./my-checks --log-file scan.log --log-level warn
  aghast scan ./my-repo --config-dir ./my-checks --model claude-sonnet-4-20250514

${docsFooter('scanning.md')}`;

function parseArgs(args: string[]): {
  repositoryPath?: string;
  configDir?: string;
  outputFormat?: string;
  outputPath?: string;
  failOnCheckFailure: boolean;
  debug: boolean;
  logLevel?: string;
  logFile?: string;
  logType?: string;
  runtimeConfigPath?: string;
  model?: string;
  agentProvider?: string;
  genericPrompt?: string;
  diffRef?: string;
  diffFile?: string;
  budgetLimitCost?: number;
  budgetLimitTokens?: number;
  prNumber?: number;
  prRepo?: string;
  baseSha?: string;
  headSha?: string;
  judgeModel?: string;
  judgeProvider?: string;
  judgeConcurrency?: number;
  judgeDropFalsePositives?: boolean;
  judgeMinConfidence?: number;
  retryMaxAttempts?: number;
} {
  if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
    console.log(SCAN_HELP);
    process.exit(0);
  }

  // First positional arg is repo-path
  const firstArg = args[0];
  const repositoryPath = firstArg && !firstArg.startsWith('--') ? resolve(firstArg) : undefined;
  const startIdx = repositoryPath ? 1 : 0;

  let configDir: string | undefined;
  let outputFormat: string | undefined;
  let outputPath: string | undefined;
  const failOnCheckFailure = args.includes('--fail-on-check-failure');
  const debug = args.includes('--debug');
  let logLevel: string | undefined;
  let logFile: string | undefined;
  let logType: string | undefined;
  let runtimeConfigPath: string | undefined;
  let model: string | undefined;
  let agentProvider: string | undefined;
  let genericPrompt: string | undefined;
  let diffRef: string | undefined;
  let diffFile: string | undefined;
  let budgetLimitCost: number | undefined;
  let budgetLimitTokens: number | undefined;
  let prNumber: number | undefined;
  let prRepo: string | undefined;
  let baseSha: string | undefined;
  let headSha: string | undefined;
  let judgeModel: string | undefined;
  let judgeProvider: string | undefined;
  let judgeConcurrency: number | undefined;
  const judgeDropFalsePositives = args.includes('--judge-drop-false-positives');
  let judgeMinConfidence: number | undefined;
  let retryMaxAttempts: number | undefined;

  for (let i = startIdx; i < args.length; i++) {
    switch (args[i]) {
      case '--config-dir': {
        configDir = args[i + 1];
        if (!configDir) {
          console.error(formatError(ERROR_CODES.E1001, '--config-dir requires a path argument'));
          process.exit(1);
        }
        configDir = resolve(configDir);
        i++;
        break;
      }
      case '--output': {
        outputPath = args[i + 1];
        if (!outputPath) {
          console.error(formatError(ERROR_CODES.E1001, '--output requires a path argument'));
          process.exit(1);
        }
        outputPath = resolve(outputPath);
        i++;
        break;
      }
      case '--output-format': {
        outputFormat = args[i + 1];
        if (!outputFormat) {
          console.error(formatError(ERROR_CODES.E1001, '--output-format requires a format argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--runtime-config': {
        runtimeConfigPath = args[i + 1];
        if (!runtimeConfigPath) {
          console.error(formatError(ERROR_CODES.E1001, '--runtime-config requires a path argument'));
          process.exit(1);
        }
        runtimeConfigPath = resolve(runtimeConfigPath);
        i++;
        break;
      }
      case '--model': {
        model = args[i + 1];
        if (!model) {
          console.error(formatError(ERROR_CODES.E1001, '--model requires a model name argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--agent-provider': {
        agentProvider = args[i + 1];
        if (!agentProvider) {
          console.error(formatError(ERROR_CODES.E1001, '--agent-provider requires a provider name argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--generic-prompt': {
        genericPrompt = args[i + 1];
        if (!genericPrompt) {
          console.error(formatError(ERROR_CODES.E1001, '--generic-prompt requires a filename argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--log-level': {
        logLevel = args[i + 1];
        if (!logLevel) {
          console.error(formatError(ERROR_CODES.E1001, '--log-level requires a level argument (error, warn, info, debug, trace)'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--log-file': {
        logFile = args[i + 1];
        if (!logFile) {
          console.error(formatError(ERROR_CODES.E1001, '--log-file requires a path argument'));
          process.exit(1);
        }
        logFile = resolve(logFile);
        i++;
        break;
      }
      case '--log-type': {
        logType = args[i + 1];
        if (!logType) {
          console.error(formatError(ERROR_CODES.E1001, '--log-type requires a type argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--diff-ref': {
        diffRef = args[i + 1];
        if (!diffRef) {
          console.error(formatError(ERROR_CODES.E1001, '--diff-ref requires a git ref argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--diff-file': {
        diffFile = args[i + 1];
        if (!diffFile) {
          console.error(formatError(ERROR_CODES.E1001, '--diff-file requires a path argument'));
          process.exit(1);
        }
        diffFile = resolve(diffFile);
        i++;
        break;
      }
      case '--budget-limit-cost': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--budget-limit-cost requires a number argument (USD)'));
          process.exit(1);
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(formatError(ERROR_CODES.E1001, `--budget-limit-cost must be a positive number (got "${raw}")`));
          process.exit(1);
        }
        budgetLimitCost = n;
        i++;
        break;
      }
      case '--budget-limit-tokens': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--budget-limit-tokens requires a number argument'));
          process.exit(1);
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          console.error(formatError(ERROR_CODES.E1001, `--budget-limit-tokens must be a positive integer (got "${raw}")`));
          process.exit(1);
        }
        budgetLimitTokens = n;
        i++;
        break;
      }
      case '--pr': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--pr requires a pull request number'));
          process.exit(1);
        }
        const parsedNum = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsedNum) || parsedNum <= 0) {
          console.error(formatError(ERROR_CODES.E1001, `--pr requires a positive integer (got "${raw}")`));
          process.exit(1);
        }
        prNumber = parsedNum;
        i++;
        break;
      }
      case '--repo': {
        prRepo = args[i + 1];
        if (!prRepo) {
          console.error(formatError(ERROR_CODES.E1001, '--repo requires an owner/repo argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--base-sha': {
        baseSha = args[i + 1];
        if (!baseSha) {
          console.error(formatError(ERROR_CODES.E1001, '--base-sha requires a SHA argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--head-sha': {
        headSha = args[i + 1];
        if (!headSha) {
          console.error(formatError(ERROR_CODES.E1001, '--head-sha requires a SHA argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--judge-model': {
        judgeModel = args[i + 1];
        if (!judgeModel) {
          console.error(formatError(ERROR_CODES.E1001, '--judge-model requires a model name argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--judge-provider': {
        judgeProvider = args[i + 1];
        if (!judgeProvider) {
          console.error(formatError(ERROR_CODES.E1001, '--judge-provider requires a provider name argument'));
          process.exit(1);
        }
        i++;
        break;
      }
      case '--judge-concurrency': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--judge-concurrency requires a number argument'));
          process.exit(1);
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          console.error(formatError(ERROR_CODES.E1001, `--judge-concurrency must be a positive integer (got "${raw}")`));
          process.exit(1);
        }
        judgeConcurrency = n;
        i++;
        break;
      }
      case '--judge-min-confidence': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--judge-min-confidence requires a number argument (0.0–1.0)'));
          process.exit(1);
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          console.error(formatError(ERROR_CODES.E1001, `--judge-min-confidence must be between 0 and 1 (got "${raw}")`));
          process.exit(1);
        }
        judgeMinConfidence = n;
        i++;
        break;
      }
      case '--retry-max-attempts': {
        const raw = args[i + 1];
        if (!raw) {
          console.error(formatError(ERROR_CODES.E1001, '--retry-max-attempts requires a number argument'));
          process.exit(1);
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          console.error(formatError(ERROR_CODES.E1001, `--retry-max-attempts must be an integer >= 1 (got "${raw}")`));
          process.exit(1);
        }
        retryMaxAttempts = n;
        i++;
        break;
      }
      // Boolean flags: their values are read via args.includes() above, but each
      // still needs a case here — without one it reaches `default` and is
      // rejected as an unknown option.
      case '--fail-on-check-failure':
      case '--debug':
      case '--judge-drop-false-positives':
        break;
      default: {
        const arg = args[i];
        if (arg?.startsWith('--')) {
          const suggestion = arg === '--provider' ? ' Did you mean --agent-provider?' : '';
          console.error(formatError(ERROR_CODES.E1002, `Unknown option: ${arg}.${suggestion}`));
          process.exit(1);
        }
      }
    }
  }

  return {
    repositoryPath, configDir, outputPath, outputFormat,
    failOnCheckFailure, debug, logLevel, logFile, logType,
    runtimeConfigPath, model, agentProvider, genericPrompt,
    diffRef, diffFile,
    budgetLimitCost, budgetLimitTokens,
    prNumber, prRepo, baseSha, headSha,
    judgeModel, judgeProvider, judgeConcurrency,
    judgeDropFalsePositives: judgeDropFalsePositives || undefined,
    judgeMinConfidence,
    retryMaxAttempts,
  };
}

/**
 * Parse "owner/repo" into its parts. Returns undefined when the input is
 * missing or malformed so callers can produce a CLI-friendly error.
 *
 * Validates each half against `^[A-Za-z0-9_.-]+$` — the character set GitHub
 * actually permits in owner/repo names. This rejects whitespace and shell
 * metacharacters defensively, even though the parsed value is only ever
 * interpolated into a `gh api` URL path (no shell).
 */
const REPO_SLUG_PART = /^[A-Za-z0-9_.-]+$/;
export function parseRepoSlug(slug: string | undefined): { owner: string; repo: string } | undefined {
  if (!slug) return undefined;
  const parts = slug.split('/');
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!owner || !repo) return undefined;
  if (!REPO_SLUG_PART.test(owner) || !REPO_SLUG_PART.test(repo)) return undefined;
  return { owner, repo };
}

async function createProvider(
  useMock: boolean,
  agentProviderName: string,
  modelOverride?: string,
): Promise<{ provider: AgentProvider; modelName: string }> {
  if (useMock) {
    logProgress(TAG, `Mock provider enabled via AGHAST_MOCK_AI=${process.env.AGHAST_MOCK_AI}`);
    const provider = await createMockProvider();
    // Honour --model in mock mode so cost-calculation tests can target a known
    // pricing entry. Defaults to MOCK_MODEL_NAME.
    const effectiveModel = modelOverride ?? MOCK_MODEL_NAME;
    provider.setModel?.(effectiveModel);
    return { provider, modelName: effectiveModel };
  }

  const provider = createProviderByName(agentProviderName);
  await provider.initialize({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: modelOverride,
  });
  const modelName = provider.getModelName?.() ?? DEFAULT_MODEL;
  return { provider, modelName };
}

/**
 * Validate that the config directory has the required structure.
 * Returns early with a clear error message if anything is missing.
 */
async function validateConfigDir(configDir: string): Promise<void> {
  // Check checks-config.json exists
  const registryPath = resolve(configDir, 'checks-config.json');
  try {
    await stat(registryPath);
  } catch {
    console.error(formatError(ERROR_CODES.E2002, `Config directory is missing checks-config.json: ${registryPath}`));
    console.error(`  Use 'aghast new-check --config-dir ${configDir}' to bootstrap a config directory.`);
    process.exit(1);
  }

  // Check checks/ directory exists
  const checksPath = resolve(configDir, 'checks');
  try {
    const checksStat = await stat(checksPath);
    if (!checksStat.isDirectory()) {
      console.error(formatError(ERROR_CODES.E2002, `${checksPath} exists but is not a directory`));
      process.exit(1);
    }
  } catch {
    console.error(formatError(ERROR_CODES.E2002, `Config directory is missing checks/ folder: ${checksPath}`));
    console.error(`  Use 'aghast new-check --config-dir ${configDir}' to add checks.`);
    process.exit(1);
  }

  // Check that checks/ has at least one subfolder
  const entries = await readdir(checksPath);
  if (entries.length === 0) {
    console.error(formatError(ERROR_CODES.E2003, `No checks found in ${checksPath}`));
    console.error(`  Use 'aghast new-check --config-dir ${configDir}' to add checks.`);
    process.exit(1);
  }
}

export async function runScan(args: string[]): Promise<void> {
  const globalTimer = createTimer();
  const parsed = parseArgs(args);

  // Reset the per-process repo-snapshot cache so back-to-back programmatic
  // invocations of `runScan` don't reuse a stale filesystem snapshot from a
  // previous run (e.g. when callers edit the target repo between scans).
  //
  // Caveat: the cache is module-scoped, so two `runScan` invocations running
  // *concurrently* in the same Node process will clobber each other's cached
  // snapshots — each scan still works correctly, it just won't share the
  // filesystem walk across invocations. Sequential invocations are the
  // primary supported pattern.
  clearRepoSnapshotCache();

  // --config-dir is required (CLI flag > AGHAST_CONFIG_DIR env var)
  const rawConfigDir = parsed.configDir || process.env.AGHAST_CONFIG_DIR;
  if (!rawConfigDir) {
    console.error(formatError(ERROR_CODES.E2001, "--config-dir is required (or set AGHAST_CONFIG_DIR). Use 'aghast new-check --config-dir <path>' to create a config directory."));
    process.exit(1);
  }
  const configDir = resolve(rawConfigDir);

  // Validate config directory structure
  await validateConfigDir(configDir);

  // Load runtime configuration
  let runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  try {
    runtimeConfig = await loadRuntimeConfig(configDir, parsed.runtimeConfigPath);
  } catch (err: unknown) {
    console.error(formatError(ERROR_CODES.E2005, err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // Resolve log level: --log-level > AGHAST_LOG_LEVEL > runtime config > --debug/AGHAST_DEBUG > default
  const debug = parsed.debug || process.env.AGHAST_DEBUG === 'true';
  const resolvedLogLevel = parsed.logLevel ?? (process.env.AGHAST_LOG_LEVEL || undefined) ?? runtimeConfig.logging?.level ?? (debug ? 'debug' : DEFAULT_LOG_LEVEL);
  if (resolvedLogLevel !== 'silent' && !isValidLogLevel(resolvedLogLevel)) {
    console.error(formatError(ERROR_CODES.E1001, `Invalid log level "${resolvedLogLevel}". Valid levels: error, warn, info, debug, trace`));
    process.exit(1);
  }
  setLogLevel(resolvedLogLevel as LogLevel | 'silent');

  // Resolve log file: --log-file > AGHAST_LOG_FILE > runtime config
  const resolvedLogFile = parsed.logFile ?? (process.env.AGHAST_LOG_FILE || undefined) ?? (runtimeConfig.logging?.logFile ? resolve(runtimeConfig.logging.logFile) : undefined);
  if (resolvedLogFile) {
    const resolvedLogType = parsed.logType ?? (process.env.AGHAST_LOG_TYPE || undefined) ?? runtimeConfig.logging?.logType ?? DEFAULT_LOG_TYPE;
    const availableTypes = getAvailableLogTypes();
    if (!availableTypes.includes(resolvedLogType)) {
      console.error(formatError(ERROR_CODES.E1001, `Unknown log type "${resolvedLogType}". Available types: ${availableTypes.join(', ')}`));
      process.exit(1);
    }
    initFileHandler(resolve(resolvedLogFile), resolvedLogType);
  }

  // Resolve repository path — required
  if (!parsed.repositoryPath) {
    console.error(formatError(ERROR_CODES.E1003, '<repo-path> is required'));
    process.exit(1);
  }

  // Validate repository path exists and is a directory
  try {
    const repoStat = await stat(parsed.repositoryPath);
    if (!repoStat.isDirectory()) {
      console.error(formatError(ERROR_CODES.E4001, `Repository path is not a directory: ${parsed.repositoryPath}`));
      process.exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(formatError(ERROR_CODES.E4001, `Repository path does not exist: ${parsed.repositoryPath}`));
      process.exit(1);
    }
    throw err;
  }

  // Resolve output format: CLI > runtime config > default
  const resolvedOutputFormat = parsed.outputFormat ?? runtimeConfig.reporting?.outputFormat ?? DEFAULT_OUTPUT_FORMAT;

  // Resolve formatter early — fail fast on unknown format
  const formatter = getFormatter(resolvedOutputFormat);

  // Treat AGHAST_MOCK_AI=false (or empty) as disabled; any other truthy value enables mock mode
  const mockAiEnv = process.env.AGHAST_MOCK_AI;
  const useMock = !!(mockAiEnv && mockAiEnv !== 'false');

  // ─── Load and filter checks BEFORE AI validation ───

  // Checks always live in <config-dir>/checks/
  const checksDirs = [resolve(configDir, 'checks')];

  // Resolve generic prompt: CLI > env > runtime config > default (handled in buildPrompt)
  const genericPrompt = parsed.genericPrompt ?? process.env.AGHAST_GENERIC_PROMPT ?? runtimeConfig.genericPrompt;

  logDebug(TAG, `Config dir: ${configDir}, checks dir: ${checksDirs[0]}`);

  // Two-layer config loading
  const registry = await loadCheckRegistry(configDir);
  const checkFolders = await discoverCheckFolders(checksDirs);

  if (checkFolders.size === 0) {
    console.error(formatError(ERROR_CODES.E2003, `No valid checks found in ${checksDirs[0]}. Each check needs a <id>/<id>.json file.`));
    process.exit(1);
  }

  const allChecks = await resolveChecks(registry, checkFolders);

  // Analyze repository to get remote URL for check filtering
  const effectiveRepoPath = parsed.repositoryPath;
  const repoAnalysis = await analyzeRepository(effectiveRepoPath);
  const repoUrl = repoAnalysis?.repository.remoteUrl ?? effectiveRepoPath;

  const filtered = await filterChecksForRepositoryAsync(allChecks, repoUrl, effectiveRepoPath);
  // Run lower-priority checks first; checks without a priority sort to the end.
  const matchingChecks = sortChecksByPriority(filtered);
  logProgress(TAG, `Found ${matchingChecks.length} matching checks (of ${allChecks.length} total)`);

  if (matchingChecks.length === 0) {
    logProgress(TAG, 'No matching checks found for this repository');
  }

  // Validate and load check details
  const checksWithDetails: Array<{ check: typeof matchingChecks[0]; details: Awaited<ReturnType<typeof loadCheckDetails>> }> = [];
  for (const check of matchingChecks) {
    // instructionsFile is already absolute from resolveChecks — validate against ''
    const validation = await validateCheck(check, '');
    if (!validation.valid) {
      const emptyInstructionsError = validation.errors.find((error) =>
        error.includes('Instructions file') && error.includes('is empty')
      );
      if (emptyInstructionsError) {
        console.error(formatError(
          ERROR_CODES.E2004,
          `Invalid check "${check.id}": ${emptyInstructionsError}`,
        ));
        process.exit(1);
      }
      logProgress(TAG, `Skipping invalid check "${check.id}": ${validation.errors.join(', ')}`);
      continue;
    }

    // checkTarget rules already resolved by resolveChecks — no additional path resolution needed

    // Checks that don't require instructions use synthetic details (unless they provided one optionally).
    // Built-in analysis modes (false-positive-validation, general-vuln-discovery) also don't need instructions.
    const builtInMode = check.checkTarget?.analysisMode === 'false-positive-validation'
      || check.checkTarget?.analysisMode === 'general-vuln-discovery';
    if ((!getCheckType(check.checkTarget?.type).needsInstructions || builtInMode) && !check.instructionsFile) {
      checksWithDetails.push({
        check,
        details: { id: check.id, name: check.name, overview: '', content: '' },
      });
      continue;
    }

    const details = await loadCheckDetails(check, '');
    // Fall back to JSON definition name if markdown has no ### heading
    if (details.name === 'Unknown Check') {
      details.name = check.name;
    }
    checksWithDetails.push({ check, details });
  }

  // ─── Validate --generic-prompt with mixed discovery types ───
  if (genericPrompt) {
    const discoveryTypes = new Set<string>();
    for (const c of checksWithDetails) {
      const d = c.check.checkTarget?.discovery;
      if (d) discoveryTypes.add(d);
    }
    if (discoveryTypes.size > 1) {
      console.error(formatError(
        ERROR_CODES.E2004,
        `--generic-prompt cannot be used when checks have different discovery types (found: ${[...discoveryTypes].join(', ')}). Each discovery type uses its own default generic prompt.`,
      ));
      process.exit(1);
    }
  }

  // ─── Determine which prerequisites are needed ───
  const needsAI = checksWithDetails.some(c => getCheckType(c.check.checkTarget?.type).needsAI);
  const needsSemgrep = checksWithDetails.some(c => c.check.checkTarget?.discovery === 'semgrep');
  const needsOpengrep = checksWithDetails.some(c => c.check.checkTarget?.discovery === 'opengrep');
  const needsOpenant = checksWithDetails.some(c => c.check.checkTarget?.discovery === 'openant');

  // ─── Resolve diff source ───
  // Precedence: CLI --diff-ref/--diff-file > AGHAST_DIFF_REF > runtime config diffRef.
  // (Check-level diffRef is applied per-check inside the scan runner.)
  const resolvedDiffRef = parsed.diffRef ?? (process.env.AGHAST_DIFF_REF || undefined) ?? runtimeConfig.diffRef;
  const resolvedDiffFile = parsed.diffFile;

  // OpenAnt is needed for diff filtering. Required whenever a diff source is
  // available and at least one check has a discovery that supports the filter
  // and hasn't opted out.
  const hasRuntimeDiffSource = resolvedDiffRef !== undefined || resolvedDiffFile !== undefined;
  const hasAnyCheckLevelDiffRef = checksWithDetails.some(c => c.check.checkTarget?.diffRef !== undefined);
  const diffSourceAvailable = hasRuntimeDiffSource || hasAnyCheckLevelDiffRef;
  // Drive supportedDiscovery off the registry rather than a hardcoded list —
  // new discoveries pick up their own behaviour via supportsDiffFilter without
  // this gate having to be kept in sync.
  const registeredDiscoveries = new Set(getRegisteredDiscoveries());
  const needsDiffFilter = diffSourceAvailable && checksWithDetails.some(c => {
    const ct = c.check.checkTarget;
    if (!ct?.discovery || !registeredDiscoveries.has(ct.discovery)) return false;
    const supportedDiscovery = getDiscovery(ct.discovery).supportsDiffFilter;
    const optedIn = ct.diffFilter !== false;
    const hasSource = hasRuntimeDiffSource || ct.diffRef !== undefined;
    return supportedDiscovery && optedIn && hasSource;
  });

  // ─── Conditional agent provider setup ───
  const agentProviderName = parsed.agentProvider ?? runtimeConfig.agentProvider?.name ?? DEFAULT_PROVIDER_NAME;

  if (needsAI && !useMock) {
    // Validate agent provider name before checking credentials (config errors before auth errors)
    if (!getProviderNames().includes(agentProviderName)) {
      console.error(
        formatError(ERROR_CODES.E3002, `Unknown agent provider "${agentProviderName}". Supported providers: ${getProviderNames().join(', ')}`),
      );
      process.exit(1);
    }

    // Validate provider-specific prerequisites (API keys, binaries, etc.)
    try {
      const tempProvider = createProviderByName(agentProviderName);
      await tempProvider.checkPrerequisites?.();
    } catch (err) {
      console.error(formatError(ERROR_CODES.E3001, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  // Resolve model precedence: CLI --model > env AGHAST_AI_MODEL > runtime config > default
  const modelOverride = parsed.model ?? process.env.AGHAST_AI_MODEL ?? runtimeConfig.agentProvider?.model;

  let provider: AgentProvider | undefined;
  let modelName: string | undefined;
  if (needsAI) {
    ({ provider, modelName } = await createProvider(useMock, agentProviderName, modelOverride));

    logProgress(TAG, `Using model: ${modelName}`);
  }

  // ─── Conditional Semgrep verification ───
  // The mock-env check (AGHAST_MOCK_SARIF) is handled inside
  // verifySarifScannerInstalled; no need to duplicate it here.
  if (needsSemgrep) {
    try {
      await verifySemgrepInstalled();
    } catch (err) {
      console.error(formatError(ERROR_CODES.E5001, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  // ─── Conditional Opengrep verification ───
  if (needsOpengrep) {
    try {
      await verifyOpengrepInstalled();
    } catch (err) {
      console.error(formatError(ERROR_CODES.E5101, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  // ─── Conditional OpenAnt verification ───
  // `openant` discovery is a hard requirement: without OpenAnt there are no
  // targets. Diff filtering on other discoveries is a soft requirement: if
  // OpenAnt is missing we fall back to a depth-0 filter (file+line overlap
  // only, no call-graph flow) and log a clear warning so the mode is visible.
  let openantAvailable = true;
  if (needsOpenant && !process.env.AGHAST_OPENANT_DATASET) {
    try {
      await verifyOpenAntInstalled();
    } catch (err) {
      console.error(formatError(ERROR_CODES.E6001, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  } else if (needsDiffFilter && !process.env.AGHAST_OPENANT_DATASET) {
    try {
      await verifyOpenAntInstalled();
    } catch {
      openantAvailable = false;
      logProgress(
        TAG,
        'OpenAnt is not installed — diff filter will run in depth-0 mode ' +
          '(findings kept only if their file and line range appear in the diff; ' +
          'direct callers/callees of changed code are NOT included). ' +
          'Install OpenAnt (https://github.com/knostic/OpenAnt/) or set ' +
          'AGHAST_OPENANT_DATASET to a prebuilt dataset for depth-1 filtering with call-graph flow.',
      );
    }
  }

  // ─── Pricing + budget setup ───
  const defaultPricing = await loadDefaultPricing();
  const pricing = mergePricing(defaultPricing, runtimeConfig.pricing);

  const budgetLimits: BudgetLimits | undefined = (() => {
    const cliCost = parsed.budgetLimitCost;
    const cliTokens = parsed.budgetLimitTokens;
    const cfg = runtimeConfig.budget;
    if (cliCost === undefined && cliTokens === undefined && !cfg) return undefined;
    const out: BudgetLimits = {};
    const perScan: BudgetLimits['perScan'] = { ...(cfg?.perScan ?? {}) };
    if (cliCost !== undefined) perScan.maxCostUsd = cliCost;
    if (cliTokens !== undefined) perScan.maxTokens = cliTokens;
    if (perScan.maxCostUsd !== undefined || perScan.maxTokens !== undefined) {
      out.perScan = perScan;
    }
    if (cfg?.perPeriod && cfg.perPeriod.window && cfg.perPeriod.maxCostUsd !== undefined) {
      out.perPeriod = { window: cfg.perPeriod.window, maxCostUsd: cfg.perPeriod.maxCostUsd };
    }
    if (cfg?.thresholds) out.thresholds = cfg.thresholds;
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  // Pre-load history for period budget checks (skip when no period limit set)
  let scanHistoryForBudget: ScanRecord[] | undefined;
  if (budgetLimits?.perPeriod) {
    try {
      scanHistoryForBudget = await queryScanHistory();
    } catch (err) {
      logDebug(TAG, `Could not load scan history for budget check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Judge stage setup ───
  // Stage is enabled iff a judge model is resolvable from any config source.
  // Provider defaults to the scan provider if not explicitly set (decision #8).
  const resolvedJudgeModel = parsed.judgeModel ?? process.env.AGHAST_JUDGE_MODEL ?? runtimeConfig.judge?.model;
  const resolvedJudgeProvider = parsed.judgeProvider ?? process.env.AGHAST_JUDGE_PROVIDER ?? runtimeConfig.judge?.provider;
  const resolvedJudgeConcurrency = parsed.judgeConcurrency ?? runtimeConfig.judge?.concurrency;
  const resolvedJudgeDropFP = parsed.judgeDropFalsePositives ?? runtimeConfig.judge?.dropFalsePositives;
  const resolvedJudgeMinConf = parsed.judgeMinConfidence ?? runtimeConfig.judge?.minConfidence;

  const mockJudgeEnv = process.env.AGHAST_MOCK_JUDGE;
  const useMockJudge = !!(mockJudgeEnv && mockJudgeEnv !== 'false');

  let judgeOptions: JudgeOptions | undefined;
  if (resolvedJudgeModel) {
    const judgeProviderName = resolvedJudgeProvider ?? agentProviderName;
    let judgeProvider: import('./types.js').AgentProvider;
    if (useMockJudge) {
      logProgress(TAG, `Mock judge provider enabled via AGHAST_MOCK_JUDGE=${mockJudgeEnv}`);
      judgeProvider = await createMockJudgeProvider(resolvedJudgeModel);
    } else if (useMock) {
      // If scan uses mock, use mock for judge too (tests that set AGHAST_MOCK_AI but not AGHAST_MOCK_JUDGE)
      logWarn(TAG, 'AGHAST_MOCK_AI is set; judge provider will also use mock (set AGHAST_MOCK_JUDGE to control judge response)');
      judgeProvider = await createMockJudgeProvider(resolvedJudgeModel);
    } else {
      const jp = createProviderByName(judgeProviderName);
      await jp.initialize({ apiKey: process.env.ANTHROPIC_API_KEY, model: resolvedJudgeModel });
      judgeProvider = jp;
    }
    judgeOptions = {
      provider: judgeProvider,
      providerName: useMockJudge || useMock ? 'mock' : judgeProviderName,
      model: resolvedJudgeModel,
      concurrency: resolvedJudgeConcurrency,
      dropFalsePositives: resolvedJudgeDropFP,
      minConfidence: resolvedJudgeMinConf,
    };
    logProgress(TAG, `Judge stage enabled: model=${resolvedJudgeModel}, provider=${judgeOptions.providerName}`);
  }

  // Retry is opt-in. Precedence matches every other setting:
  // CLI --retry-max-attempts > AGHAST_RETRY_MAX_ATTEMPTS > runtime config.
  // When none is supplied this stays undefined and the scan runner's default
  // (one attempt, no backoff, no circuit breaker) applies.
  let resolvedRetry = runtimeConfig.retry;
  const envRetryAttempts = process.env.AGHAST_RETRY_MAX_ATTEMPTS;
  let retryAttemptsOverride: number | undefined = parsed.retryMaxAttempts;
  if (retryAttemptsOverride === undefined && envRetryAttempts !== undefined) {
    const n = Number(envRetryAttempts);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      console.error(
        formatError(
          ERROR_CODES.E1001,
          `AGHAST_RETRY_MAX_ATTEMPTS must be an integer >= 1 (got "${envRetryAttempts}")`,
        ),
      );
      process.exit(1);
    }
    retryAttemptsOverride = n;
  }
  if (retryAttemptsOverride !== undefined) {
    resolvedRetry = { ...resolvedRetry, maxAttempts: retryAttemptsOverride };
  }
  if (resolvedRetry?.maxAttempts !== undefined && resolvedRetry.maxAttempts > 1) {
    logProgress(TAG, `Retry enabled: up to ${resolvedRetry.maxAttempts} attempts per AI call`);
  }

  try {
    const scanOptions: MultiScanOptions = {
      repositoryPath: effectiveRepoPath,
      checks: checksWithDetails,
      agentProvider: provider,
      modelName: needsAI ? modelName : undefined,
      repositoryInfo: repoAnalysis?.repository,
      agentProviderName: needsAI ? (useMock ? 'mock' : agentProviderName) : undefined,
      configDir,
      genericPrompt,
      diffRef: resolvedDiffRef,
      diffFile: resolvedDiffFile,
      openantAvailable,
      pricing,
      budgetLimits,
      scanHistory: scanHistoryForBudget,
      // Prefer the provider's resolved auth mode (covers auto-detected local login);
      // fall back to the env var for providers without the concept (e.g. mock).
      isLocalClaude: provider?.isLocalMode?.() ?? (process.env.AGHAST_LOCAL_CLAUDE === 'true'),
      judge: judgeOptions,
      // Undefined when absent, which leaves the scan runner on its defaults —
      // and the default is retry OFF, so a scan with no retry configuration
      // anywhere fails fast exactly as it did before retry existed.
      retry: resolvedRetry,
    };
    const outcome = await runMultiScanWithCost(scanOptions);
    const results = outcome.results;

    // Resolve output path: --output flag > runtime config dir > default
    let resolvedOutputPath: string;
    if (parsed.outputPath) {
      resolvedOutputPath = parsed.outputPath;
    } else if (runtimeConfig.reporting?.outputDirectory) {
      const dir = resolve(runtimeConfig.reporting.outputDirectory);
      resolvedOutputPath = resolve(dir, 'security_checks_results' + formatter.fileExtension);
    } else {
      resolvedOutputPath = resolve(effectiveRepoPath, 'security_checks_results' + formatter.fileExtension);
    }
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, formatter.format(results), 'utf-8');

    // Optional: write one file per issue alongside the main report (Spec E.3.2).
    let individualIssueDir: string | undefined;
    let individualIssueCount = 0;
    if (runtimeConfig.reporting?.includeIndividualIssueFiles && results.issues.length > 0) {
      const issueFormat: IndividualIssueFormat = runtimeConfig.reporting.individualIssueFormat ?? 'markdown';
      const issueOutputDir = dirname(resolvedOutputPath);
      const written = await writeIndividualIssueFiles(results, issueOutputDir, issueFormat);
      individualIssueDir = written.rootDir;
      individualIssueCount = written.files.length;
      logProgress(TAG, `Wrote ${individualIssueCount} individual issue file(s) to ${individualIssueDir}`);
    }

    // Summary output
    const statusIcon =
      results.summary.failedChecks > 0
        ? 'ISSUES DETECTED'
        : results.summary.flaggedChecks > 0
          ? 'REVIEW REQUIRED'
          : results.summary.errorChecks > 0
            ? 'SCAN ERROR'
            : 'NO ISSUES DETECTED';

    console.log('');
    console.log('='.repeat(60));
    console.log(`AGHAST Scan Complete: ${colorStatus(statusIcon)}`);
    console.log('='.repeat(60));
    console.log(`  Total checks:  ${results.summary.totalChecks}`);
    console.log(`  Passed:        ${results.summary.passedChecks}`);
    console.log(`  Failed:        ${results.summary.failedChecks}`);
    console.log(`  Flagged:       ${results.summary.flaggedChecks}`);
    console.log(`  Errors:        ${results.summary.errorChecks}`);
    console.log(`  Total issues:  ${results.summary.totalIssues}`);
    if (results.tokenUsage) {
      const tu = results.tokenUsage;
      const cacheSegments = [
        tu.cacheReadInputTokens !== undefined ? ` cache-read: ${tu.cacheReadInputTokens.toLocaleString()}` : '',
        tu.cacheCreationInputTokens !== undefined ? ` cache-write: ${tu.cacheCreationInputTokens.toLocaleString()}` : '',
        tu.reasoningTokens !== undefined ? ` reasoning: ${tu.reasoningTokens.toLocaleString()}` : '',
      ].filter(Boolean).join(',');
      const tokenDetail = `(in: ${tu.inputTokens.toLocaleString()}, out: ${tu.outputTokens.toLocaleString()}${cacheSegments ? ',' + cacheSegments : ''})`;
      console.log(`  Tokens:        ${tu.totalTokens.toLocaleString()} ${tokenDetail}`);
    }
    if (outcome.totalCostUsd > 0 || outcome.costSource === 'estimated-unpriced') {
      const label = formatCostSourceLabel(outcome.costSource, outcome.costReportedBy, outcome.costCoveredBySubscription);
      const equiv = outcome.costCoveredBySubscription ? ' equivalent' : '';
      console.log(`  Cost:          $${outcome.totalCostUsd.toFixed(4)}${equiv}  ${label}`);
    }
    if (outcome.judgeSummary) {
      const js = outcome.judgeSummary;
      const truePos = js.judgedIssues - js.falsePositives - js.uncertainJudgements;
      console.log(`  Judged:        ${js.judgedIssues} issues: ${truePos} true / ${js.falsePositives} false / ${js.uncertainJudgements} uncertain (judge: ${outcome.judgeModel})`);
    }
    console.log(`  Duration:      ${globalTimer.elapsedStr()}`);
    console.log(`  Results:       ${resolvedOutputPath}`);
    if (individualIssueDir) {
      console.log(`  Issue files:   ${individualIssueCount} in ${individualIssueDir}`);
    }
    console.log('='.repeat(60));

    // Persist the scan record to history (best-effort — never blocks exit).
    // We DO save the record even when the scan was aborted by budget: per-period
    // budgets aggregate over historical scans, so the partial cost incurred
    // before the abort must be recorded — otherwise a user could repeatedly
    // hit the budget abort and still consume more total spend than the period
    // limit allows.
    try {
      const record: ScanRecord = {
        scanId: results.scanId,
        startedAt: results.startTime,
        endedAt: results.endTime,
        durationMs: results.executionTime,
        repository: effectiveRepoPath,
        repositoryUrl: repoAnalysis?.repository.remoteUrl,
        models: outcome.models.length > 0 ? outcome.models : (modelName ? [modelName] : []),
        tokenUsage: results.tokenUsage,
        totalCost: outcome.totalCostUsd,
        currency: outcome.currency,
        costSource: outcome.costSource,
        costReportedBy: outcome.costReportedBy,
        costCoveredBySubscription: outcome.costCoveredBySubscription,
        checks: results.summary.totalChecks,
        issues: results.summary.totalIssues,
      };
      await saveScanRecord(record);
    } catch (err) {
      logDebug(TAG, `Failed to save scan history: ${err instanceof Error ? err.message : String(err)}`);
    }

    // A budget abort is a deliberate failure mode the user opted into via
    // --budget-limit-* / runtime config — it must always exit non-zero (and
    // surface E7001 to stderr) regardless of --fail-on-check-failure. Doing
    // otherwise would silently drop the abort signal in CI pipelines that
    // rely on the exit code as a guardrail.
    //
    // Emit through both stderr (for terminal users / CI logs) AND the logging
    // system (so --log-file captures the abort reason — console.error bypasses
    // registered log handlers).
    if (outcome.budgetAborted) {
      const reason = outcome.budgetAbortReason ?? 'Budget limit exceeded';
      console.error(formatError(ERROR_CODES.E7001, reason));
      logProgress(TAG, `Scan aborted by budget: ${reason}`);
    }

    // ─── Optional: post findings as PR comments ──────────────────────────────
    if (parsed.prNumber !== undefined) {
      const repoSlug = parsed.prRepo ?? process.env.GITHUB_REPOSITORY;
      const repoParts = parseRepoSlug(repoSlug);
      if (!repoParts) {
        console.error(formatError(
          ERROR_CODES.E1001,
          '--pr was supplied but --repo (or $GITHUB_REPOSITORY) is missing or not in owner/repo form',
        ));
        await closeAllHandlers();
        process.exit(1);
      }
      try {
        const headSha = parsed.headSha ?? process.env.GITHUB_HEAD_SHA ?? process.env.GITHUB_SHA;
        const baseSha = parsed.baseSha ?? process.env.GITHUB_BASE_SHA;
        const summary = await postPRComments(results, {
          owner: repoParts.owner,
          repo: repoParts.repo,
          prNumber: parsed.prNumber,
          baseSha,
          headSha,
        });
        console.log(`  PR comments:   posted ${summary.posted}, skipped ${summary.skipped}`);
      } catch (err) {
        console.error(formatError(
          ERROR_CODES.E7201,
          `Failed to post PR comments: ${err instanceof Error ? err.message : String(err)}`,
        ));
        // Non-fatal: don't override scan exit code, but log a warning.
      }
    }

    // Exit code based on --fail-on-check-failure flag or runtime config (spec Section 9.3),
    // OR a budget abort.
    const failOnCheckFailure = parsed.failOnCheckFailure || runtimeConfig.failOnCheckFailure === true;
    const shouldFail =
      outcome.budgetAborted ||
      (failOnCheckFailure && (results.summary.failedChecks > 0 || results.summary.errorChecks > 0));
    await closeAllHandlers();
    process.exit(shouldFail ? 1 : 0);
  } finally {
    // Clean up provider resources (e.g. OpenCode server process)
    if (provider && 'cleanup' in provider && typeof provider.cleanup === 'function') {
      await (provider.cleanup as () => Promise<void>)();
    }
  }
}

// Auto-run when executed directly (npm run scan / tsx src/index.ts), but not when imported by cli.ts.
if (!process.env._AGHAST_CLI) {
  runScan(process.argv.slice(2)).catch(async (err) => {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    console.error('');
    console.error(formatFatalError(err instanceof Error ? err.message : String(err), pkg.version));
    logDebug(TAG, 'Error details', err);
    await closeAllHandlers();
    process.exit(1);
  });
}
