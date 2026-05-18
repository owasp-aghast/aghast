/**
 * Scan runner (orchestrator).
 * Runs security checks against a repository and produces ScanResults.
 * Implements the core workflow from spec Section 2.2.
 */

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './prompt-template.js';
import { parseAgentResponse } from './response-parser.js';
import { extractSnippet } from './snippet-extractor.js';
import { analyzeRepository } from './repository-analyzer.js';
import { logProgress, logDebug, logWarn, createTimer } from './logging.js';
import { CHECK_TYPE } from './check-types.js';
import { getDiscovery, registerDiscovery } from './discovery.js';
import { DEFAULT_PROVIDER_NAME } from './provider-registry.js';
import { semgrepDiscovery } from './discoveries/semgrep-discovery.js';
import { openantDiscovery } from './discoveries/openant-discovery.js';
import { sarifDiscovery } from './discoveries/sarif-discovery.js';
import { applyDiffFilter } from './diff-filter.js';
import { runOpenAnt } from './openant-runner.js';
import type { DiscoveredTarget } from './discovery.js';
import {
  DEFAULT_MODEL,
  FatalProviderError,
  type AgentProvider,
  type RepositoryInfo,
  type AIIssue,
  type SecurityIssue,
  type CheckExecutionSummary,
  type CheckDetails,
  type SecurityCheck,
  type ScanResults,
  type ScanSummary,
  type TokenUsage,
} from './types.js';
import { calculateCost, type PricingConfig, type CostBreakdown } from './cost-calculator.js';
import { checkBudget, BudgetExceededError, type BudgetLimits } from './budget.js';
import type { ScanRecord } from './scan-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'scan';
const DEFAULT_CONCURRENCY = 5;
// Per-target AI call timeout. Without this, a single hung provider request stalls
// the worker indefinitely; with concurrency=N hangs, the entire check freezes.
const DEFAULT_TARGET_TIMEOUT_MS = 5 * 60 * 1000;

// --- Register built-in discovery implementations ---
registerDiscovery(semgrepDiscovery);
registerDiscovery(openantDiscovery);
registerDiscovery(sarifDiscovery);

/**
 * Decide whether to apply the diff filter to a check's discovered targets.
 *
 * Rule: filter iff the discovery supports diff filtering, the check hasn't
 * opted out via `diffFilter: false`, and a diff source is available — either
 * at runtime (CLI/env) or baked into the check's own `diffRef`.
 *
 * Exported for unit testing.
 */
export function shouldApplyDiffFilter(
  check: SecurityCheck,
  discovery: { supportsDiffFilter: boolean },
  runtimeDiffRef: string | undefined,
  runtimeDiffFile: string | undefined,
): boolean {
  if (!discovery.supportsDiffFilter) return false;
  if (check.checkTarget?.diffFilter === false) return false;
  const sourceAvailable = Boolean(
    runtimeDiffRef || runtimeDiffFile || check.checkTarget?.diffRef,
  );
  return sourceAvailable;
}

/**
 * Plan the OpenAnt invocation and diff-filter mode for a single check.
 *
 * Returns the full decision tree the check execution needs:
 * - `willApplyDiffFilter`: run the filter post-discovery?
 * - `useDepthZeroFilter`: if so, skip OpenAnt and use overlap-only fallback?
 * - `sharedOpenant`: a preloaded dataset + cleanup handle when we've run
 *   OpenAnt upfront (to share across discovery and filter).
 *
 * Also emits the "why OpenAnt is running" log line with wording that
 * reflects the actual caller set (discovery-only, filter-only, or both),
 * so operators debugging output aren't misled.
 */
async function prepareCheckExecution(
  check: SecurityCheck,
  discovery: { name: string; supportsDiffFilter: boolean },
  repositoryPath: string,
  diffRef: string | undefined,
  diffFile: string | undefined,
  openantAvailable: boolean,
): Promise<{
  willApplyDiffFilter: boolean;
  useDepthZeroFilter: boolean;
  sharedOpenant: { datasetPath: string; cleanup: () => Promise<void> } | undefined;
}> {
  const willApplyDiffFilter = shouldApplyDiffFilter(check, discovery, diffRef, diffFile);
  const useDepthZeroFilter = willApplyDiffFilter && !openantAvailable && discovery.name !== 'openant';
  const discoveryUsesOpenant = discovery.name === 'openant';
  const filterUsesOpenant = willApplyDiffFilter && !useDepthZeroFilter;
  const needsOpenantDataset = discoveryUsesOpenant || filterUsesOpenant;

  let sharedOpenant: { datasetPath: string; cleanup: () => Promise<void> } | undefined;
  if (needsOpenantDataset) {
    if (discoveryUsesOpenant && filterUsesOpenant) {
      logProgress(TAG, 'Running OpenAnt once (shared between discovery and diff filter)');
    } else if (discoveryUsesOpenant) {
      logProgress(TAG, 'Running OpenAnt for openant discovery');
    } else {
      logProgress(TAG, 'Running OpenAnt for diff-filter call-graph computation');
    }
    sharedOpenant = await runOpenAnt(repositoryPath);
  }

  return { willApplyDiffFilter, useDepthZeroFilter, sharedOpenant };
}

/**
 * Sum multiple TokenUsage values into one aggregate.
 * Returns undefined if no inputs have token usage.
 *
 * reportedCost is aggregated only when every contributing call has it — a
 * single missing cost means we cannot produce an accurate total, so we fall
 * back to undefined (which triggers rate-based estimation later).
 */
