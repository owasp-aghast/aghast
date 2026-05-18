import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, loadDiffFromFile } from '../src/diff-parser.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const sampleDiff = resolve(testDir, 'fixtures', 'diffs', 'sample.diff');

describe('diff-parser', () => {
  describe('parseDiff', () => {
    it('should parse hunks from a modified file', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      // src/auth.js has two hunks
      const authHunks = result.get('src/auth.js');
      assert.ok(authHunks, 'should have hunks for src/auth.js');
      assert.equal(authHunks.length, 2);

      // First hunk: @@ -10,6 +10,12 @@ → lines 10-21
      assert.equal(authHunks[0].startLine, 10);
      assert.equal(authHunks[0].endLine, 21);

      // Second hunk: @@ -25,3 +31,8 @@ → lines 31-38
      assert.equal(authHunks[1].startLine, 31);
      assert.equal(authHunks[1].endLine, 38);
    });

    it('should parse a single-line change', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      // src/orders.js has one hunk: @@ -5,7 +5,7 @@ → lines 5-11
      const ordersHunks = result.get('src/orders.js');
      assert.ok(ordersHunks, 'should have hunks for src/orders.js');
      assert.equal(ordersHunks.length, 1);
      assert.equal(ordersHunks[0].startLine, 5);
      assert.equal(ordersHunks[0].endLine, 11);
    });

    it('should handle new files (entire file is changed)', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      const configHunks = result.get('config/settings.yaml');
      assert.ok(configHunks, 'should have hunks for new file');
      assert.equal(configHunks.length, 1);
      assert.equal(configHunks[0].startLine, 1);
      assert.equal(configHunks[0].endLine, 5);
    });

    it('should exclude deleted files', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      assert.equal(result.has('old-script.sh'), false, 'deleted files should be excluded');
    });

    it('should skip binary files', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      assert.equal(result.has('data/image.png'), false, 'binary files should be skipped');
    });

    it('should handle renames (use new path)', async () => {
      const diffText = await readFile(sampleDiff, 'utf-8');
      const result = parseDiff(diffText);

      assert.equal(result.has('src/utils.js'), false, 'old name should not be present');
      const renamedHunks = result.get('src/renamed-utils.js');
      assert.ok(renamedHunks, 'should have hunks under new name');
      assert.equal(renamedHunks.length, 1);
      assert.equal(renamedHunks[0].startLine, 1);
      assert.equal(renamedHunks[0].endLine, 4);
    });

    it('should return empty map for empty diff', () => {
      const result = parseDiff('');
      assert.equal(result.size, 0);
    });

    it('should return empty map for whitespace-only diff', () => {
      const result = parseDiff('   \n\n  ');
      assert.equal(result.size, 0);
    });

    it('should handle pure deletion hunks (0 new lines)', () => {
      const diff = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -5,3 +5,0 @@ function foo() {
-  line1();
-  line2();
-  line3();
`;
      const result = parseDiff(diff);
      // Hunk has +5,0 meaning 0 new lines — should be skipped
      const hunks = result.get('src/foo.js');
      assert.ok(!hunks || hunks.length === 0, 'pure deletion hunks should be skipped');
    });

    it('should handle hunk header without line count (single line)', () => {
      const diff = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1 +1 @@
-old
+new
`;
      const result = parseDiff(diff);
      const hunks = result.get('src/foo.js');
      assert.ok(hunks);
      assert.equal(hunks.length, 1);
      assert.equal(hunks[0].startLine, 1);
      assert.equal(hunks[0].endLine, 1);
    });
  });

  describe('loadDiffFromFile', () => {
    it('should load a diff file', async () => {
      const content = await loadDiffFromFile(sampleDiff);
      assert.ok(content.includes('diff --git'));
      assert.ok(content.length > 0);
    });

    it('should throw for missing file', async () => {
      await assert.rejects(
        loadDiffFromFile('/nonexistent/file.diff'),
        /Failed to read diff file/,
      );
    });
  });
});
