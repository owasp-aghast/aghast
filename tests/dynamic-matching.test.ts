/**
 * Unit tests for dynamic repository matching and check ordering (issue #122).
 *
 * Covers:
 *   - repo-scan.scanRepository / evaluateMatchCriteria / cache
 *   - check-library.filterChecksForRepositoryAsync — explicit + criteria
 *   - check-library.sortChecksByPriority — stable, undefined-last
 *   - registry validation rejects malformed matchCriteria / priority
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadCheckRegistry,
  filterChecksForRepository,
  filterChecksForRepositoryAsync,
  sortChecksByPriority,
} from '../src/check-library.js';
import {
  scanRepository,
  evaluateMatchCriteria,
  getRepoSnapshot,
  clearRepoSnapshotCache,
} from '../src/repo-scan.js';
import type { SecurityCheck } from '../src/types.js';

function makeCheck(overrides: Partial<SecurityCheck> = {}): SecurityCheck {
  return {
    id: 'test',
    name: 'Test',
    repositories: [],
    ...overrides,
  };
}

/** Build a synthetic repo on disk under a temp directory. */
async function makeRepo(layout: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aghast-dyn-'));
  for (const [rel, contents] of Object.entries(layout)) {
    const full = join(dir, rel);
    await mkdir(resolve(full, '..'), { recursive: true });
    await writeFile(full, contents, 'utf-8');
  }
  return dir;
}

// ─── repo-scan.scanRepository ────────────────────────────────────────────────

describe('scanRepository', () => {
  let repo: string;
  before(async () => {
    repo = await makeRepo({
      'package.json': '{}',
      'src/app.ts': 'export {};',
      'src/api/users.ts': 'export {};',
      'README.md': '# repo',
      'node_modules/foo/index.js': '/* should be ignored */',
      '.git/HEAD': 'ref: refs/heads/main',
      'dist/bundle.js': '/* should be ignored */',
    });
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    clearRepoSnapshotCache();
  });

  it('collects files relative to repo with forward slashes', async () => {
    const snap = await scanRepository(repo);
    assert.ok(snap.files.includes('package.json'));
    assert.ok(snap.files.includes('src/app.ts'));
    assert.ok(snap.files.includes('src/api/users.ts'));
  });

  it('skips default-ignored directories', async () => {
    const snap = await scanRepository(repo);
    assert.ok(!snap.files.some((f) => f.startsWith('node_modules/')));
    assert.ok(!snap.files.some((f) => f.startsWith('.git/')));
    assert.ok(!snap.files.some((f) => f.startsWith('dist/')));
  });

  it('records file extensions, lowercased', async () => {
    const snap = await scanRepository(repo);
    assert.ok(snap.extensions.has('.ts'));
    assert.ok(snap.extensions.has('.json'));
    assert.ok(snap.extensions.has('.md'));
  });
});

