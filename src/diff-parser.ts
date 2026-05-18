/**
 * Git diff parsing utility.
 *
 * Parses unified diff format (output of `git diff`) into a structured
 * map of changed regions per file. Used by the diff filter to
 * determine which code was changed.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// --- Types ---

export interface DiffHunk {
  /** Relative path from repo root. */
  file: string;
  /** 1-based start line of the changed region (new file side). */
  startLine: number;
  /** 1-based end line of the changed region (new file side). */
  endLine: number;
}

/** Changed regions keyed by file path for fast lookup. */
export type DiffMap = Map<string, DiffHunk[]>;

// --- Parsing ---

/**
 * Parse a unified diff string into a DiffMap.
 *
 * Extracts file paths and hunk headers, using the new-file line numbers
 * (the `+` side) since we analyze the current state of the code.
 *
 * Handles:
 * - Regular file modifications
 * - Renames (maps to new path)
 * - New files (entire file is changed)
 * - Deleted files (excluded — no code to analyze)
 * - Binary files (skipped)
 */
export function parseDiff(diffText: string): DiffMap {
  const result: DiffMap = new Map();

  if (!diffText.trim()) return result;

  const lines = diffText.split('\n').map(l => l.replace(/\r$/, ''));
  let currentFile: string | null = null;
  let isDeletedFile = false;
  let isBinaryFile = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file diff header: "diff --git a/... b/..."
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      isDeletedFile = false;
      isBinaryFile = false;
      continue;
    }

    // Binary file marker
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      isBinaryFile = true;
      continue;
    }

    // Deleted file marker
    if (line === 'deleted file mode 100644' || line === 'deleted file mode 100755' || line.startsWith('deleted file mode ')) {
      isDeletedFile = true;
      continue;
    }

    // New file path: "+++ b/path" (the destination side of the diff)
    if (line.startsWith('+++ b/')) {
      if (isDeletedFile || isBinaryFile) continue;
      currentFile = line.slice(6); // Remove "+++ b/"
      continue;
    }

    // Deleted file: "+++ /dev/null"
    if (line === '+++ /dev/null') {
      isDeletedFile = true;
      currentFile = null;
      continue;
    }

    // Hunk header: "@@ -old,len +new,len @@"
    if (line.startsWith('@@ ') && currentFile && !isDeletedFile && !isBinaryFile) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const startLine = parseInt(match[1], 10);
        const lineCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;

        // A hunk with 0 new lines means pure deletion in this region — skip
        if (lineCount === 0) continue;

        const endLine = startLine + lineCount - 1;

        const hunk: DiffHunk = { file: currentFile, startLine, endLine };

        if (!result.has(currentFile)) {
          result.set(currentFile, []);
        }
        result.get(currentFile)!.push(hunk);
      }
      continue;
    }
  }

  return result;
}

// --- Git integration ---

/**
 * Run `git diff <ref>` against a repository and return the raw unified diff.
 */
export async function getDiff(repoPath: string, ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['diff', ref],
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git diff failed: ${stderr?.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Load a diff from a file path.
 */
export async function loadDiffFromFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read diff file: ${filePath}`, { cause: err });
  }
}
