import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcDir = resolve(repoRoot, 'src');
const docsDir = resolve(repoRoot, 'docs');

/**
 * The CLI help footers deep-link to individual documentation pages via
 * docsFooter('<page>.md'). A renamed or deleted page would silently ship a dead
 * link, so assert every page referenced from source actually exists under docs/.
 */
describe('documentation help links', () => {
  it('every docsFooter(...) page exists under docs/', () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    const pattern = /docsFooter\(\s*['"]([^'"]+)['"]\s*\)/g;

    const referenced = new Set<string>();
    for (const file of files) {
      const contents = readFileSync(resolve(srcDir, file), 'utf-8');
      for (const match of contents.matchAll(pattern)) {
        referenced.add(match[1]);
      }
    }

    // The feature wires up five help screens; four of them deep-link a page
    // (the top-level help uses docsFooter() with no argument).
    assert.ok(referenced.size >= 4, `Expected several deep-linked docs pages, found ${referenced.size}`);

    for (const page of referenced) {
      assert.ok(
        existsSync(resolve(docsDir, page)),
        `Help links to docs/${page} but that file does not exist`,
      );
    }
  });
});