export function sumTokenUsage(usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const defined = usages.filter((u): u is TokenUsage => u !== undefined);
  if (defined.length === 0) return undefined;

  // Optional fields: sum when at least one is present; preserve undefined when all absent.
  const sumOptional = (getter: (u: TokenUsage) => number | undefined): number | undefined => {
    const values = defined.map(getter).filter((v): v is number => v !== undefined);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
  };

  // reportedCost: only aggregate when every item has it (uniform provider, single source).
  let reportedCost: TokenUsage['reportedCost'];
  if (defined.every((u) => u.reportedCost !== undefined)) {
    const total = defined.reduce((sum, u) => sum + u.reportedCost!.amountUsd, 0);
    reportedCost = { amountUsd: total, source: defined[0].reportedCost!.source };
  }

  return {
    inputTokens: defined.reduce((sum, u) => sum + u.inputTokens, 0),
    outputTokens: defined.reduce((sum, u) => sum + u.outputTokens, 0),
    cacheCreationInputTokens: sumOptional((u) => u.cacheCreationInputTokens),
    cacheReadInputTokens: sumOptional((u) => u.cacheReadInputTokens),
    reasoningTokens: sumOptional((u) => u.reasoningTokens),
    totalTokens: defined.reduce((sum, u) => sum + u.totalTokens, 0),
    ...(reportedCost !== undefined ? { reportedCost } : {}),
  };
}

/**
 * Get the version from package.json.
 */
async function getVersion(): Promise<string> {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Handle for signaling abort to mapWithConcurrency workers. */
interface AbortHandle {
  aborted: boolean;
  reason?: Error;
}

/**
 * Run an async function over items with bounded concurrency.
 * Spawns min(concurrency, items.length) workers that pull from a shared index.
 * Results are written to a pre-allocated array to preserve input order.
 *
 * If abortHandle is provided, workers stop picking up new items once
 * abortHandle.aborted is set to true. In-flight items complete naturally.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  abortHandle?: AbortHandle,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (abortHandle?.aborted) break;
      // Safe without atomics: Node.js is single-threaded, so nextIndex++ is
      // not interleaved — each worker awaits before looping, yielding to the
      // event loop where the next worker reads and increments the same variable.
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  // Use allSettled so in-flight items complete before we propagate errors
  const settled = await Promise.allSettled(workers);
  const firstRejection = settled.find((r) => r.status === 'rejected');
  if (firstRejection && firstRejection.status === 'rejected') {
    throw firstRejection.reason;
  }

  return results;
}

export interface MultiScanOptions {
  repositoryPath: string;
  checks: Array<{ check: SecurityCheck; details: CheckDetails }>;
  agentProvider?: AgentProvider;
  modelName?: string;
  agentProviderName?: string;
  concurrency?: number;
  repositoryInfo?: RepositoryInfo;
  configDir?: string;
  genericPrompt?: string;
  /**
   * Git ref to diff against. Auto-activates diff filtering on every check
   * whose discovery supports it, unless the check opts out via diffFilter: false.
   */
  diffRef?: string;
  /**
   * Path to a pre-generated unified diff file. Auto-activates diff filtering
   * on every check whose discovery supports it, unless the check opts out
   * via diffFilter: false.
   */
  diffFile?: string;
  /**
   * Whether OpenAnt is available for diff filtering (binary installed or a
   * preloaded dataset provided). When false, the diff filter runs in depth-0
   * mode (file+line overlap only). Defaults to true; set by the CLI entry
   * point after checking the environment.
   */
  openantAvailable?: boolean;
  /** Pricing config for cost calculations. */
  pricing?: PricingConfig;
  /** Optional budget limits enforced before each AI call. */
  budgetLimits?: BudgetLimits;
  /** Pre-loaded scan history (for period budget checks). */
  scanHistory?: ScanRecord[];
  /** true when AGHAST_LOCAL_CLAUDE=true — triggers budget warning if limits are also set */
  isLocalClaude?: boolean;
}

/**
 * Tracks accumulated tokens/cost across a scan so the budget can be evaluated
 * before each AI call. Mutated in place by AI invocations.
 */
export interface ScanCostTracker {
  pricing?: PricingConfig;
  budgetLimits?: BudgetLimits;
  scanHistory?: ScanRecord[];
  totalTokens: number;
  totalCostUsd: number;
  /** Cost source from the last recorded AI call. Used for banner labelling. */
  lastCostSource?: CostBreakdown['source'];
  lastCostReportedBy?: CostBreakdown['reportedBy'];
  lastCostCoveredBySubscription?: boolean;
  /** Set true after the first warn so we don't log it repeatedly. */
  warned: boolean;
  /** Most recent budget action returned to the runner. */
  lastAction: 'continue' | 'warn' | 'abort';
  /** Reason from the most recent non-continue check. */
  lastReason?: string;
}

function createCostTracker(options: MultiScanOptions): ScanCostTracker {
  return {
    pricing: options.pricing,
    budgetLimits: options.budgetLimits,
    scanHistory: options.scanHistory,
    totalTokens: 0,
    totalCostUsd: 0,
    warned: false,
    lastAction: 'continue',
  };
}

/**
 * Record an AI call's token usage against the tracker. Called after each
 * successful executeCheck().
 */
