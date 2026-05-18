/**
 * Integration tests covering diff-filter triggers that live in the check JSON:
 *
 * 1. `checkTarget.diffFilter: false` → filter is bypassed even when a diff
 *    source is provided at scan time. (The primary per-check opt-out.)
 * 2. `checkTarget.diffRef: "<ref>"` → filter activates with no CLI flag or
 *    env var, using the baked-in ref. (The check-level self-activation path.)
 *
 * The second case needs a real git repo because the scan runner executes
 * `git diff <ref>` against repoPath, so the test sets one up in a temp dir.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCLI, testDir, fixtureRepo } from './cli-test-helpers.js';

const execFile = promisify(execFileCb);

const semgrepDiffOptOutConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'semgrep-diff-opt-out');
const semgrepCheckLevelDiffRefConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'semgrep-check-level-diffref');
const diffSemgrepSarif = resolve(fixtureRepo, 'diff-filter-findings.sarif');
const diffSemgrepDataset = resolve(testDir, 'fixtures', 'openant', 'diff-semgrep-dataset.json');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');

describe('CLI diff-filter: checkTarget.diffFilter: false opts a check out', () => {
  const scopedOutput = resolve(fixtureRepo, 'security_checks_results_diff-opt-out.json');

  afterEach(async () => {
    try { await rm(scopedOutput); } catch { /* fine if absent */ }
  });

  it('filter is skipped even when --diff-file is provided', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
        // Unset any inherited env var so the test deterministically exercises
        // "runtime diff source present (via --diff-file), filter suppressed by
        // check config" rather than "no diff source at all". AGHAST_DIFF_REF is
        // the only diff-related env var today (no AGHAST_DIFF_FILE); if that
        // changes, this list must grow.
        AGHAST_DIFF_REF: undefined,
      },
      [
        fixtureRepo,
        '--config-dir', semgrepDiffOptOutConfigDir,
        '--diff-file', diffFile,
        '--output', scopedOutput,
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = JSON.parse(await readFile(scopedOutput, 'utf-8')) as Record<string, unknown>;
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    // All 4 SARIF findings reach the AI because diffFilter: false opts the check out
    // of filtering, even though --diff-file was provided.
    assert.equal(checks[0].targetsAnalyzed, 4, 'diffFilter: false should bypass the filter');
    // Diff-filter log should not appear.
    const combined = stdout + stderr;
    assert.ok(!combined.includes('Diff filter:'), 'Diff filter should be skipped');
    assert.ok(!combined.includes('depth-0, no call graph'), 'Depth-0 path should also be skipped');
  });
});

describe('CLI diff-filter: check-level diffRef activates the filter', () => {
  // Build a real temp git repo so `git diff <ref>` works. The SARIF fixture
  // references src/auth.js, src/validate.js, src/orders.js, and config/settings.yaml;
  // we seed those files, commit as the base, then modify src/auth.js to simulate
  // the same change the diff-semgrep-test.diff fixture encodes.
  let tempRepo: string;
  const scopedOutput = 'security_checks_results_check-level-diffref.json';

  before(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), 'aghast-check-level-diffref-'));
    // Seed src/auth.js, src/validate.js, src/orders.js, config/settings.yaml.
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await mkdir(join(tempRepo, 'config'), { recursive: true });
    // 50-line stubs — plenty of room for the SARIF fixture's line references.
    const stubFifty = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(tempRepo, 'src', 'auth.js'), stubFifty);
    await writeFile(join(tempRepo, 'src', 'validate.js'), stubFifty);
    await writeFile(join(tempRepo, 'src', 'orders.js'), stubFifty);
    await writeFile(join(tempRepo, 'config', 'settings.yaml'), 'base: true\n');

    // Copy the SARIF fixture into the repo so sarif/semgrep mock can find it if needed.
    // (Not strictly used here since we mock Semgrep, but keeps parity with other tests.)

    const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' };
    await execFile('git', ['init', '-b', 'main'], { cwd: tempRepo });
    await execFile('git', ['add', '.'], { cwd: tempRepo });
    await execFile('git', ['commit', '-m', 'base'], { cwd: tempRepo, env });

    // Now modify src/auth.js (the file the diff ref must find a change in).
    const modified = stubFifty.split('\n');
    modified[14] = '// CHANGED line 15';
    await writeFile(join(tempRepo, 'src', 'auth.js'), modified.join('\n'));
    await execFile('git', ['add', '.'], { cwd: tempRepo });
    await execFile('git', ['commit', '-m', 'change auth.js line 15'], { cwd: tempRepo, env });
  });

  after(async () => {
    if (tempRepo) await rm(tempRepo, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Guard against before() having thrown before tempRepo was assigned —
    // without this, resolve(undefined, ...) silently produces a bogus path.
    if (!tempRepo) return;
    try {
      await rm(resolve(tempRepo, scopedOutput));
    } catch { /* fine if absent */ }
  });

  it('filter activates from the check JSON alone (no --diff-ref, no env var)', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        AGHAST_MOCK_SEMGREP: diffSemgrepSarif,
        AGHAST_OPENANT_DATASET: diffSemgrepDataset,
        AGHAST_DIFF_REF: undefined,
      },
      [
        tempRepo,
        '--config-dir', semgrepCheckLevelDiffRefConfigDir,
        '--output', resolve(tempRepo, scopedOutput),
        // Note: no --diff-ref / --diff-file. Activation comes purely from the check JSON.
      ],
    );

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    const results = JSON.parse(await readFile(resolve(tempRepo, scopedOutput), 'utf-8')) as Record<string, unknown>;
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');

    // The check JSON has diffRef: "HEAD~1". The diff between HEAD~1 and HEAD
    // touches src/auth.js line 15. Only Semgrep findings in touched units survive:
    // #1 src/auth.js:12-14 (in authenticate, directly touched) → INCLUDED
    // #2 src/validate.js:10-12 (flow-adjacent to authenticate via call graph) → INCLUDED
    // #3 src/orders.js:5-7 (no overlap, no adjacency) → EXCLUDED
    // #4 config/settings.yaml:2-3 (file not in this diff) → EXCLUDED
    assert.equal(checks[0].targetsAnalyzed, 2, 'filter should fire and narrow to 2 targets using the check-level diffRef');

    // Scan output should show the filter ran.
    const combined = stdout + stderr;
    assert.ok(combined.includes('Diff filter:'), 'Filter should have run');
  });
});

