/**
 * Shared helpers and constants for CLI integration tests.
 *
 * Extracted from cli-mock-mode.test.ts to allow splitting the test suite
 * across multiple files for parallel CI execution.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, unlink } from 'node:fs/promises';

export const testDir = dirname(fileURLToPath(import.meta.url));

// PATH-based existence check rather than spawning `semgrep --version`. Semgrep's
// version command does a network update check (~1.7s) and 5 test files import
// this helper in parallel processes — `spawnSync` with a 5s timeout can fall
// over under that load, falsely marking semgrep as missing.
function isOnPath(name: string): boolean {
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (statSync(join(dir, `${name}${ext}`)).isFile()) return true;
      } catch {
        // not found in this dir, keep looking
      }
    }
  }
  return false;
}

export const semgrepInstalled = isOnPath('semgrep');

export const fixtureRepo = resolve(testDir, 'fixtures', 'git-repo');
export const entryPoint = resolve(testDir, '..', 'src', 'index.ts');

// Default output paths (used by cli-mock-mode.test.ts part 1)
export const outputFile = resolve(fixtureRepo, 'security_checks_results.json');
export const sarifOutputFile = resolve(fixtureRepo, 'security_checks_results.sarif');
export const csvOutputFile = resolve(fixtureRepo, 'security_checks_results.csv');
export const htmlOutputFile = resolve(fixtureRepo, 'security_checks_results.html');

// Per-scenario config dirs (each contains checks-config.json and checks/ subfolder)
export const singleCheckConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'single-check');
export const multiCheckConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'multi-check');
export const repoFilteredConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'repo-filtered');
export const disabledConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'with-disabled');
export const invalidConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'invalid');
export const multiTargetConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'multi-target');
export const multiTargetCappedConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'multi-target-capped');
export const mixedChecksConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'mixed-checks');
export const flagCheckConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'flag-check');
export const mixedResultsConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'mixed-results');
export const semgrepOnlyConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'semgrep-only');
export const opengrepOnlyConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'opengrep-only');
export const mixedWithSemgrepOnlyConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'mixed-with-semgrep-only');
export const sarifVerifyConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'sarif-verify');
export const sarifVerifyEmptyConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'sarif-verify-empty');
export const sarifVerifyMissingConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'sarif-verify-missing');
export const perCheckModelConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'per-check-model');
export const openantCheckConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'openant-check');
export const mixedDiscoveryConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'mixed-discovery');
export const unknownDiscoveryConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'unknown-discovery');
export const semgrepDiffFilterConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'semgrep-diff-filter');
export const sarifDiffFilterConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'sarif-diff-filter');
export const openantDiffFilterConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'openant-diff-filter');
export const fpValidationConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'fp-validation');

// SARIF fixtures
export const cli3TargetsSarif = resolve(testDir, 'fixtures', 'sarif', 'cli-3-targets.sarif');
export const emptyResultsSarif = resolve(testDir, 'fixtures', 'sarif', 'empty-results.sarif');
export const noEndlineSarif = resolve(testDir, 'fixtures', 'sarif', 'no-endline-target.sarif');

// AI response fixtures
export const failFixtureRepo = resolve(testDir, 'fixtures', 'ai-responses', 'fail-response-fixture-repo.json');
export const multiIssueFixture = resolve(testDir, 'fixtures', 'ai-responses', 'multi-issue-fixture-repo.json');
export const malformedFixture = resolve(testDir, 'fixtures', 'ai-responses', 'malformed-response.txt');
export const missingFieldsFixture = resolve(testDir, 'fixtures', 'ai-responses', 'missing-fields-response.json');
export const dataFlowFixture = resolve(testDir, 'fixtures', 'ai-responses', 'fail-response-with-dataflow.json');
export const fpValidationFalsePositiveFixture = resolve(testDir, 'fixtures', 'ai-responses', 'fp-validation-false-positive.json');
export const fpValidationTruePositiveFixture = resolve(testDir, 'fixtures', 'ai-responses', 'fp-validation-true-positive.json');

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Windows + Node 24 libuv crash exit code (0xC0000005, nodejs/node#56645)
const LIBUV_CRASH_CODE = 3221226505;
const LIBUV_MAX_RETRIES = 3;

function execCLI(
  cliEntryPoint: string,
  args: string[],
  childEnv: Record<string, string | undefined>,
  timeout: number,
): Promise<CLIResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', cliEntryPoint, ...args],
      {
        env: childEnv as NodeJS.ProcessEnv,
        timeout,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout,
          stderr,
          exitCode: error ? (child.exitCode ?? 1) : 0,
        });
      },
    );
  });
}

export async function runCLI(
  env: Record<string, string | undefined> = {},
  args: string[] = [fixtureRepo, '--config-dir', singleCheckConfigDir],
  options: { timeout?: number } = {},
): Promise<CLIResult> {
  // Build env: start from process.env, then override dotenv-loaded vars for hermetic
  // tests, then apply explicit overrides. Keys set to undefined are deleted.
  const dotenvDefaults: Record<string, string | undefined> = {
    AGHAST_LOCAL_CLAUDE: undefined,
    AGHAST_MOCK_AI: undefined,
    AGHAST_MOCK_CLAUDE_MODELS: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    AGHAST_CONFIG_DIR: '',
    AGHAST_GENERIC_PROMPT: undefined,
    AGHAST_AI_MODEL: undefined,
    AGHAST_DEBUG: undefined,
    AGHAST_LOG_LEVEL: '',
    AGHAST_LOG_FILE: '',
    AGHAST_LOG_TYPE: '',
    NO_COLOR: '1',
  };
  const merged = { ...dotenvDefaults, ...env };
  const childEnv = { ...process.env, ...merged };
  for (const [key, val] of Object.entries(merged)) {
    if (val === undefined) {
      delete childEnv[key];
    }
  }
  const timeout = options.timeout ?? 30_000;

  // Retry on Windows libuv crash (nodejs/node#56645)
  for (let attempt = 1; attempt <= LIBUV_MAX_RETRIES; attempt++) {
    const result = await execCLI(entryPoint, args, childEnv, timeout);
    if (result.exitCode === LIBUV_CRASH_CODE && attempt < LIBUV_MAX_RETRIES) {
      console.warn(
        `WARNING: libuv crash (0xC0000005) on attempt ${attempt}/${LIBUV_MAX_RETRIES}, retrying... (nodejs/node#56645)`,
      );
      continue;
    }
    return result;
  }
  // Unreachable, but satisfies TypeScript
  throw new Error('runCLI: retry loop exited unexpectedly');
}

export async function cleanupOutput(): Promise<void> {
  for (const f of [outputFile, sarifOutputFile, csvOutputFile, htmlOutputFile]) {
    try {
      await unlink(f);
    } catch {
      // File may not exist; that's fine
    }
  }
}

export async function readResults(): Promise<Record<string, unknown>> {
  const raw = await readFile(outputFile, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Creates a scoped set of CLI helpers that write output to a unique directory,
 * preventing file conflicts when test files run concurrently.
 */
