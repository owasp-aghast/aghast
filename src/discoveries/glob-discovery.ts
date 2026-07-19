/**
 * Glob-based target discovery.
 *
 * Matches files in the repository by glob pattern (e.g. "src/routes/**\/*.ts")
 * and returns each matched file as a whole-file target. Useful for checks that
 * apply to entire files (e.g. "review every GraphQL resolver"), without
 * requiring an external tool such as Semgrep.
 *
 * Spec reference: Appendix E.2.1.
 */

import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import { logDebug } from '../logging.js';
import { ERROR_CODES, formatError } from '../error-codes.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'glob-discovery';

/**
 * Skip files larger than this (in bytes) to avoid OOM when a wide glob
 * (e.g. "**\/*") accidentally matches a large generated/binary file.
 * Files above this threshold are excluded from the target set with a debug log.
 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Directories that are always skipped when walking the repository tree. */
const ALWAYS_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
]);

function buildTargetPromptEnrichment(file: string, endLine: number): string {
  return `\n\nTARGET FILE:

You are analyzing a specific file:
- File: ${file}
- Lines: 1-${endLine} (whole file)

You MUST:
- Analyze ONLY this specific file — do not search for or report issues in other files
- You may read other files to understand context (e.g., imports, type definitions, data flow), but only report issues in this file
- Do NOT scan the broader repository for other instances of this vulnerability pattern
`;
}

/**
 * Walk a directory tree recursively and yield every file path (POSIX-normalized,
 * relative to `root`). Skips well-known noise directories so glob patterns do
 * not have to opt out of `node_modules`/`.git` etc. on every check.
 *
 * Symlinks are NOT followed: `Dirent.isDirectory()` returns true only for real
 * directories, so symlinked directories (and any cycles they could form) are
 * skipped. Symlinked files are also skipped (`isFile()` returns false). This
 * is the safe default — there's no general way to detect a hostile cycle, and
 * source repos rarely rely on symlink-to-directory for layout.
 */
async function* walkFiles(root: string): AsyncGenerator<string> {
  async function* walk(dir: string): AsyncGenerator<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        yield* walk(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        yield rel;
      }
      // Symlinks (entry.isSymbolicLink()) are intentionally skipped — see
      // the function-level comment above.
    }
  }
  yield* walk(root);
}

/**
 * Count the number of lines in a file by streaming and counting `\n` bytes.
 * Constant memory; safe for very large files.
 *
 * Returns 1 for empty files so that `endLine >= startLine` always holds.
 * Returns `undefined` if the file cannot be read or exceeds `MAX_FILE_SIZE_BYTES`
 * — callers should treat that as "skip this target" and log accordingly.
 */
async function countLines(filePath: string): Promise<number | undefined> {
  let size: number;
  try {
    const st = await stat(filePath);
    size = st.size;
  } catch (err) {
    logDebug(TAG, `failed to stat ${filePath} for line count: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  if (size > MAX_FILE_SIZE_BYTES) {
    logDebug(TAG, `skipping ${filePath}: size ${size} bytes exceeds limit ${MAX_FILE_SIZE_BYTES}`);
    return undefined;
  }

  if (size === 0) return 1;

  return new Promise<number | undefined>((resolvePromise) => {
    let newlineCount = 0;
    let endsWithNewline = false;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      // Treat the stream as bytes — counting `\n` bytes is safe for UTF-8 because
      // 0x0A never appears as a continuation byte of a multi-byte sequence.
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlineCount++;
      }
      if (buf.length > 0) endsWithNewline = buf[buf.length - 1] === 0x0a;
    });
    stream.on('error', (err) => {
      logDebug(TAG, `failed to read ${filePath} for line count: ${err.message}`);
      resolvePromise(undefined);
    });
    stream.on('end', () => {
      // If the file ends with a newline, the count of \n equals the number of lines.
      // If it does not, the trailing partial line adds one to the count.
      const lines = endsWithNewline ? newlineCount : newlineCount + 1;
      resolvePromise(lines || 1);
    });
  });
}

/**
 * Discover whole-file targets in `repoPath` matching `pattern`.
 *
 * Exposed as a named export (rather than only the registry-facing object) so
 * unit tests can exercise the matching logic directly without going through
 * the SecurityCheck plumbing.
 */
export async function discoverGlobTargets(
  pattern: string,
  repoPath: string,
  maxTargets?: number,
): Promise<DiscoveredTarget[]> {
  if (!pattern || pattern.trim() === '') {
    throw new Error(
      formatError(ERROR_CODES.E2004, 'Glob discovery requires a non-empty "glob" pattern'),
    );
  }

  const matcher = picomatch(pattern, { dot: false });
  const matches: string[] = [];

  for await (const rel of walkFiles(repoPath)) {
    if (matcher(rel)) {
      matches.push(rel);
    }
  }

  // Sort BEFORE applying maxTargets so that the truncated subset is deterministic
  // across platforms (readdir order varies by filesystem). Without this, a glob
  // with maxTargets=N could analyze a different N files on Linux vs Windows vs
  // macOS, making findings non-reproducible.
  matches.sort();
  const limited = typeof maxTargets === 'number' ? matches.slice(0, maxTargets) : matches;

  // Compute line counts in parallel; drop unreadable / oversized files.
  const lineCounts = await Promise.all(
    limited.map((rel) => countLines(join(repoPath, rel))),
  );
  const usable: { rel: string; endLine: number }[] = [];
  for (let i = 0; i < limited.length; i++) {
    const endLine = lineCounts[i];
    if (endLine === undefined) continue; // unreadable / oversized — already logged
    usable.push({ rel: limited[i], endLine });
  }

  // Surface a single summary log when files were dropped, so users debugging
  // "why is my big bundle missing from the target set?" don't have to enable
  // trace-level logging to find the per-file skip messages from countLines.
  const skippedCount = limited.length - usable.length;
  if (skippedCount > 0) {
    logDebug(
      TAG,
      `${skippedCount} matched file${skippedCount === 1 ? '' : 's'} skipped (unreadable or > ${MAX_FILE_SIZE_BYTES} bytes)`,
    );
  }

  return usable.map(({ rel, endLine }, idx) => ({
    file: rel,
    startLine: 1,
    endLine,
    label: `[file ${idx + 1}/${usable.length}]`,
    promptEnrichment: buildTargetPromptEnrichment(rel, endLine),
  }));
}

export const globDiscovery: TargetDiscovery = {
  name: 'glob',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  // Opted out deliberately. `supportsDiffFilter` became a required field on
  // TargetDiscovery after this discovery was written (#227), and the diff
  // filter is built around findings with meaningful line ranges. Glob targets
  // are whole files, so filtering them has never been designed or tested for
  // this shape. Opting out preserves the behaviour this discovery was built
  // and tested with: a glob check scans every matching file. Enabling it later
  // is a small change plus tests for the whole-file case.
  supportsDiffFilter: false,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    _options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    if (!checkTarget.glob) {
      throw new Error(
        formatError(
          ERROR_CODES.E2004,
          `Check "${check.id}" uses glob discovery but has no "glob" pattern in its check definition`,
        ),
      );
    }

    logDebug(TAG, `Running glob discovery for check "${check.id}": ${checkTarget.glob}`);

    const targets = await discoverGlobTargets(checkTarget.glob, repoPath, checkTarget.maxTargets);

    logDebug(TAG, `Discovered ${targets.length} files matching pattern`);
    return targets;
  },
};