describe('repo-scan tags loading', () => {
  it('reads tags from .aghast-tags', async () => {
    const repo = await makeRepo({
      'package.json': '{}',
      '.aghast-tags': 'backend\napi-service\n# comment line\n',
    });
    try {
      const snap = await scanRepository(repo);
      assert.ok(snap.tags.has('backend'));
      assert.ok(snap.tags.has('api-service'));
      // Comment lines should NOT be tags
      assert.ok(!snap.tags.has('# comment line'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reads tags from .aghast.json `tags` array', async () => {
    const repo = await makeRepo({
      '.aghast.json': JSON.stringify({ tags: ['frontend', 'react'] }),
    });
    try {
      const snap = await scanRepository(repo);
      assert.ok(snap.tags.has('frontend'));
      assert.ok(snap.tags.has('react'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('merges tags from both sources', async () => {
    const repo = await makeRepo({
      '.aghast-tags': 'backend',
      '.aghast.json': JSON.stringify({ tags: ['api-service'] }),
    });
    try {
      const snap = await scanRepository(repo);
      assert.ok(snap.tags.has('backend'));
      assert.ok(snap.tags.has('api-service'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('tolerates malformed .aghast.json (no throw)', async () => {
    const repo = await makeRepo({
      '.aghast.json': 'not json',
      'package.json': '{}',
    });
    try {
      const snap = await scanRepository(repo);
      assert.equal(snap.tags.size, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// ─── evaluateMatchCriteria ───────────────────────────────────────────────────

describe('evaluateMatchCriteria', () => {
  let repo: string;
  before(async () => {
    repo = await makeRepo({
      'package.json': '{}',
      'src/api/users.ts': 'x',
      'src/routes/login.ts': 'x',
      'README.md': '#',
      '.aghast-tags': 'backend\napi-service',
    });
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    clearRepoSnapshotCache();
  });

  it('hasFileTypes matches when at least one extension is present', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ hasFileTypes: ['.ts'] }, snap), true);
    assert.equal(evaluateMatchCriteria({ hasFileTypes: ['.go'] }, snap), false);
    // First match in list wins
    assert.equal(evaluateMatchCriteria({ hasFileTypes: ['.go', '.ts'] }, snap), true);
  });

  it('hasFileTypes accepts entries without leading dot', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ hasFileTypes: ['ts'] }, snap), true);
  });

  it('hasFiles matches literal paths', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ hasFiles: ['package.json'] }, snap), true);
    assert.equal(evaluateMatchCriteria({ hasFiles: ['missing.txt'] }, snap), false);
  });

  it('hasFiles requires ALL listed entries to be present', async () => {
    const snap = await scanRepository(repo);
    assert.equal(
      evaluateMatchCriteria({ hasFiles: ['package.json', 'README.md'] }, snap),
      true,
    );
    assert.equal(
      evaluateMatchCriteria({ hasFiles: ['package.json', 'missing.txt'] }, snap),
      false,
    );
  });

  it('hasFiles falls back to glob matching', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ hasFiles: ['src/api/*.ts'] }, snap), true);
  });

  it('hasPaths matches if any glob hits any file', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ hasPaths: ['src/api/**'] }, snap), true);
    assert.equal(evaluateMatchCriteria({ hasPaths: ['src/missing/**'] }, snap), false);
    // OR semantics across globs
    assert.equal(
      evaluateMatchCriteria({ hasPaths: ['src/missing/**', 'src/routes/**'] }, snap),
      true,
    );
  });

  it('tags requires ALL listed tags', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({ tags: ['backend'] }, snap), true);
    assert.equal(
      evaluateMatchCriteria({ tags: ['backend', 'api-service'] }, snap),
      true,
    );
    assert.equal(
      evaluateMatchCriteria({ tags: ['backend', 'missing'] }, snap),
      false,
    );
  });

  it('combines criteria with AND', async () => {
    const snap = await scanRepository(repo);
    assert.equal(
      evaluateMatchCriteria(
        { hasFileTypes: ['.ts'], tags: ['backend'] },
        snap,
      ),
      true,
    );
    assert.equal(
      evaluateMatchCriteria(
        { hasFileTypes: ['.ts'], tags: ['missing'] },
        snap,
      ),
      false,
    );
  });

  it('empty criteria object matches nothing', async () => {
    const snap = await scanRepository(repo);
    assert.equal(evaluateMatchCriteria({}, snap), false);
  });
});

// ─── snapshot cache ──────────────────────────────────────────────────────────

