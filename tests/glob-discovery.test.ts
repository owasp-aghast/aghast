/**
 * Unit tests for the glob-based target discovery (Spec E.2.1).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { discoverGlobTargets, globDiscovery } from '../src/discoveries/glob-discovery.js';
import type { SecurityCheck } from '../src/types.js';

/**
 * Build a small fixture tree on disk so the discovery has real files to walk.
 * Returns the absolute root path; caller is responsible for cleanup.
 */
async function buildFixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aghast-glob-'));

  const layout: Record<string, string> = {
    'src/routes/users.ts': 'export const a = 1;\nexport const b = 2;\n',
    'src/routes/posts.ts': 'export const a = 1;\n',
    'src/routes/admin/secrets.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    'src/lib/util.ts': 'export const x = 1;\n',
    'src/lib/util.js': 'module.exports = 1;\n',
    'tests/users.test.ts': 'test();\n',
    'README.md': '# readme\n',
    'node_modules/skip-me/index.ts': 'export const skip = 1;\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'empty.ts': '',
    'no-trailing-newline.ts': 'line1\nline2\nline3',
  };

  for (const [rel, content] of Object.entries(layout)) {
    const full = join(root, rel);
    // Create the parent directory tree (if any) before writing the file.
    const parts = rel.split(/[\\/]/);
    parts.pop();
    if (parts.length > 0) {
      await mkdir(join(root, parts.join('/')), { recursive: true });
    }
    await writeFile(full, content, 'utf-8');
  }

  return root;
}

describe('glob discovery: discoverGlobTargets', () => {
  let repoRoot: string;

  before(async () => {
    repoRoot = await buildFixtureRepo();
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('matches files under a nested glob', async () => {
    const targets = await discoverGlobTargets('src/routes/**/*.ts', repoRoot);
    const files = targets.map((t) => t.file).sort();
    assert.deepEqual(files, [
      'src/routes/admin/secrets.ts',
      'src/routes/posts.ts',
      'src/routes/users.ts',
    ]);
  });

  it('matches by file extension across the tree', async () => {
    const targets = await discoverGlobTargets('**/*.md', repoRoot);
    const files = targets.map((t) => t.file);
    assert.deepEqual(files, ['README.md']);
  });

  it('skips node_modules and .git automatically', async () => {
    const targets = await discoverGlobTargets('**/*.ts', repoRoot);
    const files = targets.map((t) => t.file);
    assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'should not include node_modules');
    assert.ok(!files.some((f) => f.startsWith('.git/')), 'should not include .git');
  });

  it('returns an empty array when no files match', async () => {
    const targets = await discoverGlobTargets('**/*.does-not-exist', repoRoot);
    assert.deepEqual(targets, []);
  });

  it('respects maxTargets by truncating the result set', async () => {
    const targets = await discoverGlobTargets('src/routes/**/*.ts', repoRoot, 2);
    assert.equal(targets.length, 2);
  });

  it('produces whole-file targets with startLine 1 and endLine = line count', async () => {
    const targets = await discoverGlobTargets('src/routes/admin/secrets.ts', repoRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].startLine, 1);
    // secrets.ts has 3 non-empty lines + trailing newline → 3 lines
    assert.equal(targets[0].endLine, 3);
  });

  it('handles empty files (endLine >= startLine)', async () => {
    const targets = await discoverGlobTargets('empty.ts', repoRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].startLine, 1);
    assert.ok(targets[0].endLine >= targets[0].startLine);
  });

  it('handles files without a trailing newline', async () => {
    const targets = await discoverGlobTargets('no-trailing-newline.ts', repoRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].endLine, 3);
  });

  it('attaches a label and prompt enrichment to each target', async () => {
    const targets = await discoverGlobTargets('src/routes/users.ts', repoRoot);
    assert.equal(targets.length, 1);
    assert.match(targets[0].label, /file 1\/1/);
    assert.ok(targets[0].promptEnrichment, 'should have prompt enrichment');
    assert.match(targets[0].promptEnrichment!, /TARGET FILE/);
    assert.match(targets[0].promptEnrichment!, /src\/routes\/users\.ts/);
  });

  it('returns POSIX-style relative paths even on Windows', async () => {
    const targets = await discoverGlobTargets('src/lib/*.ts', repoRoot);
    for (const t of targets) {
      assert.ok(!t.file.includes('\\'), `file path should not contain backslashes: ${t.file}`);
    }
  });

  it('throws on empty pattern', async () => {
    await assert.rejects(
      () => discoverGlobTargets('', repoRoot),
      /non-empty "glob" pattern/,
    );
  });
});

