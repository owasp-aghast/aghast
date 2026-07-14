/**
 * Semgrep runner.
 * Executes Semgrep against a repository and returns raw SARIF output.
 *
 * Shares core logic with the opengrep runner via the `runSarifScanner` and
 * `verifySarifScannerInstalled` helpers exported from this module — both tools
 * have the same CLI shape (`--config X --sarif --output FILE .`) and emit
 * SARIF 2.1.0, so only the binary name, mock env var, and error messaging
 * differ between them.
 */

import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logProgress, logDebug } from './logging.js';

const TAG = 'semgrep';

export interface SemgrepOptions {
  repositoryPath: string;
  rules?: string | string[];
  config?: string;
}

/**
 * Configuration describing a semgrep-compatible SARIF scanner binary
 * (semgrep, opengrep, ...). Used by the shared runner helpers below.
 */
export interface SarifScannerTool {
  /** Binary name on PATH (e.g. "semgrep", "opengrep"). */
  binary: string;
  /**
   * Environment variable that, if set, short-circuits execution and reads SARIF from the named file.
   *
   * By design, both `SEMGREP_TOOL` and `OPENGREP_TOOL` set this to `AGHAST_MOCK_SARIF` —
   * a single shared stub env var rather than per-tool vars. Consequence: setting
   * `AGHAST_MOCK_SARIF` feeds the same SARIF fixture to every SARIF-producing tool
   * in a mixed-discovery scan; there's no way to stub only one of the two. This is
   * intentional (the SARIF format is identical, so one fixture serves both) and
   * keeps the test surface minimal. If independent stubs are ever needed, introduce
   * tool-specific env vars with `AGHAST_MOCK_SARIF` as a fallback.
   */
  mockEnvVar: string;
  /** Log tag. */
  tag: string;
  /** User-facing display name used in progress/error messages. */
  displayName: string;
  /** URL users should visit to install the binary. */
  installUrl: string;
  /** Temp-directory prefix for output files. */
  tmpPrefix: string;
}

export const SEMGREP_TOOL: SarifScannerTool = {
  binary: 'semgrep',
  mockEnvVar: 'AGHAST_MOCK_SARIF',
  tag: TAG,
  displayName: 'Semgrep',
  installUrl: 'https://semgrep.dev/docs/getting-started/',
  tmpPrefix: 'aghast-semgrep-',
};

/**
 * Build the Semgrep CLI arguments. Opengrep uses the same argument shape,
 * so `opengrep-runner.ts` reuses this builder directly.
 */
export function buildSemgrepArgs(
  options: SemgrepOptions,
  outputFile: string,
): string[] {
  const args: string[] = [];

  if (options.config) {
    args.push('--config', options.config);
  } else if (options.rules) {
    const rulesList = Array.isArray(options.rules) ? options.rules : [options.rules];
    for (const rule of rulesList) {
      args.push('--config', rule);
    }
  }

  args.push('--sarif', '--output', outputFile, '.');

  return args;
}

/**
 * Verify that a SARIF scanner binary is installed and available on PATH.
 * Resolves if found, rejects with a user-friendly error if not.
 * Skips the check when the tool's mock env var is set.
 */
export async function verifySarifScannerInstalled(tool: SarifScannerTool): Promise<void> {
  if (process.env[tool.mockEnvVar]) return;
  return new Promise((resolve, reject) => {
    execFile(tool.binary, ['--version'], (error) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            `${tool.displayName} is required for the configured checks but was not found. Install it from ${tool.installUrl}`,
          ));
          return;
        }
        reject(new Error(
          `${tool.displayName} --version failed: ${error.message}. If the installation is broken, reinstall from ${tool.installUrl}`,
        ));
        return;
      }
      resolve();
    });
  });
}

/**
 * Verify that Semgrep is installed and available on PATH.
 * Skips the check when AGHAST_MOCK_SARIF is set.
 */
export async function verifySemgrepInstalled(): Promise<void> {
  return verifySarifScannerInstalled(SEMGREP_TOOL);
}

/**
 * Execute a semgrep-compatible scanner and return raw SARIF string.
 * If the tool's mock env var is set, reads and returns that file instead.
 */
export async function runSarifScanner(
  options: SemgrepOptions,
  tool: SarifScannerTool,
): Promise<string> {
  const mockFile = process.env[tool.mockEnvVar];
  if (mockFile) {
    logDebug(tool.tag, `Mock mode: reading SARIF from ${mockFile}`);
    try {
      return await readFile(mockFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read ${tool.mockEnvVar} file: ${mockFile}`,
        { cause: err },
      );
    }
  }

  logProgress(tool.tag, `Running ${tool.displayName}...`);

  const tmpDir = await mkdtemp(join(tmpdir(), tool.tmpPrefix));
  const outputFile = join(tmpDir, 'results.sarif');

  try {
    const args = buildSemgrepArgs(options, outputFile);
    logDebug(tool.tag, `Command: ${tool.binary} ${args.join(' ')}`);

    const { stderr: stderrContent, hadError } = await new Promise<{ stderr: string; hadError: boolean }>((resolve, reject) => {
      execFile(
        tool.binary,
        args,
        { cwd: options.repositoryPath, timeout: 300_000 },
        (error, _stdout, stderr) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(
                new Error(
                  `${tool.displayName} not found. Install it from ${tool.installUrl}`,
                ),
              );
              return;
            }
            // Semgrep-compatible scanners: exit code 0 means success (with or
            // without findings), exit code 1 means an error occurred. Resolve
            // with stderr so the caller can check whether the output file was
            // actually produced.
            resolve({ stderr, hadError: true });
            return;
          }
          resolve({ stderr, hadError: false });
        },
      );
    });

    if (hadError) {
      throw new Error(
        `${tool.displayName} execution failed${stderrContent.trim() ? `: ${stderrContent.trim()}` : ''}`,
      );
    }

    const outputFileExists = await access(outputFile).then(() => true, () => false);
    if (!outputFileExists) {
      throw new Error(`${tool.displayName} did not produce output`);
    }

    const sarifContent = await readFile(outputFile, 'utf-8');
    logDebug(tool.tag, `SARIF output: ${sarifContent.length} chars`);
    return sarifContent;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      logDebug(tool.tag, `Failed to clean up temp directory ${tmpDir}: ${err}`);
    });
  }
}

/**
 * Execute Semgrep and return raw SARIF string.
 * If AGHAST_MOCK_SARIF env var is set, reads and returns that file instead.
 */
export async function runSemgrep(options: SemgrepOptions): Promise<string> {
  return runSarifScanner(options, SEMGREP_TOOL);
}
