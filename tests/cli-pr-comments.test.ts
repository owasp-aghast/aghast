/**
 * CLI integration tests for the --pr / --repo flags (Phase 1 of Spec E.7).
 *
 * Spawns the actual CLI process with AGHAST_MOCK_AI=true and a fake `gh`
 * executor (driven via AGHAST_PR_COMMENT_FAKE_*) so we exercise the full
 * argument parsing, scan pipeline, and PR comment handler — without ever
 * hitting GitHub.
 */

import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  testDir as __dirname,
  fixtureRepo,
  singleCheckConfigDir,
  failFixtureRepo,
  runCLI,
} from './cli-test-helpers.js';
import { parseRepoSlug } from '../src/index.js';

const tmpDir = resolve(__dirname, 'fixtures', 'pr-comments-tmp');
const filesFixture = resolve(tmpDir, 'pr-files.json');
const ghLog = resolve(tmpDir, 'gh-calls.jsonl');
const outputFile = resolve(fixtureRepo, 'security_checks_results_pr.json');

interface CapturedCall {
  command: string;
  args: string[];
}

async function readCalls(): Promise<CapturedCall[]> {
  let raw: string;
  try {
    raw = await readFile(ghLog, 'utf-8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CapturedCall);
}

async function cleanup(): Promise<void> {
  for (const p of [filesFixture, ghLog, outputFile]) {
    await rm(p, { force: true });
  }
}

describe('CLI: --pr posts findings via fake gh executor', () => {
  before(async () => {
    await mkdir(tmpDir, { recursive: true });
  });
  afterEach(cleanup);

  it('skips issues outside the PR diff and posts those inside', async () => {
    // PR diff contains src/example.ts with a hunk that adds line 3 — the same
    // line referenced by failFixtureRepo's mocked AI response.
    const filesPayload = [
      {
        filename: 'src/example.ts',
        status: 'modified',
        // @@ -1,2 +1,4 @@ → new lines 3 & 4 added
        patch: '@@ -1,2 +1,4 @@\n line1\n line2\n+line3 added\n+line4 added',
      },
    ];
    await writeFile(filesFixture, JSON.stringify(filesPayload), 'utf-8');

    const { exitCode, stdout, stderr } = await runCLI(
      {
        AGHAST_MOCK_AI: failFixtureRepo,
        AGHAST_PR_COMMENT_FAKE_FILES: filesFixture,
        AGHAST_PR_COMMENT_FAKE_LOG: ghLog,
      },
      [
        fixtureRepo,
        '--config-dir', singleCheckConfigDir,
        '--output', outputFile,
        '--pr', '42',
        '--repo', 'octo/demo',
      ],
    );
    const out = stdout + stderr;
    assert.equal(exitCode, 0, out);
    assert.match(out, /PR comments:\s+posted 1, skipped 0/);

    const calls = await readCalls();
    // Expect at least: list files, list comments, post review.
    const filesCall = calls.find((c) => c.args.some((a) => /pulls\/42\/files/.test(a)));
    const commentsCall = calls.find((c) => c.args.some((a) => /pulls\/42\/comments/.test(a)));
    const reviewCall = calls.find((c) => c.args.some((a) => /pulls\/42\/reviews/.test(a)));
    assert.ok(filesCall, 'should fetch PR files');
    assert.ok(commentsCall, 'should fetch existing review comments');
    assert.ok(reviewCall, 'should POST a review');
    assert.ok(reviewCall.args.includes('--method'), 'review call uses --method');

    // The POST body is passed via --input - and recorded in the gh log args
    // chain; we verify the --method POST appears for the reviews endpoint.
    const idx = reviewCall.args.indexOf('--method');
    assert.equal(reviewCall.args[idx + 1], 'POST');
  });

  it('errors when --pr is supplied without a parseable repo slug', async () => {
    const { exitCode, stderr, stdout } = await runCLI(
      {
        AGHAST_MOCK_AI: 'true',
        // Force GITHUB_REPOSITORY unset
        GITHUB_REPOSITORY: undefined,
      },
      [
        fixtureRepo,
        '--config-dir', singleCheckConfigDir,
        '--output', outputFile,
        '--pr', '7',
      ],
    );
    const out = stdout + stderr;
    // The CLI should reject the missing repo slug with E1001.
    assert.notEqual(exitCode, 0, out);
    assert.match(out, /E1001/);
  });

  it('rejects non-numeric --pr values', async () => {
    const { exitCode, stderr, stdout } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [
        fixtureRepo,
        '--config-dir', singleCheckConfigDir,
        '--output', outputFile,
        '--pr', 'abc',
      ],
    );
    const out = stdout + stderr;
    assert.notEqual(exitCode, 0, out);
    assert.match(out, /E1001/);
  });
});

describe('parseRepoSlug', () => {
  it('accepts a well-formed owner/repo slug', () => {
    assert.deepEqual(parseRepoSlug('octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  });

  it('accepts dots, dashes, underscores, and digits in either half', () => {
    assert.deepEqual(parseRepoSlug('a.b_c-1/x.y_z-2'), { owner: 'a.b_c-1', repo: 'x.y_z-2' });
  });

  it('rejects undefined / empty input', () => {
    assert.equal(parseRepoSlug(undefined), undefined);
    assert.equal(parseRepoSlug(''), undefined);
  });

  it('rejects missing slash or wrong number of parts', () => {
    assert.equal(parseRepoSlug('owner_only'), undefined);
    assert.equal(parseRepoSlug('a/b/c'), undefined);
  });

  it('rejects empty halves', () => {
    assert.equal(parseRepoSlug('/repo'), undefined);
    assert.equal(parseRepoSlug('owner/'), undefined);
  });

  it('rejects whitespace and shell-special characters in either half', () => {
    assert.equal(parseRepoSlug('own er/repo'), undefined);
    assert.equal(parseRepoSlug('owner/re;po'), undefined);
    assert.equal(parseRepoSlug('owner/$repo'), undefined);
    assert.equal(parseRepoSlug('owner/repo with space'), undefined);
  });
});
