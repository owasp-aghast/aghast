/**
 * Unit tests for the GitHub PR comment result handler.
 *
 * All tests inject a fake CommandExecutor — we never spawn `gh` or hit GitHub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePatchAddedLines,
  buildDiffLineMap,
  buildCommentBody,
  extractMarkerHash,
  issueHash,
  issueToReviewComment,
  postPRComments,
  type CommandExecutor,
  type PullRequestFile,
  type ExistingReviewComment,
} from '../src/result-handlers/pr-comment-handler.js';
import type { ScanResults, SecurityIssue } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface RecordedCall {
  command: string;
  args: string[];
  input?: string;
  envHasToken: boolean;
}

interface FakeExecutorOptions {
  /**
   * Map from a substring of the API path to the response payload.
   * The first matching key wins.
   */
  responses?: Array<{ match: RegExp; body: unknown; exitCode?: number; stderr?: string }>;
}

function makeFakeExecutor(opts: FakeExecutorOptions = {}): {
  executor: CommandExecutor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const executor: CommandExecutor = async (command, args, options = {}) => {
    calls.push({
      command,
      args: [...args],
      input: options.input,
      envHasToken: !!(options.env?.GH_TOKEN ?? options.env?.GITHUB_TOKEN),
    });

    const apiPath = args[args.length - 1] ?? '';
    for (const r of opts.responses ?? []) {
      if (r.match.test(apiPath)) {
        return {
          stdout: r.body === undefined ? '' : JSON.stringify(r.body),
          stderr: r.stderr ?? '',
          exitCode: r.exitCode ?? 0,
        };
      }
    }
    // Default: empty array for list endpoints.
    return { stdout: '[]', stderr: '', exitCode: 0 };
  };
  return { executor, calls };
}

function makeIssue(overrides: Partial<SecurityIssue> = {}): SecurityIssue {
  return {
    checkId: 'sql-injection',
    checkName: 'SQL Injection',
    file: 'src/db.ts',
    startLine: 10,
    endLine: 10,
    description: 'Unparameterised query',
    severity: 'high',
    ...overrides,
  };
}

function makeResults(issues: SecurityIssue[]): ScanResults {
  return {
    scanId: 'test',
    timestamp: new Date().toISOString(),
    version: '0.0.0',
    repository: { path: '/tmp/repo', isGitRepository: true },
    issues,
    checks: [],
    summary: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      flaggedChecks: 0,
      errorChecks: 0,
      totalIssues: issues.length,
    },
    executionTime: 0,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    agentProvider: { name: 'mock', models: ['mock'] },
  };
}

// ─── parsePatchAddedLines ────────────────────────────────────────────────────

describe('parsePatchAddedLines', () => {
  it('returns the new-side line numbers of added lines', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' line1',
      ' line2',
      '+inserted at new line 3',
      ' line3',
    ].join('\n');
    const added = parsePatchAddedLines(patch);
    assert.deepEqual([...added].sort(), [3]);
  });

  it('handles multiple hunks and removed lines', () => {
    const patch = [
      '@@ -10,3 +10,4 @@',
      ' a',
      '+added line at 11',
      ' b',
      ' c',
      '@@ -50,2 +51,2 @@',
      '-old',
      '+new at 51',
      ' tail',
    ].join('\n');
    const added = parsePatchAddedLines(patch);
    assert.deepEqual([...added].sort((x, y) => x - y), [11, 51]);
  });

  it('returns an empty set for an empty patch', () => {
    assert.equal(parsePatchAddedLines('').size, 0);
  });

  it('ignores + lines that appear before any hunk header (malformed patch)', () => {
    // Defensive: without the inHunk guard this would record line 0.
    const patch = ['+ stray plus before hunk', '@@ -1,1 +1,2 @@', ' a', '+real at 2'].join('\n');
    const added = parsePatchAddedLines(patch);
    assert.deepEqual([...added].sort(), [2]);
    assert.equal(added.has(0), false);
  });
});

// ─── buildDiffLineMap ────────────────────────────────────────────────────────

describe('buildDiffLineMap', () => {
  it('skips files with no patch (e.g. binary)', () => {
    const files: PullRequestFile[] = [
      { filename: 'a.bin', status: 'added' },
      {
        filename: 'src/x.ts',
        status: 'modified',
        patch: '@@ -0,0 +1,1 @@\n+hello',
      },
    ];
    const map = buildDiffLineMap(files);
    assert.equal(map.has('a.bin'), false);
    assert.deepEqual([...(map.get('src/x.ts') ?? [])], [1]);
  });
});