describe('glob discovery: TargetDiscovery interface', () => {
  let repoRoot: string;

  before(async () => {
    repoRoot = await buildFixtureRepo();
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('declares the expected discovery name', () => {
    assert.equal(globDiscovery.name, 'glob');
    assert.equal(globDiscovery.needsInstructions, true);
  });

  it('reads the glob pattern from check.checkTarget.glob', async () => {
    const check: SecurityCheck = {
      id: 'aghast-test',
      name: 'Test',
      repositories: [],
      checkTarget: {
        type: 'targeted',
        discovery: 'glob',
        glob: '**/*.md',
      },
    };
    const targets = await globDiscovery.discover(check, repoRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].file, 'README.md');
  });

  it('throws when checkTarget.glob is missing', async () => {
    const check: SecurityCheck = {
      id: 'aghast-test',
      name: 'Test',
      repositories: [],
      checkTarget: {
        type: 'targeted',
        discovery: 'glob',
      },
    };
    await assert.rejects(
      () => globDiscovery.discover(check, repoRoot),
      /no "glob" pattern/,
    );
  });

  it('honours maxTargets via the SecurityCheck path', async () => {
    const check: SecurityCheck = {
      id: 'aghast-test',
      name: 'Test',
      repositories: [],
      checkTarget: {
        type: 'targeted',
        discovery: 'glob',
        glob: 'src/routes/**/*.ts',
        maxTargets: 1,
      },
    };
    const targets = await globDiscovery.discover(check, repoRoot);
    assert.equal(targets.length, 1);
  });

  it('rejects empty glob via the SecurityCheck path', async () => {
    const check: SecurityCheck = {
      id: 'aghast-test',
      name: 'Test',
      repositories: [],
      checkTarget: {
        type: 'targeted',
        discovery: 'glob',
        glob: '',
      },
    };
    // SecurityCheck.checkTarget.glob === '' is falsy, so the discovery's own
    // missing-glob guard fires first and produces the same error path as a
    // truly absent pattern.
    await assert.rejects(
      () => globDiscovery.discover(check, repoRoot),
      /no "glob" pattern/,
    );
  });
});

// ─── maxTargets determinism ─────────────────────────────────────────────────

describe('glob discovery: maxTargets is deterministic across runs', () => {
  let repoRoot: string;

  before(async () => {
    repoRoot = await buildFixtureRepo();
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('truncates the SORTED match set, not the readdir order', async () => {
    // The fixture has three matches under src/routes/**/*.ts; sorted they are:
    //   src/routes/admin/secrets.ts
    //   src/routes/posts.ts
    //   src/routes/users.ts
    // With maxTargets=2 the deterministic answer is the first two of that sorted list,
    // regardless of the platform's readdir order.
    const targets = await discoverGlobTargets('src/routes/**/*.ts', repoRoot, 2);
    const files = targets.map((t) => t.file);
    assert.deepEqual(files, [
      'src/routes/admin/secrets.ts',
      'src/routes/posts.ts',
    ]);
  });

  it('returns identical results across multiple invocations', async () => {
    const a = await discoverGlobTargets('src/routes/**/*.ts', repoRoot, 2);
    const b = await discoverGlobTargets('src/routes/**/*.ts', repoRoot, 2);
    assert.deepEqual(a.map((t) => t.file), b.map((t) => t.file));
  });
});

// ─── Symlink handling ──────────────────────────────────────────────────────

describe('glob discovery: symlink handling', () => {
  let repoRoot: string;
  let symlinksCreated = false;

  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'aghast-glob-symlink-'));
    await mkdir(join(repoRoot, 'real'), { recursive: true });
    await writeFile(join(repoRoot, 'real', 'real-file.ts'), 'export const x = 1;\n', 'utf-8');
    // Symlink creation needs admin on Windows; skip those tests there.
    if (platform() !== 'win32') {
      try {
        await symlink(join(repoRoot, 'real'), join(repoRoot, 'linked-dir'), 'dir');
        await symlink(
          join(repoRoot, 'real', 'real-file.ts'),
          join(repoRoot, 'linked-file.ts'),
          'file',
        );
        symlinksCreated = true;
      } catch {
        // Insufficient permissions or unsupported FS — leave symlinksCreated false.
      }
    }
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('does not traverse symlinked directories', { skip: platform() === 'win32' }, async () => {
    if (!symlinksCreated) return;
    const targets = await discoverGlobTargets('**/*.ts', repoRoot);
    const files = targets.map((t) => t.file);
    assert.ok(
      !files.some((f) => f.startsWith('linked-dir/')),
      `should not include files under symlinked dir, got: ${files.join(', ')}`,
    );
    assert.ok(
      files.includes('real/real-file.ts'),
      'should still pick up the real file',
    );
  });

  it('does not include symlinked files', { skip: platform() === 'win32' }, async () => {
    if (!symlinksCreated) return;
    const targets = await discoverGlobTargets('**/*.ts', repoRoot);
    const files = targets.map((t) => t.file);
    assert.ok(
      !files.includes('linked-file.ts'),
      `should not include symlinked file, got: ${files.join(', ')}`,
    );
  });
});

// ─── Oversized file handling ───────────────────────────────────────────────

describe('glob discovery: oversized file handling', () => {
  let repoRoot: string;

  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'aghast-glob-oversize-'));
    // 10 MiB + 1 byte → just over the limit. Use an in-memory buffer to avoid
    // writing 11 MiB of newlines.
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 'a'.charCodeAt(0));
    await writeFile(join(repoRoot, 'huge.ts'), oversize);
    await writeFile(join(repoRoot, 'small.ts'), 'export const x = 1;\n', 'utf-8');
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('skips files larger than the size limit and keeps small ones', async () => {
    const targets = await discoverGlobTargets('*.ts', repoRoot);
    const files = targets.map((t) => t.file);
    assert.ok(files.includes('small.ts'), 'small file should be kept');
    assert.ok(!files.includes('huge.ts'), 'oversized file should be skipped');
  });
});