describe('getRepoSnapshot caching', () => {
  it('returns the same snapshot for repeated calls (single walk)', async () => {
    const repo = await makeRepo({ 'a.ts': '' });
    try {
      clearRepoSnapshotCache();
      const a = await getRepoSnapshot(resolve(repo));
      const b = await getRepoSnapshot(resolve(repo));
      assert.strictEqual(a, b, 'cache hit should reuse the same object');
    } finally {
      await rm(repo, { recursive: true, force: true });
      clearRepoSnapshotCache();
    }
  });

  it('populates the cache after the first call (positive guard)', async () => {
    const { __peekSnapshotCacheForTesting } = await import('../src/repo-scan.js');
    const repo = await makeRepo({ 'a.ts': '' });
    try {
      clearRepoSnapshotCache();
      assert.equal(
        __peekSnapshotCacheForTesting(resolve(repo)),
        undefined,
        'cache should be empty after clear',
      );
      await getRepoSnapshot(resolve(repo));
      assert.notEqual(
        __peekSnapshotCacheForTesting(resolve(repo)),
        undefined,
        'cache should be populated after first call',
      );
      clearRepoSnapshotCache();
      assert.equal(
        __peekSnapshotCacheForTesting(resolve(repo)),
        undefined,
        'cache should be empty after clear again',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
      clearRepoSnapshotCache();
    }
  });

  it('a fresh scan replaces the cached snapshot after clearRepoSnapshotCache (same code path the eviction-on-rejection guard relies on)', async () => {
    // scanRepository currently swallows per-entry errors and always resolves,
    // so we cannot easily provoke a real rejection to exercise the
    // eviction-on-rejection guard in getRepoSnapshot directly. Instead we
    // verify the same code path the guard relies on: after the cache is
    // cleared, a subsequent getRepoSnapshot returns a freshly walked
    // snapshot (a different object reference) rather than re-using the
    // previous one.
    clearRepoSnapshotCache();
    const repo = await makeRepo({ 'a.ts': '' });
    try {
      // First call succeeds and populates the cache.
      const first = await getRepoSnapshot(resolve(repo));
      assert.ok(first.files.includes('a.ts'));
      // Second call returns the cached promise (same object).
      const second = await getRepoSnapshot(resolve(repo));
      assert.strictEqual(second, first);
      // Clearing wipes the cache so a third call gets a fresh scan.
      clearRepoSnapshotCache();
      const third = await getRepoSnapshot(resolve(repo));
      assert.notStrictEqual(third, first, 'after clear, expect a freshly walked snapshot');
      assert.ok(third.files.includes('a.ts'));
    } finally {
      await rm(repo, { recursive: true, force: true });
      clearRepoSnapshotCache();
    }
  });
});

// ─── filterChecksForRepository (sync) — backward compatibility ──────────────

describe('filterChecksForRepository (sync) — backward compat', () => {
  it('ignores matchCriteria entirely', () => {
    const checks = [
      makeCheck({
        id: 'criteria-only',
        repositories: [],
        matchCriteria: { hasFileTypes: ['.ts'] },
      }),
    ];
    // The sync function applies the existing "empty repositories matches all"
    // rule and does not consult matchCriteria. Behavior unchanged.
    const out = filterChecksForRepository(checks, 'org/repo');
    assert.equal(out.length, 1);
  });
});

// ─── filterChecksForRepositoryAsync ─────────────────────────────────────────

describe('filterChecksForRepositoryAsync', () => {
  let repo: string;
  before(async () => {
    repo = await makeRepo({
      'package.json': '{}',
      'src/api/users.ts': 'x',
      '.aghast-tags': 'backend',
    });
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    clearRepoSnapshotCache();
  });

  it('explicit repository match still wins regardless of matchCriteria', async () => {
    const checks = [
      makeCheck({
        id: 'explicit',
        repositories: ['org/foo'],
        matchCriteria: { hasFileTypes: ['.go'] }, // would not match
      }),
    ];
    const out = await filterChecksForRepositoryAsync(checks, 'org/foo', repo);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'explicit');
  });

  it('adds matches via matchCriteria when explicit list does not match', async () => {
    const checks = [
      makeCheck({
        id: 'criteria',
        repositories: ['some/other-repo'], // explicit list does not include our repo
        matchCriteria: { hasFileTypes: ['.ts'] },
      }),
    ];
    const out = await filterChecksForRepositoryAsync(
      checks,
      'org/unrelated',
      repo,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'criteria');
  });

  it('omits checks whose criteria do not match', async () => {
    const checks = [
      makeCheck({
        id: 'no-match',
        repositories: ['some/other-repo'],
        matchCriteria: { hasFileTypes: ['.go'] },
      }),
    ];
    const out = await filterChecksForRepositoryAsync(
      checks,
      'org/unrelated',
      repo,
    );
    assert.equal(out.length, 0);
  });

  it('skips disabled checks even if criteria match', async () => {
    const checks = [
      makeCheck({
        id: 'disabled',
        repositories: ['some/other-repo'],
        matchCriteria: { hasFileTypes: ['.ts'] },
        enabled: false,
      }),
    ];
    const out = await filterChecksForRepositoryAsync(checks, 'org/x', repo);
    assert.equal(out.length, 0);
  });

  it('does NOT trigger a filesystem walk when no check has matchCriteria', async () => {
    const checks = [makeCheck({ id: 'a', repositories: ['org/foo'] })];
    // Use a path that does not exist; the function must not try to scan it.
    const fakeRepo = '/aghast/no/such/path/__missing__';
    const out = await filterChecksForRepositoryAsync(
      checks,
      'org/foo',
      fakeRepo,
    );
    assert.equal(out.length, 1);
  });

  it('uses tags via .aghast-tags', async () => {
    const checks = [
      makeCheck({
        id: 'tagged',
        repositories: ['some/other-repo'],
        matchCriteria: { tags: ['backend'] },
      }),
    ];
    const out = await filterChecksForRepositoryAsync(
      checks,
      'org/unrelated',
      repo,
    );
    assert.equal(out.length, 1);
  });

  it('produces identical output to sync filter for legacy registries (no matchCriteria)', async () => {
    // Backward-compat guard: a registry without any matchCriteria should
    // give the same result through the async path as through the sync one.
    const checks: SecurityCheck[] = [
      makeCheck({ id: 'a', repositories: ['org/foo'] }),
      makeCheck({ id: 'b', repositories: [] }),
      makeCheck({ id: 'c', repositories: ['org/bar'], enabled: false }),
      makeCheck({ id: 'd', repositories: ['some/other'] }),
    ];
    const sync = filterChecksForRepository(checks, 'org/foo');
    const asyncOut = await filterChecksForRepositoryAsync(
      checks,
      'org/foo',
      // Use a path that does not exist; the function must not try to scan
      // it because no check has matchCriteria.
      '/aghast/no/such/path/__legacy_test__',
    );
    assert.deepEqual(
      asyncOut.map((c) => c.id),
      sync.map((c) => c.id),
    );
  });
});

