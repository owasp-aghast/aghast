/**
 * Unit tests for applyDiffFilter.
 *
 * Uses AGHAST_OPENANT_DATASET to stub the OpenAnt runner with a fixture dataset,
 * then verifies that a synthetic DiscoveredTarget[] is filtered down to only
 * the targets whose file:line overlaps a touched unit (or an uncovered file
 * in the diff).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDiffFilter } from '../src/diff-filter.js';
import type { DiscoveredTarget } from '../src/discovery.js';
import type { SecurityCheck } from '../src/types.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const openantDataset = resolve(testDir, 'fixtures', 'openant', 'diff-semgrep-dataset.json');
const diffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-test.diff');
const noMatchDiffFile = resolve(testDir, 'fixtures', 'diffs', 'diff-semgrep-no-match.diff');
const emptyDiffFile = resolve(testDir, 'fixtures', 'diffs', 'empty.diff');

const baseCheck: SecurityCheck = {
  id: 'diff-filter-unit-test',
  name: 'diff-filter-unit-test',
  repositories: [],
  checkTarget: { type: 'targeted', discovery: 'semgrep' },
};

function makeTarget(file: string, startLine: number, endLine: number, idx: number, total: number): DiscoveredTarget {
  return {
    file,
    startLine,
    endLine,
    label: `[target ${idx}/${total}]`,
    message: `finding at ${file}:${startLine}`,
    promptEnrichment: '\n\nTARGET LOCATION: analyze this.',
  };
}

// The fixture dataset (tests/fixtures/openant/diff-semgrep-dataset.json) defines:
//   authenticate (src/auth.js:1-20)   — directly touched by diff (lines 10-21)
//   validate     (src/validate.js:1-25) — callee of authenticate (flow-adjacent)
//   getOrder     (src/orders.js:1-30)  — not touched, not flow-adjacent
// The diff also touches config/settings.yaml, which has no OpenAnt units (uncovered file).
const TARGETS: DiscoveredTarget[] = [
  makeTarget('src/auth.js', 12, 14, 1, 4),       // inside authenticate → kept
  makeTarget('src/validate.js', 10, 12, 2, 4),    // inside validate (flow-adjacent) → kept
  makeTarget('src/orders.js', 5, 7, 3, 4),        // inside getOrder, not in scope → filtered out
  makeTarget('config/settings.yaml', 2, 3, 4, 4), // uncovered file, in diff → kept
];

describe('applyDiffFilter', () => {
  const originalMockOpenant = process.env.AGHAST_OPENANT_DATASET;
  before(() => { process.env.AGHAST_OPENANT_DATASET = openantDataset; });
  after(() => {
    if (originalMockOpenant === undefined) delete process.env.AGHAST_OPENANT_DATASET;
    else process.env.AGHAST_OPENANT_DATASET = originalMockOpenant;
  });

  it('empty diff returns no targets', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile: emptyDiffFile });
    assert.deepEqual(out, []);
  });

  it('diff touching unrelated code filters out all targets', async () => {
    // diff-semgrep-no-match.diff only touches src/unrelated.js, which has no
    // OpenAnt units and isn't referenced by any target. All targets are out of scope.
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile: noMatchDiffFile });
    assert.equal(out.length, 0);
  });

  it('filters input targets to those inside touched units or uncovered diff files', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile });
    assert.equal(out.length, 3, 'should keep 3 targets (authenticate, validate, uncovered yaml)');
    const files = out.map(t => t.file).sort();
    assert.deepEqual(files, ['config/settings.yaml', 'src/auth.js', 'src/validate.js']);
  });

  it('reindexes labels after filtering', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile });
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].label, `[target ${i + 1}/${out.length}]`);
    }
  });

  it('appends a diff-scope note to each surviving target prompt', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile });
    for (const t of out) {
      assert.ok(t.promptEnrichment?.includes('diff filtering'), `missing diff note in: ${t.promptEnrichment}`);
      // Original enrichment preserved
      assert.ok(t.promptEnrichment?.includes('TARGET LOCATION'), 'original enrichment should be preserved');
    }
  });

  it('throws defensively when called with no diff source (scan runner should gate this)', async () => {
    await assert.rejects(
      () => applyDiffFilter(baseCheck, TARGETS, '/irrelevant', {}),
      (err: Error) => {
        assert.ok(err.message.includes('no diff source'), `should mention missing source: ${err.message}`);
        return true;
      },
    );
  });

  it('empty target list short-circuits cleanly', async () => {
    const out = await applyDiffFilter(baseCheck, [], '/irrelevant', { diffFile });
    assert.deepEqual(out, []);
  });
});

describe('applyDiffFilter (depth-0 fallback)', () => {
  // depth-0 path never invokes OpenAnt, so AGHAST_OPENANT_DATASET doesn't need
  // to be set for these cases.

  it('keeps only targets whose file + line range overlap the diff', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile, depthZero: true });
    // Diff touches src/auth.js lines 10-21 and config/settings.yaml (whole file).
    // Only targets in those files with overlapping lines survive (no call-graph flow).
    //   authenticate target     src/auth.js:12-14       ✓ overlaps diff
    //   validate target         src/validate.js:10-12   ✗ file not in diff (no flow adjacency)
    //   getOrder target         src/orders.js:5-7        ✗ file not in diff
    //   yaml target             config/settings.yaml:2-3 ✓ file in diff
    assert.equal(out.length, 2, 'depth-0 should keep 2 targets (no call-graph flow)');
    const files = out.map(t => t.file).sort();
    assert.deepEqual(files, ['config/settings.yaml', 'src/auth.js']);
  });

  it('empty diff returns no targets (depth-0)', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile: emptyDiffFile, depthZero: true });
    assert.deepEqual(out, []);
  });

  it('diff touching unrelated code returns no targets (depth-0)', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile: noMatchDiffFile, depthZero: true });
    assert.equal(out.length, 0);
  });

  it('reindexes labels and appends diff-scope note (depth-0)', async () => {
    const out = await applyDiffFilter(baseCheck, TARGETS, '/irrelevant', { diffFile, depthZero: true });
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].label, `[target ${i + 1}/${out.length}]`);
      assert.ok(out[i].promptEnrichment?.includes('diff filtering'), 'diff note should be appended');
      assert.ok(out[i].promptEnrichment?.includes('TARGET LOCATION'), 'original enrichment preserved');
    }
  });
});
