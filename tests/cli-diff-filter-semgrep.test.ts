/**
 * Integration tests for diff filtering applied to Semgrep discovery.
 *
 * Spawns the actual CLI process with AGHAST_MOCK_AI=true,
 * AGHAST_MOCK_SEMGREP, AGHAST_OPENANT_DATASET, and --diff-file
 * to verify the full discovery + diff-filter pipeline end-to-end.
 * Acts as the behaviour-preservation gate for the refactor from the
 * former diff-semgrep discovery to the diffFilter cross-cutting flag.
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
const diffSemgrepDataset = resolve(testDir, 'fixtures', 'openant', 'diff-semgrep-dataset.json');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');
const noMatchDiffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-no-match.diff');
const emptyDiffFile = resolve(testDir, 'fixtures', 'diffs', 'empty.diff');

// ─── PASS scenarios ──────────────────────────────────────────────────────────

describe('CLI diff-filter (semgrep): PASS scenarios', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-semgrep-pass');
  afterEach(cleanupOutput);

  it('empty diff produces PASS (no targets)', async () => {
    const { exitCode, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
        '--diff-file', emptyDiffFile,
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].issuesFound, 0);
  });

  it('diff touching unrelated code produces PASS (no findings in scope)', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
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

// ─── Filtering scenarios ─────────────────────────────────────────────────────

describe('CLI diff-filter (semgrep): filtering', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-semgrep-filter');
  afterEach(cleanupOutput);

  it('filters findings to only those in diff scope (touched units + uncovered files)', async () => {
    // Diff touches src/auth.js lines 10-21 and config/settings.yaml (new file)
    // OpenAnt units: authenticate (1-20), validate (1-25, called by authenticate), getOrder (1-30)
    // Semgrep findings:
    //   1. src/auth.js:12-14 (in authenticate, directly touched) → INCLUDED
    //   2. src/validate.js:10-12 (in validate, flow-adjacent to authenticate) → INCLUDED
    //   3. src/orders.js:5-7 (in getOrder, not touched or flow-adjacent) → EXCLUDED
    //   4. config/settings.yaml:2-3 (uncovered file with diff changes) → INCLUDED
    //
    // So 3 findings should survive filtering → 3 targets analyzed by AI
    const { exitCode, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
        '--diff-file', diffFile,
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS'); // mock AI returns no issues
    assert.equal(checks[0].targetsAnalyzed, 3, 'Should have 3 targets after filtering');
  });

  it('stdout mentions diff filter stats', async () => {
    const { stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
        '--diff-file', diffFile,
      ],
    );

    const combined = stdout + stderr;
    assert.ok(combined.includes('units directly changed'), 'Should log directly changed units');
    assert.ok(combined.includes('in diff scope'), 'Should log diff scope filtering');
    // The scan runner must use the filter-only log wording on the semgrep path
    // (OpenAnt is running purely for the call graph; discovery doesn't use it).
    assert.ok(
      combined.includes('Running OpenAnt for diff-filter call-graph computation'),
      'Filter-only log line should identify this as the semgrep+filter path',
    );
    // And the shared-consumer line must NOT fire here (that's the openant-discovery case).
    assert.ok(
      !combined.includes('shared between discovery and diff filter'),
      'Shared-log wording should not fire when discovery is not openant',
    );
  });
});

// ─── Fallback and error scenarios ────────────────────────────────────────────

describe('CLI diff-filter (semgrep): fallback and error scenarios', () => {
  const { runCLI, cleanupOutput, readResults } = createScopedHelpers('diff-filter-semgrep-error');
  afterEach(cleanupOutput);

  it('no diff source → falls back to full-repo scan (no filter applied)', async () => {
    // Without --diff-ref/--diff-file/AGHAST_DIFF_REF, the filter is silently
    // skipped and Semgrep findings pass straight through to the AI.
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
        AGHAST_DIFF_REF: undefined,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
        // no --diff-ref or --diff-file
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS'); // mock AI returns no issues
    // All 4 SARIF findings reach the AI because the filter is skipped.
    assert.equal(checks[0].targetsAnalyzed, 4, 'Should analyze all 4 findings when no diff source is set');
    // Output should not mention the diff-filter pipeline running.
    assert.ok(!(stdout + stderr).includes('Diff filter:'), 'Diff filter should be silently skipped');
  });

  it('invalid diff file path produces ERROR check result', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
      },
      [
        fixtureRepo, '--config-dir', semgrepDiffFilterConfigDir,
        '--diff-file', '/nonexistent/path/to/diff.file',
      ],
    );

    // The check produces ERROR status (discovery fails), but CLI exits 0
    // unless --fail-on-check-failure is set
    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'ERROR');
    assert.ok(
      typeof checks[0].error === 'string' &&
      (checks[0].error.includes('diff file') || checks[0].error.includes('Failed to read')),
      'Error message should mention diff file',
    );
  });
});