// ─── sortChecksByPriority ───────────────────────────────────────────────────

describe('sortChecksByPriority', () => {
  it('sorts ascending by priority', () => {
    const checks = [
      makeCheck({ id: 'b', priority: 10 }),
      makeCheck({ id: 'a', priority: 1 }),
      makeCheck({ id: 'c', priority: 5 }),
    ];
    const sorted = sortChecksByPriority(checks);
    assert.deepEqual(
      sorted.map((c) => c.id),
      ['a', 'c', 'b'],
    );
  });

  it('checks without priority sort to the end', () => {
    const checks = [
      makeCheck({ id: 'no1' }),
      makeCheck({ id: 'p2', priority: 2 }),
      makeCheck({ id: 'no2' }),
      makeCheck({ id: 'p1', priority: 1 }),
    ];
    const sorted = sortChecksByPriority(checks);
    assert.deepEqual(
      sorted.map((c) => c.id),
      ['p1', 'p2', 'no1', 'no2'],
    );
  });

  it('is stable for equal priorities and for both-undefined', () => {
    const checks = [
      makeCheck({ id: 'first' }),
      makeCheck({ id: 'second' }),
      makeCheck({ id: 'third' }),
      makeCheck({ id: 'p1a', priority: 1 }),
      makeCheck({ id: 'p1b', priority: 1 }),
    ];
    const sorted = sortChecksByPriority(checks);
    assert.deepEqual(
      sorted.map((c) => c.id),
      ['p1a', 'p1b', 'first', 'second', 'third'],
    );
  });

  it('does not mutate the input', () => {
    const checks = [
      makeCheck({ id: 'b', priority: 2 }),
      makeCheck({ id: 'a', priority: 1 }),
    ];
    const before = checks.map((c) => c.id).join(',');
    sortChecksByPriority(checks);
    const after = checks.map((c) => c.id).join(',');
    assert.equal(before, after);
  });

  it('preserves original order when no check has a priority (legacy registry)', () => {
    // Backward-compat guard: configs without priority should not have their
    // execution order shuffled by the new sortChecksByPriority pass.
    const checks = [
      makeCheck({ id: 'one' }),
      makeCheck({ id: 'two' }),
      makeCheck({ id: 'three' }),
      makeCheck({ id: 'four' }),
    ];
    const sorted = sortChecksByPriority(checks);
    assert.deepEqual(
      sorted.map((c) => c.id),
      ['one', 'two', 'three', 'four'],
    );
  });
});

