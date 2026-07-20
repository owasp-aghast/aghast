/**
 * GitHub PR comment result handler (Phase 1 of Spec E.7).
 *
 * Posts aghast scan findings as inline review comments on a GitHub pull request.
 * Issues that fall outside the PR diff are skipped (with a debug log). Existing
 * comments authored by aghast are deduplicated using a hidden HTML marker
 * embedded in the comment body.
 *
 * Phase-1 limitations (intentional):
 *   - Multi-line findings (`endLine > startLine`) are anchored at `startLine`
 *     only; we do not yet emit GitHub's multi-line `start_line`/`line` form.
 *   - Dedup is best-effort and per-run: two parallel runs (e.g. CI matrix
 *     shards) on the same PR can each pass the dedup check and post duplicate
 *     comments. Confine `--pr` to a single matrix shard, or run after the
 *     matrix completes. A future phase could PATCH instead of POST.
 *
 * Future phases (issue tracker integration, AI remediation, IDE/LSP, Slack/email
 * notifications) are intentionally out of scope here — see GitHub issue #119.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { logDebug, logProgress, logWarn } from '../logging.js';
import type { ScanResults, SecurityIssue } from '../types.js';

const TAG = 'pr-comment-handler';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal subset of the GitHub PR "files" API response we care about.
 * Each entry describes one file in the PR diff; `patch` contains the unified-diff
 * hunks for that file (omitted by GitHub for binary or very large files).
 */
export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
}

/**
 * Minimal subset of the GitHub review-comments API response used for dedup.
 */
export interface ExistingReviewComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
}

/**
 * Single inline comment in the payload sent to the GitHub Reviews API.
 * Matches the schema documented at:
 *   https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request
 */
export interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface PRCommentContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** Optional commit SHAs — currently informational; the GitHub API uses
   *  the PR's head commit by default when posting a review. */
  baseSha?: string;
  headSha?: string;
  /** Optional explicit token. If omitted, the `gh` CLI's stored auth is used. */
  githubToken?: string;
}

export interface PRCommentResult {
  posted: number;
  skipped: number;
  /**
   * Findings that were eligible to post but exceeded the per-review cap. They
   * are named in the review summary and remain in the scan report; they are not
   * counted as `skipped`, which means "deliberately not applicable".
   */
  omitted?: number;
}

/**
 * Pluggable command executor — lets tests inject a fake `gh` so we don't hit
 * GitHub. Receives positional args (no shell interpolation). Returns stdout
 * and the exit code.
 */
