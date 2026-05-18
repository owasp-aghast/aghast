/**
 * Integration tests for diff filtering applied to OpenAnt discovery.
 *
 * The scan runner should run OpenAnt exactly once per check and share
 * the dataset between discovery (which produces units as targets) and
 * the diff filter (which narrows those units to diff scope).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  testDir,
  fixtureRepo,
  openantDiffFilterConfigDir,
  createScopedHelpers,
} from './cli-test-helpers.js';

const openantDataset = resolve(testDir, 'fixtures', 'openant', 'diff-semgrep-dataset.json');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');

describe('CLI diff-filter (openant): filtering', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-openant');
  afterEach(cleanupOutput);

  it('openant discovery output gets diff-filtered when a diff source is available', async () => {
    // The fixture dataset has 3 units. The diff touches src/auth.js (line range of
    // authenticate) and a config file. Touched units via direct overlap + 1 call-
    // graph hop: authenticate + validate. The third unit (getOrder) is out of scope.
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_OPENANT_DATASET: openantDataset,
      },
      [
        fixtureRepo, '--config-dir', openantDiffFilterConfigDir,
        '--diff-file', diffFile,
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS'); // mock AI returns no issues

    // Discovery alone would return 3 units. With diff filter on, 2 survive.
    assert.equal(checks[0].targetsAnalyzed, 2, 'Diff filter should narrow to 2 touched units');

    const combined = stdout + stderr;
    assert.ok(combined.includes('Diff filter:'), 'Diff filter should have run');
  });

  it('OpenAnt is invoked only once when discovery + filter both need it', async () => {
    // The "Running OpenAnt" log line fires once per runOpenAnt invocation.
    // With the dataset-sharing optimization, discovery and filter should share
    // one invocation, so exactly one such line should appear for the check.
    const { stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_OPENANT_DATASET: openantDataset,
      },
      [
        fixtureRepo, '--config-dir', openantDiffFilterConfigDir,
        '--diff-file', diffFile,
      ],
    );

    const combined = stdout + stderr;
    // Scan runner logs a specific "shared between discovery and diff filter" line
    // in the one case we care about here (openant discovery + filter).
    const sharedLogCount = (combined.match(/Running OpenAnt once \(shared between discovery and diff filter\)/g) ?? []).length;
    assert.equal(sharedLogCount, 1, 'Scan runner should log the shared OpenAnt invocation exactly once');
    // Sanity: the generic filter-only log line must NOT fire for this openant path.
    assert.ok(
      !combined.includes('Running OpenAnt for diff-filter call-graph'),
      'filter-only log should not fire when discovery is openant',
    );
  });

  it('openant discovery without a diff source runs full (no filter)', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_OPENANT_DATASET: openantDataset,
      },
      [
        fixtureRepo, '--config-dir', openantDiffFilterConfigDir,
        // no --diff-ref / --diff-file
      ],
    );

    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 3, 'All 3 units analyzed when no diff source');
    assert.ok(!(stdout + stderr).includes('Diff filter:'), 'Diff filter should not run');
  });
});