// ─── scanRepository caps ─────────────────────────────────────────────────────

describe('scanRepository caps (test-only knobs)', () => {
  it('truncates at maxFiles and still returns a usable snapshot', async () => {
    const repo = await makeRepo({
      'a.ts': '',
      'b.ts': '',
      'c.ts': '',
      'd.ts': '',
      'e.ts': '',
    });
    try {
      const snap = await scanRepository(repo, { maxFiles: 2 });
      // The first two files are inspected; the rest are dropped silently.
      assert.equal(snap.files.length, 2);
      // Even with truncation, file extensions seen so far are recorded.
      assert.ok(snap.extensions.has('.ts'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('truncates at maxDepth and skips deeper subtrees', async () => {
    // Build nested directory tree: lvl0/lvl1/lvl2/lvl3/file.ts
    const repo = await makeRepo({
      'top.ts': '',
      'lvl1/lvl2/lvl3/deep.ts': '',
    });
    try {
      // maxDepth=1 lets us see top.ts and the lvl1 directory's immediate
      // contents, but not anything past lvl1/lvl2/...
      const snap = await scanRepository(repo, { maxDepth: 1 });
      assert.ok(snap.files.includes('top.ts'));
      assert.ok(!snap.files.some((f) => f.includes('deep.ts')),
        `deep.ts should be truncated, got: ${JSON.stringify(snap.files)}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// ─── registry validation ────────────────────────────────────────────────────

describe('loadCheckRegistry — matchCriteria + priority validation', () => {
  it('accepts valid matchCriteria and priority', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [
            {
              id: 'a',
              repositories: [],
              matchCriteria: {
                hasFileTypes: ['.ts'],
                hasFiles: ['package.json'],
                hasPaths: ['src/**'],
                tags: ['backend'],
              },
              priority: 5,
            },
          ],
        }),
        'utf-8',
      );
      const reg = await loadCheckRegistry(dir);
      assert.equal(reg.checks[0].priority, 5);
      assert.deepEqual(reg.checks[0].matchCriteria?.hasFileTypes, ['.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects priority that is not a non-negative integer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [{ id: 'a', repositories: [], priority: -1 }],
        }),
      );
      await assert.rejects(
        loadCheckRegistry(dir),
        /priority must be a non-negative integer/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-integer priority', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [{ id: 'a', repositories: [], priority: 1.5 }],
        }),
      );
      await assert.rejects(
        loadCheckRegistry(dir),
        /priority must be a non-negative integer/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects matchCriteria that is not an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [{ id: 'a', repositories: [], matchCriteria: 'oops' }],
        }),
      );
      await assert.rejects(
        loadCheckRegistry(dir),
        /matchCriteria must be an object/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown matchCriteria fields (catches typos)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [
            { id: 'a', repositories: [], matchCriteria: { hasFileType: ['.ts'] } },
          ],
        }),
      );
      await assert.rejects(
        loadCheckRegistry(dir),
        /matchCriteria has unknown field/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects matchCriteria array fields with non-string entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [
            { id: 'a', repositories: [], matchCriteria: { hasFileTypes: [42] } },
          ],
        }),
      );
      await assert.rejects(
        loadCheckRegistry(dir),
        /matchCriteria\.hasFileTypes\[0\] must be a string/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omitting both fields preserves backward compatibility', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aghast-reg-'));
    try {
      await writeFile(
        join(dir, 'checks-config.json'),
        JSON.stringify({
          checks: [{ id: 'a', repositories: ['org/repo'], enabled: true }],
        }),
      );
      const reg = await loadCheckRegistry(dir);
      assert.equal(reg.checks[0].priority, undefined);
      assert.equal(reg.checks[0].matchCriteria, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
