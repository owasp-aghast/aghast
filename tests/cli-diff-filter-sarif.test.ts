/**
 * Integration tests for diff filtering applied to an external-SARIF discovery.
 *
 * Proves the diff-filter pipeline is decoupled from the SARIF source: the
 * sarif discovery reads a pre-generated file (no scanner runs), then the
 * scan runner applies the same diff filter used for semgrep discovery.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  testDir,
  fixtureRepo,
  sarifDiffFilterConfigDir,
  createScopedHelpers,
} from './cli-test-helpers.js';

const openantDataset = resolve(testDir, 'fixtures', 'openant', 'diff-semgrep-dataset.json');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');
const noMatchDiffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-no-match.diff');

describe('CLI diff-filter (sarif): filtering', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-sarif');
  afterEach(cleanupOutput);

  it('filters external SARIF findings to diff scope (same result as semgrep path)', async () => {
    const { exitCode, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_OPENANT_DATASET: openantDataset,
      },
      [
        fixtureRepo, '--config-dir', sarifDiffFilterConfigDir,
        '--diff-file', diffFile,
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS'); // mock AI returns no issues
    assert.equal(checks[0].targetsAnalyzed, 3, 'Should have 3 targets after filtering');
  });

  it('diff not overlapping any finding yields PASS with 0 targets', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_OPENANT_DATASET: openantDataset,
      },
      [
        fixtureRepo, '--config-dir', sarifDiffFilterConfigDir,
        '--diff-file', noMatchDiffFile,
      ],
    );

    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 0);
  });
});