function recordUsage(
  tracker: ScanCostTracker,
  usage: TokenUsage | undefined,
  model: string,
): void {
  if (!usage || !tracker.pricing) return;
  const cost = calculateCost(usage, model, tracker.pricing);
  tracker.totalTokens += usage.totalTokens;
  tracker.totalCostUsd += cost.totalCost;
  tracker.lastCostSource = cost.source;
  tracker.lastCostReportedBy = cost.reportedBy;
  tracker.lastCostCoveredBySubscription = cost.coveredBySubscription;
}

/**
 * Check the budget before an AI call. Logs a warning the first time the warn
 * threshold is crossed; throws BudgetExceededError when the abort threshold is
 * crossed.
 */
function preflightBudget(tracker: ScanCostTracker): void {
  if (!tracker.budgetLimits) return;
  const status = checkBudget(
    {
      currentScanCostUsd: tracker.totalCostUsd,
      currentScanTokens: tracker.totalTokens,
      history: tracker.scanHistory,
    },
    tracker.budgetLimits,
  );
  tracker.lastAction = status.action;
  tracker.lastReason = status.reason;
  if (status.action === 'abort') {
    throw new BudgetExceededError(status.reason ?? 'Budget limit exceeded');
  }
  if (status.action === 'warn' && !tracker.warned) {
    tracker.warned = true;
    logProgress(TAG, `Budget warning: ${status.reason ?? 'approaching limit'}`);
  }
}

/**
 * Generate a scanId in the format: scan-<timestamp>-<hash>
 */
export function generateScanId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
  const hash = randomBytes(3).toString('hex');
  return `scan-${ts}-${hash}`;
}

/**
 * Normalize a file path to be relative to the repository root.
 * Handles:
 * - AI-generated paths that include the parent directory name(s) of the target repo
 *   (e.g., "test-codebases/test-2-importantvalidations-easy/routes/execute.py" when
 *   repo is at "checks-config/test-codebases/test-2-importantvalidations-easy")
 * - Absolute paths: resolves and makes relative
 * - Paths with repository prefix: strips the prefix
 * - Relative paths: returns as-is with forward slashes
 *
 * This ensures consistent path formatting across all findings regardless
 * of how the AI or discovery provider reported the path.
 */
function normalizeFilePath(filePath: string, repositoryPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/');

  // If the path already looks relative and doesn't contain obvious parent refs,
  // check if it starts with path segments that could be the parent of the repo.
  // AI providers often return paths relative to a working directory that is
  // different from the actual repository root, so we need to strip any
  // prefix that leads to the repo path.
  const normalizedRepo = resolve(repositoryPath);
  const repoParts = normalizedRepo.replace(/\\/g, '/').split('/').filter(Boolean);

  // Try stripping progressively longer trailing suffixes of the repo path from
  // the front of the file path. AI providers often return paths relative to an
  // ancestor directory, e.g. "test-codebases/test-2-easy/routes/run.py" when
  // the repo is at "/abs/path/to/test-codebases/test-2-easy".
  for (let i = 1; i <= repoParts.length; i++) {
    const suffix = repoParts.slice(repoParts.length - i).join('/');
    if (normalizedFile.startsWith(suffix + '/')) {
      const candidate = normalizedFile.slice(suffix.length + 1);
      const candidateResolved = resolve(normalizedRepo, candidate);
      const candidateRelative = relative(normalizedRepo, candidateResolved).replace(/\\/g, '/');
      if (!candidateRelative.startsWith('..')) {
        return candidate;
      }
    }
  }

  // Fallback: resolve against repo and make relative
  const resolved = resolve(normalizedRepo, normalizedFile);
  const rel = relative(normalizedRepo, resolved).replace(/\\/g, '/');
  if (!rel.startsWith('..')) {
    return rel;
  }

  // Last resort: just normalize slashes
  return normalizedFile;
}

// --- Single check execution helper ---

interface CheckExecutionResult {
  summary: CheckExecutionSummary;
  issues: SecurityIssue[];
}

/**
 * Enrich a raw AI issue into a full SecurityIssue.
 * Extracts code snippets, applies check metadata, and normalizes paths.
 */
async function enrichIssue(
  aiIssue: AIIssue,
  checkId: string,
  checkName: string,
  repositoryPath: string,
  checkMetadata?: { severity?: string; confidence?: string },
): Promise<SecurityIssue> {
  const codeSnippet = await extractSnippet(
    repositoryPath,
    aiIssue.file,
    aiIssue.startLine,
    aiIssue.endLine,
  );

  const issue: SecurityIssue = {
    checkId,
    checkName,
    file: normalizeFilePath(aiIssue.file, repositoryPath),
    startLine: aiIssue.startLine,
    endLine: aiIssue.endLine,
    description: aiIssue.description,
  };
  if (codeSnippet !== undefined) {
    issue.codeSnippet = codeSnippet;
  }
  if (checkMetadata?.severity !== undefined) {
    issue.severity = checkMetadata.severity;
  }
  if (checkMetadata?.confidence !== undefined) {
    issue.confidence = checkMetadata.confidence;
  }
  if (aiIssue.dataFlow !== undefined) {
    issue.dataFlow = aiIssue.dataFlow.map((step) => ({
      ...step,
      file: normalizeFilePath(step.file, repositoryPath),
    }));
  }
  return issue;
}

/**
 * If the check specifies a per-check model, switch the provider to that model
 * and return the previous model name so it can be restored after execution.
 */