// ─── Marker / hashing ────────────────────────────────────────────────────────

describe('issueHash + marker', () => {
  it('produces a stable hash for the same logical issue', () => {
    const a = issueHash(makeIssue());
    const b = issueHash(makeIssue());
    assert.equal(a, b);
  });

  it('is stable when only the description changes (LLM rephrasing)', () => {
    // Description is intentionally NOT in the hash so AI rephrasing across
    // runs does not produce a duplicate comment.
    const a = issueHash(makeIssue({ description: 'one' }));
    const b = issueHash(makeIssue({ description: 'two' }));
    assert.equal(a, b);
  });

  it('changes when the file or line changes', () => {
    const base = makeIssue();
    assert.notEqual(issueHash(base), issueHash({ ...base, file: 'src/other.ts' }));
    assert.notEqual(issueHash(base), issueHash({ ...base, startLine: base.startLine + 1 }));
  });

  it('changes when the checkId changes', () => {
    const a = issueHash(makeIssue({ checkId: 'sql-injection' }));
    const b = issueHash(makeIssue({ checkId: 'xss' }));
    assert.notEqual(a, b);
  });

  it('round-trips through buildCommentBody / extractMarkerHash', () => {
    const issue = makeIssue();
    const body = buildCommentBody(issue);
    assert.equal(extractMarkerHash(body), issueHash(issue));
  });

  it('extractMarkerHash returns undefined when no marker is present', () => {
    assert.equal(extractMarkerHash('just a normal comment'), undefined);
  });
});

// ─── issueToReviewComment ────────────────────────────────────────────────────

describe('issueToReviewComment', () => {
  it('returns undefined when the file is not in the diff', () => {
    const diff = new Map<string, Set<number>>([['other.ts', new Set([1, 2])]]);
    const issue = makeIssue({ file: 'src/db.ts', startLine: 1 });
    assert.equal(issueToReviewComment(issue, diff), undefined);
  });

  it('returns undefined when the line is not in the diff for that file', () => {
    const diff = new Map<string, Set<number>>([['src/db.ts', new Set([1, 2])]]);
    const issue = makeIssue({ file: 'src/db.ts', startLine: 99 });
    assert.equal(issueToReviewComment(issue, diff), undefined);
  });

  it('produces a RIGHT-side comment when the line is in the diff', () => {
    const diff = new Map<string, Set<number>>([['src/db.ts', new Set([10])]]);
    const issue = makeIssue();
    const comment = issueToReviewComment(issue, diff);
    assert.ok(comment);
    assert.equal(comment.path, 'src/db.ts');
    assert.equal(comment.line, 10);
    assert.equal(comment.side, 'RIGHT');
    assert.match(comment.body, /aghast-issue-id:/);
  });
});

// ─── postPRComments (integration with fake executor) ─────────────────────────

