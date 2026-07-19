/**
 * Repository scanning for dynamic check-matching.
 *
 * Provides a small, cached snapshot of a repository's filesystem (file paths,
 * extensions present) and any user-supplied tags so that
 * `MatchCriteria` rules in `checks-config.json` can be evaluated without
 * re-walking the tree per check.
 *
 * Bounded recursion: a fixed ignore list (`node_modules`, `.git`, `dist`,
 * `build`, `.worktrees`) is always applied and the scan stops at a depth
 * cap. This is intentionally cheap — `MatchCriteria` is meant to gate which
 * checks run, not to enumerate the whole repo.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { MatchCriteria } from './types.js';
import { logDebug } from './logging.js';

const TAG = 'repo-scan';

/** Directories always skipped during scanning. */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.worktrees',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'coverage',
]);

/** Cap directory depth to avoid runaway recursion on pathological repos. */
const MAX_DEPTH = 12;
/** Cap total files inspected so very large monorepos still match in bounded time. */
const MAX_FILES = 50_000;

/**
 * Test-only knobs to exercise the depth/file caps without building a 50k-file
 * fixture. NOT part of the public API.
 */
export interface ScanRepositoryOptions {
  maxDepth?: number;
  maxFiles?: number;
}

/** Cached snapshot of a repository's structure relevant to MatchCriteria. */
export interface RepoSnapshot {
  /** Absolute repository path (resolved). */
  repoPath: string;
  /** All non-ignored file paths, relative to repoPath, with forward slashes. */
  files: string[];
  /** Set of file extensions present (lowercased, including leading dot, e.g. ".ts"). */
  extensions: Set<string>;
  /** Tags from `.aghast-tags` (newline-separated) or `.aghast.json` `tags`. */
  tags: Set<string>;
}

/**
 * Build a RepoSnapshot for the given path. Walks the filesystem once,
 * applying the default ignore list. Errors reading individual entries are
 * swallowed so a permission issue on a single subtree doesn't kill matching.
 */
export async function scanRepository(
  repoPath: string,
  options: ScanRepositoryOptions = {},
): Promise<RepoSnapshot> {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const files: string[] = [];
  const extensions = new Set<string>();
  let truncatedByFileCap = false;
  let truncatedByDepthCap = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      truncatedByDepthCap = true;
      return;
    }
    if (files.length >= maxFiles) {
      truncatedByFileCap = true;
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncatedByFileCap = true;
        return;
      }
      const name = entry.name;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(name)) continue;
        await walk(join(dir, name), depth + 1);
      } else if (entry.isFile()) {
        const full = join(dir, name);
        const rel = relative(repoPath, full).split(sep).join('/');
        files.push(rel);
        const dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length - 1) {
          extensions.add(name.slice(dot).toLowerCase());
        }
      }
    }
  }

  await walk(repoPath, 0);

  // Surface truncation: silently dropping files/subtrees can make `matchCriteria`
  // miss matches in very large or very deep repos. Logged at debug so it's only
  // visible when the user opts in via --debug / --log-level debug.
  if (truncatedByFileCap) {
    logDebug(
      TAG,
      `Repo scan truncated at MAX_FILES=${maxFiles} files for "${repoPath}". ` +
        `matchCriteria evaluation is best-effort beyond this cap.`,
    );
  }
  if (truncatedByDepthCap) {
    logDebug(
      TAG,
      `Repo scan truncated at MAX_DEPTH=${maxDepth} for "${repoPath}". ` +
        `Subtrees deeper than this were skipped during matchCriteria evaluation.`,
    );
  }

  const tags = await loadTags(repoPath);

  return { repoPath, files, extensions, tags };
}

/**
 * Read tags from `<repo>/.aghast-tags` (newline-separated) or
 * `<repo>/.aghast.json` `tags` array. Returns an empty set if neither exists.
 */
async function loadTags(repoPath: string): Promise<Set<string>> {
  const tags = new Set<string>();

  // .aghast-tags
  try {
    const tagsFile = join(repoPath, '.aghast-tags');
    const st = await stat(tagsFile);
    if (st.isFile()) {
      const raw = await readFile(tagsFile, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) tags.add(t);
      }
    }
  } catch {
    // Missing or unreadable; ignore.
  }

  // .aghast.json -> tags array
  try {
    const cfgFile = join(repoPath, '.aghast.json');
    const st = await stat(cfgFile);
    if (st.isFile()) {
      const raw = await readFile(cfgFile, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).tags)
      ) {
        for (const t of (parsed as Record<string, unknown>).tags as unknown[]) {
          if (typeof t === 'string' && t.trim() !== '') tags.add(t.trim());
        }
      }
    }
  } catch {
    // Missing or unreadable / invalid JSON; ignore.
  }

  return tags;
}