function applyPerCheckModel(
  check: SecurityCheck,
  agentProvider: AgentProvider | undefined,
  globalModelName: string | undefined,
): string | undefined {
  if (!check.model || !agentProvider?.setModel) return undefined;
  const previousModel = agentProvider.getModelName?.() ?? globalModelName;
  agentProvider.setModel(check.model);
  logProgress(TAG, `Using per-check model: ${check.model} (check: ${check.id})`);
  return previousModel;
}

/**
 * Restore the provider's model to the previous value after per-check override.
 */
function restoreModel(
  agentProvider: AgentProvider | undefined,
  previousModel: string | undefined,
): void {
  if (previousModel !== undefined && agentProvider?.setModel) {
    agentProvider.setModel(previousModel);
  }
}

/**
 * Map a discovered target directly to a SecurityIssue (for static checks).
 * Extracts code snippet from source file via extractSnippet().
 */
async function mapTargetToIssue(
  target: DiscoveredTarget,
  checkId: string,
  checkName: string,
  repositoryPath: string,
  checkMetadata?: { severity?: string; confidence?: string },
): Promise<SecurityIssue> {
  const codeSnippet = await extractSnippet(
    repositoryPath,
    target.file,
    target.startLine,
    target.endLine,
  );

  const issue: SecurityIssue = {
    checkId,
    checkName,
    file: normalizeFilePath(target.file, repositoryPath),
    startLine: target.startLine,
    endLine: target.endLine,
    description: target.message || 'Static finding',
  };
  if (codeSnippet !== undefined) {
    issue.codeSnippet = codeSnippet;
  }
  if (checkMetadata?.severity !== undefined) {
    issue.severity = checkMetadata.severity;
  }
  if (checkMetadata?.confidence !== undefined) {
    issue.confidence = checkMetadata.confidence;
  }
  return issue;
}

/**
 * Execute a single check against a repository.
 * Routes to the appropriate execution path based on check type.
 */
async function executeSingleCheck(
  check: SecurityCheck,
  checkName: string,
  checkInstructions: string,
  repositoryPath: string,
  agentProvider: AgentProvider | undefined,
  costTracker: ScanCostTracker,
  checkMetadata?: { severity?: string; confidence?: string },
  concurrency?: number,
  configDir?: string,
  genericPrompt?: string,
  diffRef?: string,
  diffFile?: string,
  openantAvailable: boolean = true,
): Promise<CheckExecutionResult> {
  const checkId = check.id;

  // Route to targeted execution (discovery + AI analysis)
  if (check.checkTarget?.type === CHECK_TYPE.TARGETED) {
    if (!agentProvider) {
      throw new Error(`Check "${checkId}" requires an agent provider but none was configured`);
    }
    return executeTargetedCheck(
      check,
      checkName,
      checkInstructions,
      repositoryPath,
      agentProvider,
      costTracker,
      checkMetadata,
      concurrency,
      configDir,
      genericPrompt,
      diffRef,
      diffFile,
      openantAvailable,
    );
  }

  // Route to static execution (discovery + direct mapping, no AI)
  if (check.checkTarget?.type === CHECK_TYPE.STATIC) {
    return executeStaticCheck(check, checkName, repositoryPath, checkMetadata, diffRef, diffFile, openantAvailable);
  }

  // Repository check (no discovery, AI analyzes whole repo)
  if (!agentProvider) {
    throw new Error(`Check "${checkId}" requires an agent provider but none was configured`);
  }

  logProgress(TAG, `Running check: ${checkName}`);

  const prompt = await buildPrompt(checkInstructions, configDir, genericPrompt);
  logDebug(TAG, `Prompt built: ${prompt.length} chars`);

  let issues: SecurityIssue[] = [];
  let summary: CheckExecutionSummary;

  const checkTimer = createTimer();

  try {
    preflightBudget(costTracker);
    const agentResponse = await agentProvider.executeCheck(prompt, repositoryPath);
    const model = agentProvider.getModelName?.() ?? DEFAULT_MODEL;
    recordUsage(costTracker, agentResponse.tokenUsage, model);
    const executionTime = checkTimer.elapsed();

    logDebug(TAG, `Agent response: ${agentResponse.raw.length} chars`);
    const parsed = agentResponse.parsed ?? parseAgentResponse(agentResponse.raw);

    if (!parsed) {
      logProgress(TAG, 'Result: ERROR (malformed response)');
      summary = {
        checkId,
        checkName,
        status: 'ERROR',
        issuesFound: 0,
        executionTime,
        error: 'Agent provider returned malformed response',
        rawAiResponse: agentResponse.raw,
        tokenUsage: agentResponse.tokenUsage,
      };
    } else if (parsed.issues.length > 0) {
      logProgress(TAG, `Result: FAIL (${parsed.issues.length} issues)`);

      issues = await Promise.all(
        parsed.issues.map((aiIssue) =>
          enrichIssue(aiIssue, checkId, checkName, repositoryPath, checkMetadata),
        ),
      );

      summary = {
        checkId,
        checkName,
        status: 'FAIL',
        issuesFound: issues.length,
        executionTime,
        tokenUsage: agentResponse.tokenUsage,
      };
    } else if (parsed.flagged) {
      logProgress(TAG, 'Result: FLAG (AI flagged for review)');
      summary = {
        checkId,
        checkName,
        status: 'FLAG',
        issuesFound: 0,
        executionTime,
        tokenUsage: agentResponse.tokenUsage,
      };
    } else {
      logProgress(TAG, 'Result: PASS');
      summary = {
        checkId,
        checkName,
        status: 'PASS',
        issuesFound: 0,
        executionTime,
        tokenUsage: agentResponse.tokenUsage,
      };
    }
  } catch (err) {
    // Fatal errors and budget aborts must propagate up to stop the scan
    if (err instanceof FatalProviderError || err instanceof BudgetExceededError) {
      throw err;
    }
    const executionTime = checkTimer.elapsed();
    const errorMsg = err instanceof Error ? err.message : String(err);
    logProgress(TAG, `Result: ERROR (${errorMsg})`);
    summary = {
      checkId,
      checkName,
      status: 'ERROR',
      issuesFound: 0,
      executionTime,
      error: errorMsg,
    };
  }

  return { summary, issues };
}