export function createScopedHelpers(prefix: string) {
  const scopedOutputFile = resolve(fixtureRepo, `security_checks_results_${prefix}.json`);
  const scopedSarifOutputFile = resolve(fixtureRepo, `security_checks_results_${prefix}.sarif`);

  function scopedRunCLI(
    env: Record<string, string | undefined> = {},
    args?: string[],
    options: { timeout?: number } = {},
  ): Promise<CLIResult> {
    // Default args include --output pointing to the scoped file
    const defaultArgs = [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--output', scopedOutputFile,
    ];
    if (!args) return runCLI(env, defaultArgs, options);
    // Only append --output if the caller didn't already include one
    if (args.includes('--output')) return runCLI(env, args, options);
    return runCLI(env, [...args, '--output', scopedOutputFile], options);
  }

  function scopedRunCLISarif(
    env: Record<string, string | undefined> = {},
    args: string[],
  ): Promise<CLIResult> {
    // Replace the --output in the caller's args with the scoped SARIF path
    if (args.includes('--output')) return runCLI(env, args);
    return runCLI(env, [...args, '--output', scopedSarifOutputFile]);
  }

  async function scopedCleanupOutput(): Promise<void> {
    for (const f of [scopedOutputFile, scopedSarifOutputFile]) {
      try {
        await unlink(f);
      } catch {
        // File may not exist; that's fine
      }
    }
  }

  async function scopedReadResults(): Promise<Record<string, unknown>> {
    const raw = await readFile(scopedOutputFile, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  return {
    outputFile: scopedOutputFile,
    sarifOutputFile: scopedSarifOutputFile,
    runCLI: scopedRunCLI,
    runCLISarif: scopedRunCLISarif,
    cleanupOutput: scopedCleanupOutput,
    readResults: scopedReadResults,
  };
}