describe('postPRComments', () => {
  const ctx = {
    owner: 'octo',
    repo: 'demo',
    prNumber: 42,
  };

  const filesPayload: PullRequestFile[] = [
    {
      filename: 'src/db.ts',
      status: 'modified',
      patch: '@@ -1,1 +1,2 @@\n a\n+line at 2',
    },
    {
      filename: 'src/other.ts',
      status: 'modified',
      patch: '@@ -10,1 +10,2 @@\n a\n+line at 11',
    },
  ];

  it('skips issues outside the PR diff and posts none when nothing matches', async () => {
    const { executor, calls } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: filesPayload },
      ],
    });
    const issues = [
      makeIssue({ file: 'src/db.ts', startLine: 999 }),
      makeIssue({ file: 'unknown.ts', startLine: 1 }),
    ];
    const result = await postPRComments(makeResults(issues), ctx, { executor });
    assert.deepEqual(result, { posted: 0, skipped: 2 });
    // Only the files endpoint should be called — no review POST, no comments
    // listing, since we short-circuit when there's nothing to post.
    const postCalls = calls.filter((c) => c.args.includes('--method'));
    assert.equal(postCalls.length, 0);
  });

  it('posts a single review with one comment per in-diff issue', async () => {
    const { executor, calls } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: filesPayload },
        { match: /pulls\/42\/comments/, body: [] as ExistingReviewComment[] },
        { match: /pulls\/42\/reviews/, body: { id: 1 } },
      ],
    });
    const issues = [
      makeIssue({ file: 'src/db.ts', startLine: 2 }),
      makeIssue({ file: 'src/other.ts', startLine: 11, description: 'XSS' }),
      makeIssue({ file: 'src/db.ts', startLine: 5 }), // outside diff
    ];
    const result = await postPRComments(makeResults(issues), ctx, { executor });
    assert.deepEqual(result, { posted: 2, skipped: 1 });

    const postCall = calls.find((c) => c.args.includes('--method'));
    assert.ok(postCall, 'expected a POST review call');
    assert.ok(postCall.input, 'review POST should have a JSON body');
    const body = JSON.parse(postCall.input) as {
      event: string;
      comments: Array<{ path: string; line: number; side: string }>;
    };
    assert.equal(body.event, 'COMMENT');
    assert.equal(body.comments.length, 2);
    assert.equal(body.comments[0].side, 'RIGHT');
    assert.deepEqual(
      body.comments.map((c) => `${c.path}:${c.line}`).sort(),
      ['src/db.ts:2', 'src/other.ts:11'],
    );
  });

  it('skips comments whose marker hash already exists on the PR', async () => {
    const issue = makeIssue({ file: 'src/db.ts', startLine: 2 });
    const existingBody = buildCommentBody(issue);
    const { executor, calls } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: filesPayload },
        {
          match: /pulls\/42\/comments/,
          body: [{ id: 99, path: issue.file, line: 2, body: existingBody }],
        },
      ],
    });
    const result = await postPRComments(makeResults([issue]), ctx, { executor });
    assert.deepEqual(result, { posted: 0, skipped: 1 });
    const postCall = calls.find((c) => c.args.includes('--method'));
    assert.equal(postCall, undefined, 'no review should be posted when all dupes');
  });

  it('returns early when the scan produced no issues', async () => {
    const { executor, calls } = makeFakeExecutor();
    const result = await postPRComments(makeResults([]), ctx, { executor });
    assert.deepEqual(result, { posted: 0, skipped: 0 });
    assert.equal(calls.length, 0, 'no API calls should be made for empty scans');
  });

  it('passes a token via env when supplied (and never via argv or stdin)', async () => {
    const { executor, calls } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: filesPayload },
        { match: /pulls\/42\/comments/, body: [] },
        { match: /pulls\/42\/reviews/, body: { id: 1 } },
      ],
    });
    const issues = [makeIssue({ file: 'src/db.ts', startLine: 2 })];
    await postPRComments(makeResults(issues), { ...ctx, githubToken: 'sekret' }, { executor });
    for (const c of calls) {
      assert.ok(c.envHasToken, 'token should be exposed via env');
      for (const a of c.args) {
        assert.ok(!a.includes('sekret'), 'token must never appear in argv');
      }
      // The stdin payload (POST body) must never echo the token either —
      // covers the case where a future bug interpolates it into JSON.
      assert.ok(
        c.input === undefined || !c.input.includes('sekret'),
        'token must never appear in stdin/input payload',
      );
      // Spot-check the full command-line blob (command + args).
      const blob = c.command + ' ' + c.args.join(' ');
      assert.ok(!blob.includes('sekret'), 'token must never appear in command line');
    }
  });

  it('surfaces gh API errors when the files endpoint fails', async () => {
    const { executor } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: undefined, exitCode: 1, stderr: 'boom' },
      ],
    });
    await assert.rejects(
      () => postPRComments(makeResults([makeIssue()]), ctx, { executor }),
      /boom/,
    );
  });

  it('continues posting when listing existing comments fails (warns instead)', async () => {
    const { executor, calls } = makeFakeExecutor({
      responses: [
        { match: /pulls\/42\/files/, body: filesPayload },
        { match: /pulls\/42\/comments/, body: undefined, exitCode: 1, stderr: 'rate limited' },
        { match: /pulls\/42\/reviews/, body: { id: 1 } },
      ],
    });
    const issues = [makeIssue({ file: 'src/db.ts', startLine: 2 })];
    const result = await postPRComments(makeResults(issues), ctx, { executor });
    assert.equal(result.posted, 1);
    assert.equal(result.skipped, 0);
    const postCall = calls.find((c) => c.args.includes('--method'));
    assert.ok(postCall, 'should still post the review when dedup listing fails');
  });
});