/**
 * Execute a targeted check: discovery finds targets, AI analyzes each.
 * The execution pipeline is generic — all discovery-specific behavior is
 * encapsulated in the DiscoveredTarget data from the discovery implementation.
 */
async function executeTargetedCheck(
  check: SecurityCheck,
  checkName: string,
  checkInstructions: string,
  repositoryPath: string,
  agentProvider: AgentProvider,
  costTracker: ScanCostTracker,
  checkMetadata?: { severity?: string; confidence?: string },
  optionsConcurrency?: number,
  configDir?: string,
  genericPromptOverride?: string,
  diffRef?: string,
  diffFile?: string,
  openantAvailable: boolean = true,
): Promise<CheckExecutionResult> {
  const checkId = check.id;
  const checkTarget = check.checkTarget!;

  const discoveryName = checkTarget.discovery;
  if (!discoveryName) {
    throw new Error(`Check "${checkId}" is targeted but has no "discovery" specified`);
  }

  const discovery = getDiscovery(discoveryName);

  logProgress(TAG, `Running targeted check: ${checkName} (discovery: ${discoveryName})`);
  const checkTimer = createTimer();

  const { willApplyDiffFilter, useDepthZeroFilter, sharedOpenant } = await prepareCheckExecution(
    check,
    discovery,
    repositoryPath,
    diffRef,
    diffFile,
    openantAvailable,
  );

  try {
    // 1. Discover targets
    let targets = await discovery.discover(check, repositoryPath, {
      repositoryPath,
      openantDatasetPath: sharedOpenant?.datasetPath,
    });

    // 2. Apply diff filter automatically when a diff source is available, the
    //    discovery supports it, and the check hasn't opted out via diffFilter: false.
    if (willApplyDiffFilter) {
      targets = await applyDiffFilter(check, targets, repositoryPath, {
        diffRef,
        diffFile,
        depthZero: useDepthZeroFilter,
        openant: checkTarget.openant,
        openantDatasetPath: sharedOpenant?.datasetPath,
      });
    }

    // 3. Apply maxTargets limit
    if (checkTarget.maxTargets !== undefined && targets.length > checkTarget.maxTargets) {
      targets = targets.slice(0, checkTarget.maxTargets);
      logProgress(TAG, `Limited to ${targets.length} targets (maxTargets: ${checkTarget.maxTargets})`);
    }

    // 4. If no targets, return PASS
    if (targets.length === 0) {
      logProgress(TAG, 'Result: PASS (no targets found)');
      return {
        summary: {
          checkId,
          checkName,
          status: 'PASS',
          issuesFound: 0,
          executionTime: checkTimer.elapsed(),
          targetsAnalyzed: 0,
        },
        issues: [],
      };
    }

    // 5. Resolve effective concurrency: per-check > options > default
    const effectiveConcurrency =
      checkTarget.concurrency ?? optionsConcurrency ?? DEFAULT_CONCURRENCY;

    logProgress(TAG, `Found ${targets.length} targets to analyze (concurrency: ${effectiveConcurrency})`);

    // Progress summary timer — logs a periodic overview at info level (every 15s)
    const PROGRESS_INTERVAL_MS = 15000;
    const progressTimer = createTimer();
    let inProgressCount = 0;

    // 5. Resolve generic prompt: CLI override > analysisMode prompt > discovery default
    const analysisModePrompts: Record<string, string> = {
      'false-positive-validation': 'false-positive-validation.md',
      'general-vuln-discovery': 'general-vuln-discovery.md',
    };
    const analysisModePrompt = checkTarget.analysisMode
      ? analysisModePrompts[checkTarget.analysisMode]
      : undefined;
    const effectiveGenericPrompt = genericPromptOverride ?? analysisModePrompt ?? discovery.defaultGenericPrompt;
    const basePrompt = await buildPrompt(checkInstructions, configDir, effectiveGenericPrompt);
    let completedCount = 0;
    const abortHandle: AbortHandle = { aborted: false };

    // 6. Analyze targets concurrently — pipeline is generic, no discovery conditionals
    const logProgressSummary = () => {
      const pending = targets.length - completedCount - inProgressCount;
      logProgress(TAG, `AI progress [${targets.length} targets]: ${completedCount} complete, ${inProgressCount} in progress, ${pending} pending (${progressTimer.elapsedStr()})`);
    };
    logProgressSummary();
    const progressInterval = setInterval(logProgressSummary, PROGRESS_INTERVAL_MS);

    let targetResults: { issues: SecurityIssue[]; error: boolean; flagged: boolean; tokenUsage: TokenUsage | undefined }[];
    try {
    targetResults = await mapWithConcurrency(
      targets,
      effectiveConcurrency,
      async (target, _idx) => {
        inProgressCount++;
        try {
          try {
            preflightBudget(costTracker);
          } catch (budgetErr) {
            if (budgetErr instanceof BudgetExceededError) {
              abortHandle.aborted = true;
              abortHandle.reason = budgetErr;
              throw budgetErr;
            }
            throw budgetErr;
          }
          const prompt = basePrompt + (target.promptEnrichment ?? '');

          logDebug(TAG, `${target.label} Analyzing: ${target.file}:${target.startLine}-${target.endLine}`);
          let timeoutHandle: NodeJS.Timeout | undefined;
          const agentResponse = await Promise.race([
            agentProvider.executeCheck(
              prompt,
              repositoryPath,
              target.label,
              target.agentOptions,
            ),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(
                  `Agent provider timed out after ${DEFAULT_TARGET_TIMEOUT_MS / 1000}s on target ${target.label}`,
                )),
                DEFAULT_TARGET_TIMEOUT_MS,
              );
            }),
          ]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          });
          const model = agentProvider.getModelName?.() ?? DEFAULT_MODEL;
          recordUsage(costTracker, agentResponse.tokenUsage, model);

          const parsed = agentResponse.parsed ?? parseAgentResponse(agentResponse.raw);

          if (!parsed) {
            logDebug(TAG, `${target.label} Returned malformed response`);
            return { issues: [] as SecurityIssue[], error: true, flagged: false, tokenUsage: agentResponse.tokenUsage };
          }

          // Apply optional per-target issue cap (checkTarget.maxIssuesPerTarget).
          // Useful for checks whose prompt expects one combined issue per target;
          // most checks should leave it unset and allow unlimited issues per target.
          const maxIssues = checkTarget.maxIssuesPerTarget;
          const cappedIssues = typeof maxIssues === 'number' && maxIssues >= 0
            ? parsed.issues.slice(0, maxIssues)
            : parsed.issues;
          if (cappedIssues.length < parsed.issues.length) {
            logDebug(TAG, `${target.label} Capping ${parsed.issues.length} issues to ${maxIssues} (maxIssuesPerTarget)`);
          }

          const issues = await Promise.all(
            cappedIssues.map((aiIssue) =>
              enrichIssue(aiIssue, checkId, checkName, repositoryPath, checkMetadata),
            ),
          );
          return { issues, error: false, flagged: parsed.flagged === true, tokenUsage: agentResponse.tokenUsage };
        } catch (err) {
          // Fatal errors and budget aborts: signal abort and re-throw to stop other workers
          if (err instanceof FatalProviderError || err instanceof BudgetExceededError) {
            abortHandle.aborted = true;
            abortHandle.reason = err;
            throw err;
          }
          const errorMsg = err instanceof Error ? err.message : String(err);
          logDebug(TAG, `${target.label} Error: ${errorMsg}`);
          return { issues: [] as SecurityIssue[], error: true, flagged: false, tokenUsage: undefined };
        } finally {
          inProgressCount--;
          completedCount++;
          logDebug(TAG, `Progress: ${completedCount}/${targets.length} targets analyzed`);
        }
      },
      abortHandle,
    );
    } finally {
      clearInterval(progressInterval);
    }

    // 7. Aggregate results
    const allIssues: SecurityIssue[] = [];
    let hasErrors = false;
    let hasFlagged = false;
    const targetTokenUsages: (TokenUsage | undefined)[] = [];
    for (const result of targetResults) {
      allIssues.push(...result.issues);
      if (result.error) hasErrors = true;
      if (result.flagged) hasFlagged = true;
      targetTokenUsages.push(result.tokenUsage);
    }

    // 8. Determine status: FAIL > FLAG > ERROR > PASS
    const executionTime = checkTimer.elapsed();
    let status: 'PASS' | 'FAIL' | 'FLAG' | 'ERROR';
    if (allIssues.length > 0) {
      status = 'FAIL';
    } else if (hasFlagged) {
      status = 'FLAG';
    } else if (hasErrors) {
      status = 'ERROR';
    } else {
      status = 'PASS';
    }

    logProgress(TAG, `Result: ${status} (${allIssues.length} issues, ${targets.length} targets)`);

    return {
      summary: {
        checkId,
        checkName,
        status,
        issuesFound: allIssues.length,
        executionTime,
        targetsAnalyzed: targets.length,
        tokenUsage: sumTokenUsage(targetTokenUsages),
      },
      issues: allIssues,
    };
  } catch (err) {
    // Fatal errors and budget aborts must propagate up to stop the scan
    if (err instanceof FatalProviderError || err instanceof BudgetExceededError) {
      throw err;
    }
    const executionTime = checkTimer.elapsed();
    const errorMsg = err instanceof Error ? err.message : String(err);
    logProgress(TAG, `Result: ERROR (${errorMsg})`);
    return {
      summary: {
        checkId,
        checkName,
        status: 'ERROR',
        issuesFound: 0,
        executionTime,
        error: errorMsg,
      },
      issues: [],
    };
  } finally {
    if (sharedOpenant) {
      await sharedOpenant.cleanup();
      logDebug(TAG, 'Cleaned up shared OpenAnt output');
    }
  }
}

