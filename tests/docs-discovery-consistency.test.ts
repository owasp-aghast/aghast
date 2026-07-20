/**
 * Guards the documentation tables that enumerate discovery methods.
 *
 * Adding a discovery method touches the registry plus several independent docs
 * locations, and nothing forced them to agree. In practice they drifted: `glob`
 * and `script` each landed in some tables and not others, at different times.
 * This test makes the registry the single source of truth — add a discovery and
 * the suite tells you exactly which docs still need it.
 *
 * It deliberately asserts only that each method is *mentioned* in the right
 * region of each file. Asserting on wording would make every copy-edit a test
 * failure, which is how consistency tests get deleted.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Importing the scan runner registers the built-in discoveries as a side effect.
import '../src/scan-runner.js';
import { getRegisteredDiscoveries } from '../src/discovery.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(testDir, '..', 'docs');

/**
 * Each entry names a docs file and the section that enumerates discoveries.
 * `section` is matched from its heading to the next heading of the same or
 * higher level, so an unrelated mention elsewhere in the file cannot satisfy
 * the assertion.
 */
const DOC_TARGETS = [
  // `table` requires a real row (`| \`glob\` | ...`). Plain "is it mentioned
  // somewhere nearby" is not enough: surrounding prose that explains a
  // discovery would satisfy it, and the check would pass with the row deleted.
  { file: 'scanning.md', heading: '| Discovery | Requires |', mode: 'table' },
  { file: 'configuration.md', heading: '| Discovery | Requires |', mode: 'table' },
  // `prose` is a bullet list, so a mention in the block is the right assertion.
  { file: 'how-it-works.md', heading: 'Discovery methods are deterministic', mode: 'prose' },
] as const;

/** Extract the table or paragraph block starting at `heading`. */
function sectionFrom(content: string, heading: string): string {
  const start = content.indexOf(heading);
  if (start === -1) return '';
  // Take a generous window: the enumerations are contiguous blocks, and a
  // fixed line budget is more robust than guessing the next heading level.
  return content.slice(start).split('\n').slice(0, 40).join('\n');
}

describe('docs: discovery method tables match the registry', () => {
  let registered: string[];

  before(() => {
    registered = getRegisteredDiscoveries();
  });

  it('registry is non-empty (guards against the import side effect breaking)', () => {
    assert.ok(
      registered.length >= 6,
      `expected the built-in discoveries to be registered, got: ${registered.join(', ') || '(none)'}`,
    );
  });

  for (const { file, heading, mode } of DOC_TARGETS) {
    it(`${file} enumerates every registered discovery`, async () => {
      const content = await readFile(resolve(docsDir, file), 'utf-8');
      const section = sectionFrom(content, heading);
      assert.notEqual(
        section,
        '',
        `could not locate the discovery section in ${file} (looked for "${heading}") — ` +
          'if the docs were restructured, update DOC_TARGETS in this test',
      );

      // Case-insensitive: tables use the literal id (`opengrep`) while prose
      // uses a display form (**Opengrep**). Both count as documenting it.
      const haystack = section.toLowerCase();
      const missing = registered.filter((name) => {
        const id = name.toLowerCase();
        return mode === 'table'
          // Must be its own row, not merely named in nearby prose.
          ? !new RegExp(`^\\|\\s*\`${id}\`\\s*\\|`, 'm').test(haystack)
          : !haystack.includes(id);
      });
      assert.deepEqual(
        missing,
        [],
        `${file} is missing ${mode === 'table' ? 'table rows' : 'mentions'} for: ${missing.join(', ')}`,
      );
    });
  }

  it('the checkTarget.discovery field reference lists every registered discovery', async () => {
    const content = await readFile(resolve(docsDir, 'configuration.md'), 'utf-8');
    const line = content
      .split('\n')
      .find((l) => l.includes('`checkTarget.discovery`'));
    assert.ok(line, 'configuration.md should document the checkTarget.discovery field');

    const missing = registered.filter((name) => !line.includes(`\`${name}\``));
    assert.deepEqual(
      missing,
      [],
      `the checkTarget.discovery row omits: ${missing.join(', ')}`,
    );
  });
});
