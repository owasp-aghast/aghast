/**
 * Opengrep runner.
 * Executes Opengrep (https://github.com/opengrep/opengrep) against a repository
 * and returns raw SARIF output. Opengrep is a community fork of Semgrep with
 * a drop-in-compatible CLI and SARIF 2.1.0 output, so this module is a thin
 * wrapper around the shared helpers in `./semgrep-runner.ts`.
 */

import type { SarifScannerTool, SemgrepOptions } from './semgrep-runner.js';
import { runSarifScanner, verifySarifScannerInstalled } from './semgrep-runner.js';

export type OpengrepOptions = SemgrepOptions;

export const OPENGREP_TOOL: SarifScannerTool = {
  binary: 'opengrep',
  mockEnvVar: 'AGHAST_MOCK_SARIF',
  tag: 'opengrep',
  displayName: 'Opengrep',
  installUrl: 'https://github.com/opengrep/opengrep',
  tmpPrefix: 'aghast-opengrep-',
};

/**
 * Verify that Opengrep is installed and available on PATH.
 * Skips the check when AGHAST_MOCK_SARIF is set.
 */
export async function verifyOpengrepInstalled(): Promise<void> {
  return verifySarifScannerInstalled(OPENGREP_TOOL);
}

/**
 * Execute Opengrep and return raw SARIF string.
 * If AGHAST_MOCK_SARIF env var is set, reads and returns that file instead.
 */
export async function runOpengrep(options: OpengrepOptions): Promise<string> {
  return runSarifScanner(options, OPENGREP_TOOL);
}