/**
 * Evaluate MatchCriteria against a repo snapshot.
 *
 * Semantics:
 * - hasFileTypes: at least one extension in the list is present in the repo
 * - hasFiles: every entry exists (literal path under repo OR glob match)
 * - hasPaths: at least one file matches at least one of the globs
 * - tags: every listed tag is present
 *
 * If multiple criteria are set, ALL must pass (AND). An empty MatchCriteria
 * (no fields) matches nothing — explicit opt-in is required.
 */
export function evaluateMatchCriteria(
  criteria: MatchCriteria,
  snapshot: RepoSnapshot,
): boolean {
  const hasAny =
    !!criteria.hasFileTypes?.length ||
    !!criteria.hasFiles?.length ||
    !!criteria.hasPaths?.length ||
    !!criteria.tags?.length;
  if (!hasAny) return false;

  if (criteria.hasFileTypes && criteria.hasFileTypes.length > 0) {
    const wanted = criteria.hasFileTypes
      .filter((e) => e.trim() !== '')
      .map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase());
    if (wanted.length === 0) return false;
    const hit = wanted.some((ext) => snapshot.extensions.has(ext));
    if (!hit) return false;
  }

  if (criteria.hasFiles && criteria.hasFiles.length > 0) {
    const fileSet = new Set(snapshot.files);
    for (const entry of criteria.hasFiles) {
      const normalized = entry.replace(/\\/g, '/');
      if (fileSet.has(normalized)) continue;
      // Literal lookup missed. If `entry` has no glob metacharacters there's
      // no point compiling a matcher and scanning the file list — it's a
      // guaranteed miss. Only fall back to glob matching for actual globs.
      if (!picomatch.scan(normalized).isGlob) {
        return false;
      }
      const matcher = picomatch(normalized, { dot: true });
      if (!snapshot.files.some((f) => matcher(f))) {
        return false;
      }
    }
  }

  if (criteria.hasPaths && criteria.hasPaths.length > 0) {
    const matcher = picomatch(criteria.hasPaths.map((p) => p.replace(/\\/g, '/')), {
      dot: true,
    });
    if (!snapshot.files.some((f) => matcher(f))) return false;
  }

  if (criteria.tags && criteria.tags.length > 0) {
    for (const t of criteria.tags) {
      if (!snapshot.tags.has(t)) return false;
    }
  }

  return true;
}

// --- Cache ---

const snapshotCache = new Map<string, Promise<RepoSnapshot>>();

/**
 * Return a cached RepoSnapshot for the given path, scanning on first request.
 * The cache is keyed by absolute repository path so multiple checks reusing
 * the same repo share one filesystem walk.
 *
 * On rejection, the failing promise is evicted so a later caller can retry
 * (avoids "poisoned cache" where a transient error becomes permanent for the
 * lifetime of the process). `scanRepository` currently swallows per-entry
 * errors and always resolves, but the eviction guard keeps that contract from
 * silently breaking if `scanRepository` ever changes.
 */
export function getRepoSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const existing = snapshotCache.get(repoPath);
  if (existing) return existing;
  const promise = scanRepository(repoPath);
  snapshotCache.set(repoPath, promise);
  promise.catch(() => {
    // Only delete if the cached promise is still the one we set (a later call
    // may have already replaced it).
    if (snapshotCache.get(repoPath) === promise) {
      snapshotCache.delete(repoPath);
    }
  });
  return promise;
}

/**
 * Clear the snapshot cache. Called by `runScan` at the start of each
 * invocation (so successive scans don't reuse stale filesystem state) and by
 * tests between cases.
 *
 * Note: the cache is module-scoped, so calling this from concurrent
 * `runScan` invocations will wipe each other's in-flight entries. Sequential
 * invocations are the primary supported pattern.
 */
export function clearRepoSnapshotCache(): void {
  snapshotCache.clear();
}

/**
 * Test-only: peek at the snapshot cache for a path. NOT part of the public
 * API. Used by unit tests to assert cache population / eviction behaviour.
 */
export function __peekSnapshotCacheForTesting(repoPath: string): Promise<RepoSnapshot> | undefined {
  return snapshotCache.get(repoPath);
}