/**
 * Execute a static check: discovery finds targets, mapped directly to issues (no AI).
 */
async function executeStaticCheck(
  check: SecurityCheck,
  checkName: string,
  repositoryPath: string,
  checkMetadata?: { severity?: string; confidence?: string },
  diffRef?: string,
  diffFile?: string,
  openantAvailable: boolean = true,
): Promise<CheckExecutionResult> {
  const checkId = check.id;
  const checkTarget = check.checkTarget!;

  const discoveryName = checkTarget.discovery;
  if (!discoveryName) {
    throw new Error(`Check "${checkId}" is static but has no "discovery" specified`);
  }

  const discovery = getDiscovery(discoveryName);

  logProgress(TAG, `Running static check: ${checkName} (discovery: ${discoveryName})`);
  const checkTimer = createTimer();

  const { willApplyDiffFilter, useDepthZeroFilter, sharedOpenant } = await prepareCheckExecution(
    check,
    discovery,
    repositoryPath,
    diffRef,
    diffFile,
    openantAvailable,
  );

  try {
    // 1. Discover targets
    let targets = await discovery.discover(check, repositoryPath, {
      repositoryPath,
      openantDatasetPath: sharedOpenant?.datasetPath,
    });

    // 2. Apply diff filter automatically when a diff source is available, the
    //    discovery supports it, and the check hasn't opted out via diffFilter: false.
    if (willApplyDiffFilter) {
      targets = await applyDiffFilter(check, targets, repositoryPath, {
        diffRef,
        diffFile,
        depthZero: useDepthZeroFilter,
        openant: checkTarget.openant,
        openantDatasetPath: sharedOpenant?.datasetPath,
      });
    }

    // 3. Apply maxTargets limit
    if (checkTarget.maxTargets !== undefined && targets.length > checkTarget.maxTargets) {
      targets = targets.slice(0, checkTarget.maxTargets);
    }

    // 3. If no targets, return PASS
    if (targets.length === 0) {
      logProgress(TAG, 'Result: PASS (no findings)');
      return {
        summary: {
          checkId,
          checkName,
          status: 'PASS',
          issuesFound: 0,
          executionTime: checkTimer.elapsed(),
          targetsAnalyzed: 0,
        },
        issues: [],
      };
    }

    // 4. Map each target directly to a SecurityIssue (no AI)
    const issues = await Promise.all(
      targets.map((target) =>
        mapTargetToIssue(target, checkId, checkName, repositoryPath, checkMetadata),
      ),
    );

    const executionTime = checkTimer.elapsed();
    logProgress(TAG, `Result: FAIL (${issues.length} findings, ${targets.length} targets)`);

    return {
      summary: {
        checkId,
        checkName,
        status: 'FAIL',
        issuesFound: issues.length,
        executionTime,
        targetsAnalyzed: targets.length,
      },
      issues,
    };
  } catch (err) {
    const executionTime = checkTimer.elapsed();
    const errorMsg = err instanceof Error ? err.message : String(err);
    logProgress(TAG, `Result: ERROR (${errorMsg})`);
    return {
      summary: {
        checkId,
        checkName,
        status: 'ERROR',
        issuesFound: 0,
        executionTime,
        error: errorMsg,
      },
      issues: [],
    };
  } finally {
    if (sharedOpenant) {
      await sharedOpenant.cleanup();
      logDebug(TAG, 'Cleaned up shared OpenAnt output');
    }
  }
}

