/**
 * Integration tests for opengrep discovery through the CLI.
 *
 * Spawns the actual CLI process with AGHAST_MOCK_SARIF pointing at a SARIF
 * fixture and AGHAST_MOCK_AI=true so the full pipeline runs end-to-end without
 * an opengrep binary or an AI provider. Opengrep emits the same SARIF 2.1.0
 * format as Semgrep, so the semgrep SARIF fixtures are reused.
 *
 * Uses scoped output paths (createScopedHelpers) so this file can run in
 * parallel with cli-mock-mode.test.ts without racing on the shared fixture
 * repo's security_checks_results.json.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtureRepo,
  opengrepOnlyConfigDir,
  cli3TargetsSarif,
  emptyResultsSarif,
  createScopedHelpers,
} from './cli-test-helpers.js';

const { runCLI, cleanupOutput, readResults, outputFile } = createScopedHelpers('opengrep');

// ─── Static check: PASS when no findings ─────────────────────────────────────

describe('CLI mock mode (opengrep): static-check PASS', () => {
  afterEach(cleanupOutput);

  it('empty SARIF results produce PASS', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', opengrepOnlyConfigDir, '--output', outputFile],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks.length, 1);
    assert.equal(checks[0].checkId, 'aghast-opengrep-only');
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].issuesFound, 0);
  });
});

// ─── Static check: FAIL when findings present ────────────────────────────────

describe('CLI mock mode (opengrep): static-check FAIL', () => {
  afterEach(cleanupOutput);

  it('SARIF with 3 findings produces FAIL with 3 issues', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', opengrepOnlyConfigDir, '--output', outputFile],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].checkId, 'aghast-opengrep-only');
    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].issuesFound, 3);
  });

  it('--fail-on-check-failure flips exit code when findings present', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', opengrepOnlyConfigDir, '--fail-on-check-failure', '--output', outputFile],
    );
    assert.equal(exitCode, 1);
  });
});

// ─── ERROR: AGHAST_MOCK_SARIF points to non-existent SARIF ───────────────

describe('CLI mock mode (opengrep): ERROR scenarios', () => {
  afterEach(cleanupOutput);

  it('missing mock SARIF file produces ERROR status with AGHAST_MOCK_SARIF in error', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: '/does/not/exist/results.sarif' },
      [fixtureRepo, '--config-dir', opengrepOnlyConfigDir, '--output', outputFile],
    );

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].checkId, 'aghast-opengrep-only');
    assert.equal(checks[0].status, 'ERROR');
    assert.ok(
      (checks[0].error as string | undefined)?.includes('AGHAST_MOCK_SARIF'),
      `Expected check error to reference AGHAST_MOCK_SARIF, got: ${String(checks[0].error)}`,
    );
  });
});

// ─── Prerequisite validation: static checks don't require ANTHROPIC_API_KEY ──

describe('CLI mock mode (opengrep): conditional prerequisite validation', () => {
  afterEach(cleanupOutput);

  it('static opengrep checks succeed without ANTHROPIC_API_KEY', async () => {
    const { exitCode, stderr } = await runCLI(
      {
        ANTHROPIC_API_KEY: '',
        AGHAST_LOCAL_CLAUDE: '',
        AGHAST_MOCK_AI: '',
        AGHAST_MOCK_SARIF: emptyResultsSarif,
      },
      [fixtureRepo, '--config-dir', opengrepOnlyConfigDir, '--output', outputFile],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);
    assert.ok(!stderr.includes('ANTHROPIC_API_KEY'), 'Should not require API key for static checks');

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].checkId, 'aghast-opengrep-only');
  });
});