export interface CommandExecutor {
  (
    command: string,
    args: string[],
    options?: { input?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ─── Default executor (real `gh` shell-out) ──────────────────────────────────

/**
 * Test-only fake executor selector.
 *
 * When `AGHAST_PR_COMMENT_FAKE_FILES` is set, `gh api .../pulls/<n>/files` calls
 * resolve to the JSON contents of that file. When `AGHAST_PR_COMMENT_FAKE_LOG`
 * is set, every captured call (including POST bodies) is appended as JSON-lines
 * to that path. The real `gh` is never spawned. This is used by CLI integration
 * tests so we can exercise the full --pr code path without hitting GitHub.
 */
function maybeFakeExecutor(): CommandExecutor | undefined {
  const filesPath = process.env.AGHAST_PR_COMMENT_FAKE_FILES;
  const logPath = process.env.AGHAST_PR_COMMENT_FAKE_LOG;
  const commentsPath = process.env.AGHAST_PR_COMMENT_FAKE_COMMENTS;
  if (!filesPath && !logPath && !commentsPath) return undefined;

  return async (command, args) => {
    if (logPath) {
      try {
        appendFileSync(
          logPath,
          JSON.stringify({ command, args }) + '\n',
          'utf-8',
        );
      } catch {
        // Best-effort logging only.
      }
    }
    const apiPath = args[args.length - 1] ?? '';
    if (/\/files(\?|$)/.test(apiPath) && filesPath) {
      const { readFileSync } = await import('node:fs');
      return { stdout: readFileSync(filesPath, 'utf-8'), stderr: '', exitCode: 0 };
    }
    if (/\/comments(\?|$)/.test(apiPath)) {
      if (commentsPath) {
        const { readFileSync } = await import('node:fs');
        return { stdout: readFileSync(commentsPath, 'utf-8'), stderr: '', exitCode: 0 };
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    }
    if (/\/reviews(\?|$)/.test(apiPath)) {
      return { stdout: '{"id":1}', stderr: '', exitCode: 0 };
    }
    return { stdout: '[]', stderr: '', exitCode: 0 };
  };
}

export const defaultExecutor: CommandExecutor = (command, args, options = {}) => {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Translate the most common failure (gh CLI not installed) into an
      // actionable message. Without this the user sees `Error: spawn gh ENOENT`
      // and has to guess what to install.
      if (err.code === 'ENOENT') {
        reject(new Error(
          `gh CLI not found on PATH. Install it from https://cli.github.com or set GH_TOKEN and ensure 'gh' is reachable. (original: ${err.message})`,
        ));
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
};

// ─── Patch parsing ───────────────────────────────────────────────────────────

/**
 * Parse a unified-diff `patch` (as returned by GitHub's PR files API) into the
 * set of new-file line numbers that were added or modified by the PR.
 *
 * GitHub PR review comments can target either the LEFT (base) or RIGHT (head)
 * side. We only post comments on lines that exist on the head side — i.e. lines
 * actually changed (added) by this PR — to avoid leaving stale comments on
 * unchanged code.
 */
export function parsePatchAddedLines(patch: string): Set<number> {
  const addedLines = new Set<number>();
  if (!patch) return addedLines;

  const lines = patch.split('\n');
  let newLine = 0;
  let inHunk = false;
  // Hunk header format: @@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const line of lines) {
    const hunkMatch = hunkRegex.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    // Defensive: ignore patch content (including stray `+` lines from a
    // malformed patch) until we see the first hunk header. This prevents us
    // from ever recording line 0 — which would later masquerade as a real
    // diff line and either skip or anchor a comment at a nonexistent line.
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line — does not advance newLine
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignore, doesn't advance
    } else {
      // Context line: present in both old and new.
      newLine++;
    }
  }
  return addedLines;
}

/**
 * Build a map of file path → set of new-side line numbers changed by the PR.
 */
export function buildDiffLineMap(files: PullRequestFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.patch) continue;
    map.set(file.filename, parsePatchAddedLines(file.patch));
  }
  return map;
}

// ─── Comment building ────────────────────────────────────────────────────────

/**
 * Stable hash identifying a single (check + file + line + description) tuple.
 * Embedded as an HTML comment in the body so future runs can recognise — and
 * skip — comments they previously posted.
 */
export function issueHash(issue: SecurityIssue): string {
  // Description is deliberately NOT in the hash. AI-generated descriptions are
  // non-deterministic (the LLM may rephrase the same finding across runs), so
  // including the description would defeat dedup on re-runs. The trade-off: if
  // an issue at the same (checkId, file, startLine) genuinely changes meaning,
  // the original comment will not be refreshed — Phase 1 accepts that staleness
  // in exchange for idempotent re-runs. A future phase can PATCH the existing
  // comment to refresh stale descriptions.
  const payload = [
    issue.checkId,
    issue.file,
    issue.startLine,
  ].join(' ');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

const MARKER_PREFIX = '<!-- aghast-issue-id: ';
const MARKER_SUFFIX = ' -->';

export function buildCommentBody(issue: SecurityIssue): string {
  const hash = issueHash(issue);
  const severity = issue.severity ? ` (${issue.severity})` : '';
  const lines: string[] = [];
  lines.push(`**aghast: ${issue.checkName}**${severity}`);
  lines.push('');
  lines.push(issue.description);
  if (issue.recommendation) {
    lines.push('');
    lines.push(`**Recommendation:** ${issue.recommendation}`);
  }
  lines.push('');
  lines.push(`${MARKER_PREFIX}${hash}${MARKER_SUFFIX}`);
  return lines.join('\n');
}

export function extractMarkerHash(body: string): string | undefined {
  const idx = body.indexOf(MARKER_PREFIX);
  if (idx === -1) return undefined;
  const start = idx + MARKER_PREFIX.length;
  const end = body.indexOf(MARKER_SUFFIX, start);
  if (end === -1) return undefined;
  return body.slice(start, end).trim();
}

/**
 * Map a SecurityIssue onto a ReviewComment, or return undefined if the issue's
 * line is not part of the PR diff.
 */
export function issueToReviewComment(
  issue: SecurityIssue,
  diffLines: Map<string, Set<number>>,
): ReviewComment | undefined {
  const fileLines = diffLines.get(issue.file);
  if (!fileLines || !fileLines.has(issue.startLine)) {
    return undefined;
  }
  return {
    path: issue.file,
    line: issue.startLine,
    side: 'RIGHT',
    body: buildCommentBody(issue),
  };
}

// ─── gh API helpers ──────────────────────────────────────────────────────────

interface GhApiOptions {
  method?: 'GET' | 'POST';
  paginate?: boolean;
  body?: unknown;
  token?: string;
}

async function ghApi<T>(
  executor: CommandExecutor,
  path: string,
  options: GhApiOptions = {},
): Promise<T> {
  const args: string[] = ['api'];
  if (options.method && options.method !== 'GET') {
    args.push('--method', options.method);
  }
  if (options.paginate) args.push('--paginate');
  args.push('-H', 'Accept: application/vnd.github+json');
  args.push(path);

  let input: string | undefined;
  if (options.body !== undefined) {
    args.push('--input', '-');
    input = JSON.stringify(options.body);
  }

  // Pass a token via env if provided; we never log or echo it.
  const env: NodeJS.ProcessEnv = {};
  if (options.token) env.GH_TOKEN = options.token;

  const result = await executor('gh', args, { input, env });
  if (result.exitCode !== 0) {
    throw new Error(
      `gh api ${path} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  if (result.stdout.trim() === '') {
    return undefined as unknown as T;
  }
  return JSON.parse(result.stdout) as T;
}

async function listPullRequestFiles(
  executor: CommandExecutor,
  ctx: PRCommentContext,
): Promise<PullRequestFile[]> {
  const path = `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/files?per_page=100`;
  return ghApi<PullRequestFile[]>(executor, path, {
    paginate: true,
    token: ctx.githubToken,
  });
}

async function listExistingReviewComments(
  executor: CommandExecutor,
  ctx: PRCommentContext,
): Promise<ExistingReviewComment[]> {
  const path = `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments?per_page=100`;
  return ghApi<ExistingReviewComment[]>(executor, path, {
    paginate: true,
    token: ctx.githubToken,
  });
}

/**
 * Upper bound on inline comments in a single review.
 *
 * A noisy check against a large diff could otherwise post hundreds of comments
 * in one API call — unreviewable for the author, and large enough to risk the
 * request being rejected outright, which loses every comment rather than some.
 * Truncating is the lesser harm, and it is surfaced in the review body rather
 * than dropped silently. Mirrors `limitTargets` in the SARIF parser.
 */
const DEFAULT_MAX_INLINE_COMMENTS = 50;

async function postReview(
  executor: CommandExecutor,
  ctx: PRCommentContext,
  comments: ReviewComment[],
  omitted = 0,
): Promise<void> {
  const path = `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/reviews`;
  const summary = `aghast posted ${comments.length} finding${comments.length === 1 ? '' : 's'}.`;
  const body: Record<string, unknown> = {
    event: 'COMMENT',
    body: omitted > 0
      ? `${summary} ${omitted} further finding${omitted === 1 ? '' : 's'} ${omitted === 1 ? 'was' : 'were'} not posted inline (capped at ${comments.length} per review) — see the full scan report for the complete list.`
      : summary,
    comments,
  };
  if (ctx.headSha) body.commit_id = ctx.headSha;

  await ghApi<unknown>(executor, path, {
    method: 'POST',
    body,
    token: ctx.githubToken,
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface PostPRCommentsOptions {
  /** Inject a custom executor for testing. Defaults to spawning `gh`. */
  executor?: CommandExecutor;
  /**
   * Maximum inline comments in one review (default 50). Findings beyond the cap
   * are reported in the review summary rather than dropped silently.
   */
  maxComments?: number;
}

/**
 * Post aghast scan issues as inline GitHub PR review comments.
 *
 * Workflow:
 *   1. Fetch the PR's changed-file list and parse each file's diff hunks.
 *   2. For each issue, compute the corresponding (path, line, RIGHT) target
 *      and skip issues whose line is outside the diff.
 *   3. Fetch existing review comments and skip any whose hidden marker hash
 *      already matches an in-flight comment.
 *   4. Post the remainder as a single review with `event=COMMENT`.
 */
export async function postPRComments(
  results: ScanResults,
  ctx: PRCommentContext,
  options: PostPRCommentsOptions = {},
): Promise<PRCommentResult> {
  const executor = options.executor ?? maybeFakeExecutor() ?? defaultExecutor;

  const issues = results.issues ?? [];
  if (issues.length === 0) {
    logProgress(TAG, 'No issues to post — skipping PR comment phase');
    return { posted: 0, skipped: 0 };
  }

  logProgress(
    TAG,
    `Posting up to ${issues.length} finding(s) to ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`,
  );

  const files = await listPullRequestFiles(executor, ctx);
  const diffLines = buildDiffLineMap(files);
  logDebug(TAG, `PR diff covers ${diffLines.size} file(s) with patch hunks`);

  // Map issues onto review comments + bucket the skipped ones.
  const candidates: ReviewComment[] = [];
  let skippedOutsideDiff = 0;
  for (const issue of issues) {
    const comment = issueToReviewComment(issue, diffLines);
    if (!comment) {
      skippedOutsideDiff++;
      logDebug(
        TAG,
        `Skipping issue outside PR diff: ${issue.checkId} ${issue.file}:${issue.startLine}`,
      );
      continue;
    }
    candidates.push(comment);
  }

  if (candidates.length === 0) {
    logProgress(
      TAG,
      `No issues fell within the PR diff (${skippedOutsideDiff} skipped)`,
    );
    return { posted: 0, skipped: skippedOutsideDiff };
  }

  // Deduplicate against existing review comments.
  let existing: ExistingReviewComment[] = [];
  try {
    existing = await listExistingReviewComments(executor, ctx);
  } catch (err) {
    logWarn(
      TAG,
      `Failed to list existing PR comments — skipping dedup: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const existingHashes = new Set<string>();
  for (const c of existing) {
    const h = extractMarkerHash(c.body);
    if (h) existingHashes.add(h);
  }

  const toPost: ReviewComment[] = [];
  let skippedDuplicate = 0;
  for (const comment of candidates) {
    const h = extractMarkerHash(comment.body);
    if (h && existingHashes.has(h)) {
      skippedDuplicate++;
      logDebug(TAG, `Skipping duplicate comment ${h} on ${comment.path}:${comment.line}`);
      continue;
    }
    toPost.push(comment);
  }

  const totalSkipped = skippedOutsideDiff + skippedDuplicate;
  if (toPost.length === 0) {
    logProgress(
      TAG,
      `Nothing new to post (${skippedOutsideDiff} outside diff, ${skippedDuplicate} duplicate)`,
    );
    return { posted: 0, skipped: totalSkipped };
  }

  const maxComments = options.maxComments ?? DEFAULT_MAX_INLINE_COMMENTS;
  const capped = toPost.slice(0, maxComments);
  const omitted = toPost.length - capped.length;
  if (omitted > 0) {
    logWarn(
      TAG,
      `${toPost.length} comments to post exceeds the cap of ${maxComments}; ` +
        `posting the first ${capped.length} and noting the remaining ${omitted} in the review summary. ` +
        'All findings remain in the scan report.',
    );
  }

  await postReview(executor, ctx, capped, omitted);
  logProgress(
    TAG,
    `Posted ${capped.length} comment(s); skipped ${totalSkipped} (${skippedOutsideDiff} outside diff, ${skippedDuplicate} duplicate)`,
  );

  // Only present when something was actually omitted, so the result shape is
  // unchanged for the overwhelmingly common case (and for existing consumers).
  return omitted > 0
    ? { posted: capped.length, skipped: totalSkipped, omitted }
    : { posted: capped.length, skipped: totalSkipped };
}