/** Aggregated ScanResults plus computed cost summary. */
export interface MultiScanOutcome {
  results: ScanResults;
  totalCostUsd: number;
  currency: string;
  models: string[];
  /** How the cost was determined (for banner/stats labelling). */
  costSource?: CostBreakdown['source'];
  /** Which provider reported the cost when costSource === 'reported'. */
  costReportedBy?: CostBreakdown['reportedBy'];
  /** true when AGHAST_LOCAL_CLAUDE=true — amount is API-equivalent, not billed */
  costCoveredBySubscription?: boolean;
  /** True when the scan was halted by a budget abort. */
  budgetAborted?: boolean;
  /** Reason from the budget abort, when budgetAborted is true. */
  budgetAbortReason?: string;
}

/**
 * Run multiple security checks and return aggregated ScanResults.
 */
export async function runMultiScan(options: MultiScanOptions): Promise<ScanResults> {
  const outcome = await runMultiScanWithCost(options);
  return outcome.results;
}

/**
 * Same as runMultiScan but also returns the computed cost summary.
 * Used by the CLI to record scan history.
 */
export async function runMultiScanWithCost(options: MultiScanOptions): Promise<MultiScanOutcome> {
  const { repositoryPath, checks, agentProvider, modelName, agentProviderName, concurrency, configDir, genericPrompt, diffRef, diffFile } = options;
  const openantAvailable = options.openantAvailable ?? true;
  const scanTimer = createTimer();
  const scanId = generateScanId();
  const startTime = new Date();
  const version = await getVersion();

  logProgress(TAG, `Starting scan ${scanId} (${checks.length} ${checks.length === 1 ? 'check' : 'checks'})`);
  logDebug(TAG, `Repository: ${repositoryPath}`);
  if (options.isLocalClaude && options.budgetLimits) {
    logWarn(TAG, 'Budget limits in local-Claude mode apply to equivalent API cost, not subscription usage.');
  }

  // Use pre-analyzed repository info if provided, otherwise analyze here
  let repositoryInfo: RepositoryInfo;
  if (options.repositoryInfo) {
    repositoryInfo = options.repositoryInfo;
  } else {
    const repoAnalysis = await analyzeRepository(repositoryPath);
    repositoryInfo = repoAnalysis.repository;
  }

  const allCheckSummaries: CheckExecutionSummary[] = [];
  const allIssues: SecurityIssue[] = [];
  let budgetAborted = false;
  let budgetAbortReason: string | undefined;

  // Cost / budget tracking spans all checks in the scan.
  const costTracker = createCostTracker(options);

  // Track all models used during the scan
  const modelsUsed = new Set<string>();
  if (modelName) modelsUsed.add(modelName);

  // Execute checks sequentially
  for (let ci = 0; ci < checks.length; ci++) {
    const { check, details } = checks[ci];
    const checkMetadata = {
      severity: check.severity,
      confidence: check.confidence,
    };

    // Apply per-check model override if specified
    const previousModel = applyPerCheckModel(check, agentProvider, modelName);
    if (check.model) modelsUsed.add(check.model);

    try {
      const { summary: checkSummary, issues } = await executeSingleCheck(
        check,
        details.name,
        details.content,
        repositoryPath,
        agentProvider,
        costTracker,
        checkMetadata,
        concurrency,
        configDir,
        genericPrompt,
        diffRef,
        diffFile,
        openantAvailable,
      );

      allCheckSummaries.push(checkSummary);
      allIssues.push(...issues);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetAborted = true;
        budgetAbortReason = err.message;
        logProgress(TAG, `Budget exceeded during check "${check.id}": ${err.message}`);
        allCheckSummaries.push({
          checkId: check.id,
          checkName: details.name,
          status: 'ERROR',
          issuesFound: 0,
          executionTime: 0,
          error: `Budget exceeded: ${err.message}`,
        });
        for (let ri = ci + 1; ri < checks.length; ri++) {
          const remaining = checks[ri];
          logProgress(TAG, `Skipping check "${remaining.check.id}" due to budget abort`);
          allCheckSummaries.push({
            checkId: remaining.check.id,
            checkName: remaining.details.name,
            status: 'ERROR',
            issuesFound: 0,
            executionTime: 0,
            error: `Scan aborted: budget limit exceeded`,
          });
        }
        restoreModel(agentProvider, previousModel);
        break;
      }
      if (err instanceof FatalProviderError) {
        // Record the failing check as ERROR
        logProgress(TAG, `Fatal error during check "${check.id}": ${err.message}`);
        allCheckSummaries.push({
          checkId: check.id,
          checkName: details.name,
          status: 'ERROR',
          issuesFound: 0,
          executionTime: 0,
          error: err.message,
        });
        // Record remaining checks as ERROR (aborted)
        for (let ri = ci + 1; ri < checks.length; ri++) {
          const remaining = checks[ri];
          logProgress(TAG, `Skipping check "${remaining.check.id}" due to fatal error`);
          allCheckSummaries.push({
            checkId: remaining.check.id,
            checkName: remaining.details.name,
            status: 'ERROR',
            issuesFound: 0,
            executionTime: 0,
            error: `Scan aborted: ${err.message}`,
          });
        }
        logProgress(TAG, `Scan aborted due to fatal error: ${err.message}`);
        break;
      }
      // Non-fatal errors should not reach here (executeSingleCheck catches them),
      // but handle gracefully just in case.
      throw err;
    } finally {
      // Restore the global model after per-check override
      restoreModel(agentProvider, previousModel);
    }
  }

  const endTime = new Date();
  const executionTime = endTime.getTime() - startTime.getTime();

  const summary: ScanSummary = {
    totalChecks: allCheckSummaries.length,
    passedChecks: allCheckSummaries.filter((c) => c.status === 'PASS').length,
    failedChecks: allCheckSummaries.filter((c) => c.status === 'FAIL').length,
    flaggedChecks: allCheckSummaries.filter((c) => c.status === 'FLAG').length,
    errorChecks: allCheckSummaries.filter((c) => c.status === 'ERROR').length,
    totalIssues: allIssues.length,
  };

  logProgress(TAG, `Scan completed in ${scanTimer.elapsedStr()}`);

  // Aggregate token usage across all checks
  const aggregateTokenUsage = sumTokenUsage(allCheckSummaries.map((c) => c.tokenUsage));

  const results: ScanResults = {
    scanId,
    timestamp: startTime.toISOString(),
    version,
    repository: repositoryInfo,
    issues: allIssues,
    checks: allCheckSummaries,
    summary,
    executionTime,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    agentProvider: agentProvider
      ? { name: agentProviderName ?? DEFAULT_PROVIDER_NAME, models: modelsUsed.size > 0 ? [...modelsUsed] : [DEFAULT_MODEL] }
      : { name: 'none', models: [] },
    tokenUsage: aggregateTokenUsage,
  };

  // Attach cost metadata when pricing was provided.
  if (options.pricing) {
    results.metadata = {
      ...(results.metadata ?? {}),
      cost: {
        totalCostUsd: costTracker.totalCostUsd,
        currency: options.pricing.currency ?? 'USD',
      },
    };
  }

  return {
    results,
    totalCostUsd: costTracker.totalCostUsd,
    currency: options.pricing?.currency ?? 'USD',
    models: [...modelsUsed],
    costSource: costTracker.lastCostSource,
    costReportedBy: costTracker.lastCostReportedBy,
    costCoveredBySubscription: costTracker.lastCostCoveredBySubscription,
    budgetAborted,
    budgetAbortReason,
  };
}
