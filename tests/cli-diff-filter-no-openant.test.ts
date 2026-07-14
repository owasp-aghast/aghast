/**
 * Integration tests for the depth-0 diff-filter fallback when OpenAnt is
 * unavailable.
 *
 * Exercised via AGHAST_TESTING_OPENANT_UNAVAILABLE=true, which forces
 * verifyOpenAntInstalled to throw — the same observable behaviour as running
 * a scan on a machine without OpenAnt installed, but deterministic across
 * platforms and irrespective of whether OpenAnt happens to be on PATH.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  testDir,
  fixtureRepo,
  semgrepDiffFilterConfigDir,
  createScopedHelpers,
} from './cli-test-helpers.js';

// Same fixture the sarif-diff-filter config uses (single source of truth);
// sarif discovery resolves its sarifFile path relative to repoPath so the file
// must live in the repo directory, and re-using it here avoids a stale-copy hazard.
const diffSemgrepSarif = resolve(fixtureRepo, 'diff-filter-findings.sarif');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');

describe('CLI diff-filter fallback when OpenAnt is unavailable', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-no-openant');
  afterEach(cleanupOutput);

  it('emits a clear warning log when falling back to depth-0 mode', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SARIF: diffSemgrepSarif,
        AGHAST_TESTING_OPENANT_UNAVAILABLE: 'true',
        // Note: no AGHAST_OPENANT_DATASET, so the install check runs and fails.
      },
      [fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir, '--diff-file', diffFile],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const combined = stdout + stderr;

    // The fallback warning must be loud and clear so users notice the mode switch.
    assert.ok(
      combined.includes('depth-0 mode'),
      `fallback warning should mention "depth-0 mode"; got: ${combined}`,
    );
    assert.ok(
      combined.includes('OpenAnt is not installed'),
      'fallback warning should explain why (OpenAnt is not installed)',
    );
    assert.ok(
      combined.includes('callers/callees') || combined.includes('call-graph'),
      'fallback warning should note the missing call-graph flow',
    );
    assert.ok(
      combined.includes('AGHAST_OPENANT_DATASET') || combined.includes('Install OpenAnt'),
      'fallback warning should tell the user how to get depth-1 filtering',
    );
  });

  it('depth-0 mode narrows Semgrep findings by file + line overlap only', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SARIF: diffSemgrepSarif,
        AGHAST_TESTING_OPENANT_UNAVAILABLE: 'true',
      },
      [fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir, '--diff-file', diffFile],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    // The diff-semgrep-test.diff fixture touches src/auth.js and config/settings.yaml.
    // Findings (from the shared SARIF fixture): src/auth.js:12-14, src/validate.js:10-12,
    //   src/orders.js:5-7, config/settings.yaml:2-3.
    // Depth-1 would also grab src/validate.js (flow-adjacent to authenticate); depth-0
    // drops it because validate.js itself isn't in the diff.
    assert.equal(
      checks[0].targetsAnalyzed,
      2,
      'depth-0 should keep 2 targets (src/auth.js + config/settings.yaml); depth-1 would keep 3',
    );

    // The depth-0-specific progress line should appear.
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('depth-0, no call graph'),
      `output should identify the depth-0 filter run; got: ${combined}`,
    );
  });

  it('no diff source + OpenAnt unavailable still runs a clean full-repo scan (no fallback log)', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SARIF: diffSemgrepSarif,
        AGHAST_TESTING_OPENANT_UNAVAILABLE: 'true',
        AGHAST_DIFF_REF: undefined,
      },
      [fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir],
    );

    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    // No filter runs at all — all 4 SARIF findings reach the AI.
    assert.equal(checks[0].targetsAnalyzed, 4);

    const combined = stdout + stderr;
    // The fallback log only fires when diff filtering would apply, which it doesn't here.
    assert.ok(
      !combined.includes('depth-0 mode'),
      'fallback warning should not fire when no diff filter runs',
    );
  });
});
