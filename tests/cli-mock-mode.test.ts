/**
 * Integration tests for CLI mock agent provider mode (part 1).
 *
 * Spawns the actual CLI process with AGHAST_MOCK_AI=true to verify
 * the full pipeline end-to-end without a real agent provider.
 * Exercises: config loading, check filtering, prompt building, response
 * parsing, snippet extraction, issue enrichment, report generation,
 * and CLI output.
 *
 * Part 2 is in cli-mock-mode-2.test.ts.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile, unlink, access, copyFile } from 'node:fs/promises';
import { MOCK_MODEL_NAME } from '../src/types.js';
import {
  semgrepInstalled,
  testDir as __dirname,
  singleCheckConfigDir,
  multiCheckConfigDir,
  repoFilteredConfigDir,
  disabledConfigDir,
  invalidConfigDir,
  multiTargetConfigDir,
  multiTargetCappedConfigDir,
  mixedChecksConfigDir,
  semgrepOnlyConfigDir,
  globCheckConfigDir,
  scriptDiscoveryConfigDir,
  cli3TargetsSarif,
  emptyResultsSarif,
  noEndlineSarif,
  failFixtureRepo,
  multiIssueFixture,
  malformedFixture,
  missingFieldsFixture,
  dataFlowFixture,
  runCLI as baseRunCLI,
  createTempRepoCopy,
} from './cli-test-helpers.js';

// This file scans its own private copy of the fixture repo.
//
// Many tests here deliberately omit --output to assert the *default* output
// path and its per-format naming (.json/.sarif/.csv/.html), so they cannot be
// scoped by passing --output. Previously every CLI test file wrote those
// defaults into the one shared `fixtures/git-repo/`, and each file's
// `afterEach` cleanup deleted them — so concurrently running files raced,
// producing intermittent ENOENT on whichever test happened to be mid-assertion.
//
// A per-file copy keeps the default-path behaviour genuinely under test while
// giving this file a target nothing else touches.
const repoDir = createTempRepoCopy('mock-mode');
const outputFile = resolve(repoDir, 'security_checks_results.json');
const sarifOutputFile = resolve(repoDir, 'security_checks_results.sarif');
const csvOutputFile = resolve(repoDir, 'security_checks_results.csv');
const htmlOutputFile = resolve(repoDir, 'security_checks_results.html');
const markdownOutputFile = resolve(repoDir, 'security_checks_results.md');

/** Wraps the shared runCLI so the default scan target is this file's repo copy. */
function runCLI(
  env: Record<string, string | undefined> = {},
  args?: string[],
  options: { timeout?: number } = {},
) {
  return baseRunCLI(env, args ?? [repoDir, '--config-dir', singleCheckConfigDir], options);
}

async function readResults(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(outputFile, 'utf-8')) as Record<string, unknown>;
}

async function cleanupOutput(): Promise<void> {
  for (const f of [outputFile, sarifOutputFile, csvOutputFile, htmlOutputFile, markdownOutputFile]) {
    try {
      await unlink(f);
    } catch {
      // File may not exist; that's fine
    }
  }
}

const emptyInstructionsConfigDir = resolve(
  __dirname,
  'fixtures',
  'cli-configs',
  'empty-instructions',
);

// ─── PASS scenarios ──────────────────────────────────────────────────────────

describe('CLI mock mode: PASS scenarios', () => {
  afterEach(cleanupOutput);

  it('default mock response (AGHAST_MOCK_AI=true) produces PASS', async () => {
    const { exitCode } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].issuesFound, 0);
  });

  it('explicit pass-response.json fixture also produces PASS', async () => {
    const passFixture = resolve(__dirname, 'fixtures', 'ai-responses', 'pass-response.json');
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: passFixture,
    });
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal((results.issues as unknown[]).length, 0);
  });

  it('stdout indicates mock provider is active', async () => {
    const { stdout, stderr } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    const combined = stdout + stderr;
    assert.ok(combined.includes('Mock provider'), 'Should log mock provider message');
  });

  it('stdout shows "Using model: mock"', async () => {
    const { stdout, stderr } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    const combined = stdout + stderr;
    assert.ok(combined.includes(`Using model: ${MOCK_MODEL_NAME}`), 'Should show mock model name');
  });

  it('stdout shows PASS in summary banner', async () => {
    const { stdout, stderr } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: NO ISSUES DETECTED'), 'Summary banner should show NO ISSUES DETECTED');
  });
});

describe('CLI mock mode: invalid check instructions', () => {
  it('does not run a repository check with an empty instructions file', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', emptyInstructionsConfigDir],
    );

    assert.equal(exitCode, 1);
    assert.ok(
      (stdout + stderr).includes('is empty'),
      'Should explain that the instructions file is empty',
    );
  });
});

// ─── Output structure / ScanResults schema ───────────────────────────────────

describe('CLI mock mode: ScanResults output structure', () => {
  afterEach(cleanupOutput);

  it('writes security_checks_results.json to the repository directory', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    await readFile(outputFile, 'utf-8'); // throws if missing
  });

  it('output has all required top-level ScanResults fields', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();

    assert.ok(results.scanId, 'Should have scanId');
    assert.ok(results.timestamp, 'Should have timestamp');
    assert.ok(results.version, 'Should have version');
    assert.ok(results.repository, 'Should have repository');
    assert.ok(results.issues, 'Should have issues');
    assert.ok(results.checks, 'Should have checks');
    assert.ok(results.summary, 'Should have summary');
    assert.ok(results.startTime, 'Should have startTime');
    assert.ok(results.endTime, 'Should have endTime');
    assert.ok(results.agentProvider, 'Should have agentProvider');
    assert.equal(typeof results.executionTime, 'number', 'executionTime should be a number');
  });

  it('scanId follows the scan-<timestamp>-<hash> format', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    assert.match(results.scanId as string, /^scan-\d{14}-[a-f0-9]{6}$/);
  });

  it('timestamp and startTime/endTime are valid ISO 8601', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    for (const field of ['timestamp', 'startTime', 'endTime']) {
      const val = results[field] as string;
      assert.ok(!isNaN(Date.parse(val)), `${field} should be valid ISO date: ${val}`);
    }
  });

  it('agentProvider shows mock model', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const agentProvider = results.agentProvider as { name: string; models: string[] };
    assert.equal(agentProvider.name, 'mock');
    assert.ok(agentProvider.models.includes(MOCK_MODEL_NAME), `models should include "${MOCK_MODEL_NAME}"`);
  });

  it('repository info contains the scanned repo path', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const repo = results.repository as Record<string, unknown>;
    assert.equal(typeof repo.path, 'string');
    // Asserts the exact target rather than a substring: this file scans its own
    // copy of the fixture repo, so the path is the copy, not tests/fixtures/git-repo.
    assert.equal(repo.path, repoDir, 'repo path should be the scanned repo');
  });

  it('summary fields are consistent with checks', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const summary = results.summary as Record<string, number>;
    assert.equal(summary.totalChecks, 1);
    assert.equal(
      summary.passedChecks + summary.failedChecks + summary.flaggedChecks + summary.errorChecks,
      summary.totalChecks,
      'pass+fail+flagged+error should equal totalChecks',
    );
  });

  it('summary includes flaggedChecks field', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const summary = results.summary as Record<string, number>;
    assert.equal(typeof summary.flaggedChecks, 'number', 'flaggedChecks should be a number');
    assert.equal(summary.flaggedChecks, 0);
  });

  it('output does not have top-level branch or commit fields', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    assert.equal(results.branch, undefined, 'Should not have top-level branch');
    assert.equal(results.commit, undefined, 'Should not have top-level commit');
  });
});

// ─── Check metadata ─────────────────────────────────────────────────────────

describe('CLI mock mode: check ID and name from config', () => {
  afterEach(cleanupOutput);

  it('checkId comes from config id field', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].checkId, 'aghast-sql-injection');
  });

  it('checkName is extracted from the ### heading in check markdown', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].checkName, 'SQL Injection Prevention');
  });

  it('multi-check config produces distinct checkIds and checkNames', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiCheckConfigDir],
    );
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].checkId, 'aghast-sql-injection');
    assert.equal(checks[0].checkName, 'SQL Injection Prevention');
    assert.equal(checks[1].checkId, 'aghast-api-authz');
    assert.equal(checks[1].checkName, 'Minimal Check');
  });
});

// ─── FAIL scenarios ──────────────────────────────────────────────────────────

describe('CLI mock mode: FAIL scenarios', () => {
  afterEach(cleanupOutput);

  it('single issue: check status is FAIL with correct counts', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    });
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].issuesFound, 1);
    assert.equal(summary.failedChecks, 1);
    assert.equal(summary.passedChecks, 0);
    assert.equal(summary.totalIssues, 1);
  });

  it('issues are enriched with checkId and checkName from config', async () => {
    await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    });
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const issue = issues[0];

    assert.equal(issue.checkId, 'aghast-sql-injection');
    assert.equal(issue.checkName, 'SQL Injection Prevention');
  });

  it('codeSnippet is extracted from existing file in fixture repo', async () => {
    await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    });
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const issue = issues[0];

    assert.equal(issue.file, 'src/example.ts');
    assert.equal(issue.startLine, 3);
    assert.equal(issue.endLine, 5);
    assert.ok(typeof issue.codeSnippet === 'string', 'Should have codeSnippet');
    assert.ok(
      (issue.codeSnippet as string).includes('SELECT'),
      'Snippet should contain SQL query from fixture file',
    );
  });

  it('multiple issues: all issues are enriched and counted', async () => {
    await runCLI({
      AGHAST_MOCK_AI: multiIssueFixture,
    });
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(issues.length, 2);
    assert.equal(checks[0].issuesFound, 2);
    assert.equal(summary.totalIssues, 2);

    // Both issues should have checkId/checkName from config
    for (const issue of issues) {
      assert.equal(issue.checkId, 'aghast-sql-injection');
      assert.equal(issue.checkName, 'SQL Injection Prevention');
      assert.ok(issue.codeSnippet, 'Each issue should have codeSnippet from fixture repo');
    }
  });

  it('issue referencing non-existent file has no codeSnippet', async () => {
    // fail-single-issue-response.json references src/auth/login.ts which does not exist in fixture repo
    const failFixture = resolve(__dirname, 'fixtures', 'ai-responses', 'fail-single-issue-response.json');
    await runCLI({
      AGHAST_MOCK_AI: failFixture,
    });
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;

    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, 'src/auth/login.ts');
    assert.equal(issues[0].codeSnippet, undefined, 'Should not have codeSnippet for missing file');
  });

  it('stdout shows FAIL in summary banner', async () => {
    const { stdout, stderr } = await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    });
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: ISSUES DETECTED'), 'Summary banner should show ISSUES DETECTED');
  });
});

// ─── ERROR scenarios ─────────────────────────────────────────────────────────

describe('CLI mock mode: ERROR scenarios', () => {
  afterEach(cleanupOutput);

  it('malformed (non-JSON) response produces ERROR status', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: malformedFixture,
    });
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'ERROR');
    assert.ok(checks[0].error, 'Should have error message');
    assert.equal(summary.errorChecks, 1);
    assert.equal(summary.totalIssues, 0);
    assert.equal((results.issues as unknown[]).length, 0);
  });

  it('response with wrong schema (missing issues array) produces ERROR', async () => {
    await runCLI({
      AGHAST_MOCK_AI: missingFieldsFixture,
    });
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'ERROR');
    assert.ok(checks[0].error, 'Should have error message for missing issues field');
  });

  it('stdout shows ERROR in summary banner for malformed response', async () => {
    const { stdout, stderr } = await runCLI({
      AGHAST_MOCK_AI: malformedFixture,
    });
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: SCAN ERROR'), 'Summary banner should show SCAN ERROR');
  });

  it('ERROR check has rawAiResponse in check summary', async () => {
    await runCLI({
      AGHAST_MOCK_AI: malformedFixture,
    });
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.ok(checks[0].rawAiResponse, 'ERROR check should include rawAiResponse');
    assert.ok(
      (checks[0].rawAiResponse as string).includes('not valid JSON'),
      'rawAiResponse should contain the malformed content',
    );
  });
});

// ─── CLI argument handling ───────────────────────────────────────────────────

describe('CLI mock mode: argument and env var handling', () => {
  afterEach(cleanupOutput);

  it('missing arguments shows help and exits with code 0', async () => {
    const { exitCode, stdout } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [],  // no args
    );
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast scan'), 'Should print scan help');
  });

  it('non-existent AGHAST_MOCK_AI path exits with code 1', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: '/does/not/exist/response.json',
    });
    assert.equal(exitCode, 1);
  });
});

// ─── Check execution timing ─────────────────────────────────────────────────

describe('CLI mock mode: execution timing', () => {
  afterEach(cleanupOutput);

  it('check has non-negative executionTime', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.ok(
      (checks[0].executionTime as number) >= 0,
      'executionTime should be non-negative',
    );
  });

  it('scan executionTime is non-negative and endTime >= startTime', async () => {
    await runCLI({ AGHAST_MOCK_AI: 'true' });
    const results = await readResults();
    assert.ok((results.executionTime as number) >= 0);

    const start = new Date(results.startTime as string).getTime();
    const end = new Date(results.endTime as string).getTime();
    assert.ok(end >= start, 'endTime should be >= startTime');
  });
});

// ─── Config-based multi-check mode ──────────────────────────────────────────

describe('CLI mock mode: config-based multi-check', () => {
  afterEach(cleanupOutput);

  it('runs multiple checks from config file', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiCheckConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 2, 'Should run both checks from config');
    assert.equal(summary.totalChecks, 2);
    assert.equal(summary.passedChecks, 2);
    assert.equal(summary.failedChecks, 0);
    assert.equal(summary.flaggedChecks, 0);
    assert.equal(summary.errorChecks, 0);
    assert.equal(summary.totalIssues, 0);
  });

  it('each check has distinct checkId from config', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiCheckConfigDir],
    );
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].checkId, 'aghast-sql-injection');
    assert.equal(checks[1].checkId, 'aghast-api-authz');
  });

  it('each check has checkName from markdown heading', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiCheckConfigDir],
    );
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].checkName, 'SQL Injection Prevention');
    assert.equal(checks[1].checkName, 'Minimal Check');
  });

  it('stdout summary shows correct total checks count', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiCheckConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('Total checks:  2'), 'Summary should show 2 total checks');
  });
});

// ─── Repository filtering ───────────────────────────────────────────────────

describe('CLI mock mode: repository filtering', () => {
  afterEach(cleanupOutput);

  it('only runs checks matching the repository', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', repoFilteredConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    // Only the "all repos" check should run
    assert.equal(checks.length, 1, 'Only the matching check should run');
    assert.equal(checks[0].checkId, 'aghast-all-repos');
    assert.equal(summary.totalChecks, 1);
  });

  it('produces empty results when no checks match', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', repoFilteredConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('Found 1 matching checks (of 2 total)'),
      'Should log the filtering result',
    );
  });
});

// ─── Disabled checks ────────────────────────────────────────────────────────

describe('CLI mock mode: disabled checks', () => {
  afterEach(cleanupOutput);

  it('skips disabled checks', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', disabledConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    // Only the enabled check should run
    assert.equal(checks.length, 1);
    assert.equal(checks[0].checkId, 'aghast-enabled-check');
    assert.equal(summary.totalChecks, 1);
    assert.equal(summary.passedChecks, 1);
  });

  it('stdout shows only enabled check count', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', disabledConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('Found 1 matching checks (of 2 total)'),
      'Should filter out disabled check',
    );
  });
});

// ─── Config error handling ──────────────────────────────────────────────────

describe('CLI mock mode: config error handling', () => {
  afterEach(cleanupOutput);

  it('exits with code 1 when config dir has no checks-config.json', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', resolve(__dirname, 'nonexistent-config-dir')],
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('missing checks-config.json'), 'Should report missing checks-config.json');
  });

  it('exits with code 1 when checks-config.json has invalid JSON', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', invalidConfigDir],
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('invalid JSON') || stderr.includes('Fatal Error'), 'Should show error for invalid JSON');
  });
});

// ─── Data flow ──────────────────────────────────────────────────────────────

describe('CLI mock mode: dataFlow support', () => {
  afterEach(cleanupOutput);

  it('JSON output includes dataFlow when AI response contains it', async () => {
    await runCLI({
      AGHAST_MOCK_AI: dataFlowFixture,
    });
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const issue = issues[0];

    assert.ok(issue.dataFlow, 'Issue should have dataFlow');
    const dataFlow = issue.dataFlow as Array<Record<string, unknown>>;
    assert.equal(dataFlow.length, 2);
    assert.equal(dataFlow[0].file, 'src/example.ts');
    assert.equal(dataFlow[0].lineNumber, 1);
    assert.equal(dataFlow[0].label, 'User input received from function parameter');
    assert.equal(dataFlow[1].lineNumber, 3);
  });

  it('SARIF output includes codeFlows when dataFlow is present', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: dataFlowFixture },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'sarif'],
    );

    const raw = await readFile(sarifOutputFile, 'utf-8');
    const sarif = JSON.parse(raw) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    const result = results[0];

    assert.ok(result.codeFlows, 'SARIF result should have codeFlows');
    const codeFlows = result.codeFlows as Array<Record<string, unknown>>;
    const threadFlows = codeFlows[0].threadFlows as Array<Record<string, unknown>>;
    const locations = threadFlows[0].locations as Array<Record<string, unknown>>;

    assert.equal(locations.length, 2);
    const loc0 = locations[0].location as Record<string, unknown>;
    const phys0 = loc0.physicalLocation as Record<string, unknown>;
    const artifact0 = phys0.artifactLocation as Record<string, unknown>;
    assert.equal(artifact0.uri, 'src/example.ts');
  });
});

// ─── Output format ───────────────────────────────────────────────────────────

describe('CLI mock mode: output format', () => {
  afterEach(cleanupOutput);

  it('default (no flag) writes .json file', async () => {
    const { exitCode } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    assert.equal(exitCode, 0);
    const raw = await readFile(outputFile, 'utf-8');
    const results = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(results.scanId, 'Should be valid ScanResults JSON');
  });

  it('--output-format json produces same as default', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'json'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(outputFile, 'utf-8');
    const results = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(results.scanId, 'Should be valid ScanResults JSON');
  });

  it('--output-format sarif with PASS writes .sarif with valid structure', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'sarif'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(sarifOutputFile, 'utf-8');
    const sarif = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(sarif.version, '2.1.0');
    assert.ok((sarif.$schema as string).includes('sarif-schema'));
    const runs = sarif.runs as Array<Record<string, unknown>>;
    assert.equal(runs.length, 1);
    const results = runs[0].results as unknown[];
    assert.equal(results.length, 0, 'PASS scan should have empty results');
  });

  it('--output-format sarif with FAIL produces results with correct fields', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'sarif'],
    );
    assert.equal(exitCode, 0);

    const raw = await readFile(sarifOutputFile, 'utf-8');
    const sarif = JSON.parse(raw) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;

    assert.ok(results.length > 0, 'FAIL scan should have results');
    const result = results[0];
    assert.equal(result.ruleId, 'aghast-sql-injection');
    assert.ok(result.level, 'Should have level');
    assert.ok(result.message, 'Should have message');

    const locations = result.locations as Array<Record<string, unknown>>;
    assert.ok(locations.length > 0, 'Should have locations');
  });

  it('SARIF format does not write .json file', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'sarif'],
    );
    await assert.rejects(
      access(outputFile),
      'Should NOT create .json file when using sarif format',
    );
  });

  it('unknown format exits with code 1 and lists available formats', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'xml'],
    );
    assert.equal(exitCode, 1);
    const combined = stderr;
    assert.ok(combined.includes('Unknown output format'), 'Should mention unknown format');
    assert.ok(combined.includes('json'), 'Should list json as available');
    assert.ok(combined.includes('sarif'), 'Should list sarif as available');
    assert.ok(combined.includes('markdown'), 'Should list markdown as available');
  });

  it('--output-format markdown with PASS writes a Markdown report with all required sections', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'markdown'],
    );
    assert.equal(exitCode, 0);
    const md = await readFile(markdownOutputFile, 'utf-8');
    assert.ok(md.startsWith('# Security Scan Report'), 'Should start with the H1 title');
    assert.ok(md.includes('## Executive Summary'));
    assert.ok(md.includes('## Summary Table'));
    assert.ok(md.includes('## Detailed Findings'));
    assert.ok(md.includes('## Statistics'));
    // Mock provider name should appear in the header
    assert.ok(md.includes('mock'));
    // Output ends with exactly one trailing newline (formatter contract).
    assert.ok(md.endsWith('\n'), 'file ends with a newline');
    assert.ok(!md.endsWith('\n\n'), 'file does not end with a double newline');
  });

  it('--output-format markdown with FAIL renders an Issue block with code and language tag', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'markdown'],
    );
    assert.equal(exitCode, 0);

    const md = await readFile(markdownOutputFile, 'utf-8');
    assert.ok(md.includes('## Detailed Findings'));
    assert.ok(md.includes('#### Issue 1:'), 'Should render an issue subsection');
    // failFixtureRepo targets src/example.ts; pin the assertion to a fence
    // beginning at the start of a line so a regression that swaps the
    // language tag (e.g. to "tsx") is caught instead of silently passing.
    assert.ok(/^```ts$/m.test(md), 'snippet fence opens with ```ts at start of a line');
  });

  it('Markdown format does not write .json or .sarif file', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'markdown'],
    );
    await assert.rejects(access(outputFile), 'Should NOT create .json file');
    await assert.rejects(access(sarifOutputFile), 'Should NOT create .sarif file');
  });

  it('summary banner shows correct .md path for markdown format', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'markdown'],
    );
    const combined = stdout + stderr;
    // Strong assertion: the banner must reference the actual `.md` output
    // file path (not just the substring `.md`), and must NOT mention a
    // sibling `.json` / `.sarif` path.
    assert.ok(
      combined.includes(markdownOutputFile),
      `banner should reference ${markdownOutputFile}, got: ${combined}`,
    );
    assert.ok(!combined.includes(outputFile), 'banner should not mention .json output');
    assert.ok(!combined.includes(sarifOutputFile), 'banner should not mention .sarif output');
  });

  it('--output-format with no value exits with code 1', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format'],
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('--output-format requires'), 'Should show missing argument error');
  });

  it('summary banner shows correct .sarif path', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'sarif'],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('.sarif'), 'Summary should show .sarif path');
  });
});

// ─── Output format: CSV ──────────────────────────────────────────────────────

describe('CLI mock mode: CSV output format', () => {
  afterEach(cleanupOutput);

  it('--output-format csv with PASS writes a .csv with header row only', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'csv'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(csvOutputFile, 'utf-8');
    const lines = raw.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'PASS scan should have header row only');
    assert.ok(lines[0].startsWith('checkId,checkName,status,'));
  });

  it('--output-format csv with FAIL writes one row per issue', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'csv'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(csvOutputFile, 'utf-8');
    const lines = raw.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2, 'FAIL scan with 1 issue: header + 1 issue row');
    assert.ok(lines[1].includes('aghast-sql-injection'));
    assert.ok(lines[1].includes('FAIL'));
  });

  it('CSV format does not write .json file', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'csv'],
    );
    await assert.rejects(
      access(outputFile),
      'Should NOT create .json file when using csv format',
    );
  });

  it('summary banner shows correct .csv path', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'csv'],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('.csv'), 'Summary should show .csv path');
  });
});

// ─── Output format: HTML ─────────────────────────────────────────────────────

describe('CLI mock mode: HTML output format', () => {
  afterEach(cleanupOutput);

  it('--output-format html with PASS writes a self-contained HTML file', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'html'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(htmlOutputFile, 'utf-8');
    assert.ok(raw.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    assert.ok(raw.includes('<style>'), 'should include inline CSS');
    assert.ok(raw.includes('<script id="aghast-results"'), 'should include embedded JSON');
    assert.ok(raw.includes('No issues detected'), 'PASS scan should show empty-state message');
  });

  it('--output-format html with FAIL embeds issue data in the HTML', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'html'],
    );
    assert.equal(exitCode, 0);
    const raw = await readFile(htmlOutputFile, 'utf-8');
    assert.ok(raw.includes('aghast-sql-injection'));
    assert.ok(raw.includes('SQL Injection Prevention'));
    // Expect a <details> block per check
    assert.ok(raw.includes('<details>'));
  });

  it('HTML format does not write .json file', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'html'],
    );
    await assert.rejects(
      access(outputFile),
      'Should NOT create .json file when using html format',
    );
  });

  it('summary banner shows correct .html path', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir, '--output-format', 'html'],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('.html'), 'Summary should show .html path');
  });
});

// ─── --generic-prompt flag ───────────────────────────────────────────────────

const customPromptFixture = resolve(__dirname, 'fixtures', 'prompts', 'aghast-test-b7f3e9a2d1c4.md');
const customPromptTarget = resolve(singleCheckConfigDir, 'prompts', 'aghast-test-b7f3e9a2d1c4.md');

describe('CLI mock mode: --generic-prompt flag', () => {
  afterEach(async () => {
    await cleanupOutput();
    try {
      await unlink(customPromptTarget);
    } catch {
      // File may not exist; that's fine
    }
  });

  it('custom prompt file produces successful scan', async () => {
    await copyFile(customPromptFixture, customPromptTarget);
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir,       '--generic-prompt', 'aghast-test-b7f3e9a2d1c4.md'],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
  });

  it('non-existent prompt file exits with code 1', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir,       '--generic-prompt', 'nonexistent-prompt.md'],
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Fatal Error'), 'Should show fatal error for missing prompt file');
  });

  it('path traversal in filename is rejected', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir,       '--generic-prompt', '../ai-checks/foo.md'],
    );
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes('Invalid generic prompt filename'),
      'Should show validation error for path traversal',
    );
  });

  it('backslash path separator in filename is rejected', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', singleCheckConfigDir,       '--generic-prompt', 'subdir\\prompt.md'],
    );
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes('Invalid generic prompt filename'),
      'Should show validation error for backslash path',
    );
  });
});

// ─── Multi-target checks ────────────────────────────────────────────────────

describe('CLI mock mode: multi-target checks', () => {
  afterEach(cleanupOutput);

  it('PASS: default mock response with 3 targets → PASS, targetsAnalyzed: 3', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(checks[0].issuesFound, 0);
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.totalIssues, 0);
  });

  it('FAIL: mock response with issues → FAIL for all targets', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: failFixtureRepo,
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;
    const issues = results.issues as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].targetsAnalyzed, 3);
    // Same response for all 3 targets = 3 issues (1 per target)
    assert.equal(issues.length, 3);
    assert.equal(summary.failedChecks, 1);
    assert.equal(summary.totalIssues, 3);

    // All issues enriched with check metadata
    for (const issue of issues) {
      assert.equal(issue.checkId, 'aghast-mt-sqli');
      assert.equal(issue.checkName, 'SQL Injection Prevention');
    }
  });

  it('maxIssuesPerTarget: caps issues per target when set in checkTarget', async () => {
    // Without cap, multiIssueFixture (2 issues per response) × 3 targets = 6 issues.
    // With maxIssuesPerTarget: 1 in checkTarget, only the first issue per target
    // is kept → 3 issues total.
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: multiIssueFixture,
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', multiTargetCappedConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(issues.length, 3, 'Cap of 1 issue per target × 3 targets = 3 issues');

    // The kept issue is the first entry of the AI response — multi-issue-fixture-repo.json's
    // first issue describes "SQL injection" at lines 3-5.
    for (const issue of issues) {
      assert.match(issue.description as string, /SQL injection/i);
    }
  });

  it('maxIssuesPerTarget unset (multi-target config): all issues per target are kept', async () => {
    // Sanity check the inverse: same fixtures against the un-capped config should
    // yield 6 issues (2 per target × 3 targets), confirming the cap is opt-in.
    await runCLI(
      {
        AGHAST_MOCK_AI: multiIssueFixture,
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 6, 'No cap = 2 issues × 3 targets = 6 issues');
  });

  it('empty SARIF: 0 targets → PASS, targetsAnalyzed: 0', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 0);
    assert.equal(checks[0].issuesFound, 0);
  });

  it('missing Semgrep (no mock) → exits 1 with informative message', { skip: semgrepInstalled }, async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );

    // Semgrep is not installed: should exit early with a clear error
    assert.equal(exitCode, 1);
    assert.ok(
      stderr.includes('Semgrep is required') || stderr.includes('Semgrep not found'),
      `stderr should mention Semgrep requirement, got: ${stderr}`,
    );
  });

  it('repository-wide check in mixed config still works (no regression)', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [repoDir, '--config-dir', mixedChecksConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 2);
    // First check is repo-wide, should PASS
    assert.equal(checks[0].checkId, 'aghast-repo-wide');
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, undefined); // repo-wide has no targetsAnalyzed

    // Second check is multi-target, should PASS with targets
    assert.equal(checks[1].checkId, 'aghast-mt-sqli');
    assert.equal(checks[1].status, 'PASS');
    assert.equal(checks[1].targetsAnalyzed, 3);

    assert.equal(summary.totalChecks, 2);
    assert.equal(summary.passedChecks, 2);
  });

  it('targetsAnalyzed present in check summary output', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.ok('targetsAnalyzed' in checks[0], 'targetsAnalyzed should be present in check summary');
    assert.equal(typeof checks[0].targetsAnalyzed, 'number');
  });

  it('codeSnippet is extracted for multi-target issues', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: failFixtureRepo,
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;

    // The fail fixture references src/example.ts which exists in git-repo
    assert.ok(issues.length > 0);
    const issueWithSnippet = issues.find((i) => i.codeSnippet !== undefined);
    assert.ok(issueWithSnippet, 'At least one issue should have codeSnippet');
    assert.ok(
      (issueWithSnippet!.codeSnippet as string).includes('SELECT'),
      'Snippet should contain SQL from fixture file',
    );
  });

  it('stdout shows PASS in summary banner for multi-target', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: NO ISSUES DETECTED'), 'Summary banner should show NO ISSUES DETECTED');
  });

  it('SARIF result without endLine is processed (endLine defaults to startLine)', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: noEndlineSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks.length, 1);
    assert.equal(checks[0].targetsAnalyzed, 1, 'Single target without endLine should be processed');
    assert.equal(checks[0].status, 'PASS');
  });
});

// ─── Concurrency progress output ─────────────────────────────────────────────

describe('CLI mock mode: concurrency progress output', () => {
  afterEach(cleanupOutput);

  it('stdout/stderr contains concurrency and progress messages', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('targets to analyze'),
      'Should log target count with "targets to analyze"',
    );
    assert.ok(
      combined.includes('concurrency:'),
      'Should log concurrency info',
    );
  });

  it('multi-target FAIL regression: results correct under concurrent execution', async () => {
    const { exitCode } = await runCLI(
      {
        AGHAST_MOCK_AI: failFixtureRepo,
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(issues.length, 3);

    for (const issue of issues) {
      assert.equal(issue.checkId, 'aghast-mt-sqli');
      assert.equal(issue.checkName, 'SQL Injection Prevention');
      assert.ok(issue.file, 'Each issue should have a file');
      assert.ok(issue.description, 'Each issue should have a description');
    }
  });
});

// ─── Glob discovery (Spec E.2.1) ─────────────────────────────────────────────

describe('CLI mock mode: glob discovery', () => {
  afterEach(cleanupOutput);

  it('PASS: glob check matches files and AI returns no issues → PASS', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', globCheckConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 1);
    assert.equal(checks[0].checkId, 'aghast-glob-test');
    assert.equal(checks[0].status, 'PASS');
    // git-repo fixture has src/example.ts → exactly 1 file matches src/**/*.ts
    assert.equal(checks[0].targetsAnalyzed, 1, 'Should discover 1 .ts file in src/');
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.totalIssues, 0);
  });

  it('FAIL: glob check + failing mock response → FAIL with enriched issue', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [repoDir, '--config-dir', globCheckConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].targetsAnalyzed, 1);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].checkId, 'aghast-glob-test');
    assert.equal(issues[0].checkName, 'Glob Discovery Test');
    // The glob "src/**/*.ts" should match exactly src/example.ts in the
    // git-repo fixture — assert the file path so this test fails loudly if
    // someone adds another .ts file to the fixture (which would silently
    // change the target set without this assertion).
    assert.equal(issues[0].file, 'src/example.ts');
  });
});

// ─── Conditional prerequisite validation ──────────────────────────────────────

describe('CLI: conditional prerequisite validation', () => {
  afterEach(cleanupOutput);

  it('static checks succeed without ANTHROPIC_API_KEY', async () => {
    const { exitCode, stderr } = await runCLI(
      {
        ANTHROPIC_API_KEY: '',
        AGHAST_LOCAL_CLAUDE: '',
        AGHAST_MOCK_AI: '',
        AGHAST_MOCK_SARIF: emptyResultsSarif,
      },
      [repoDir, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);
    assert.ok(!stderr.includes('ANTHROPIC_API_KEY'), 'Should not require API key for static checks');

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].checkId, 'aghast-semgrep-only');
  });

  it('static FAIL checks succeed without ANTHROPIC_API_KEY', async () => {
    const { exitCode, stderr } = await runCLI(
      {
        ANTHROPIC_API_KEY: '',
        AGHAST_LOCAL_CLAUDE: '',
        AGHAST_MOCK_AI: '',
        AGHAST_MOCK_SARIF: cli3TargetsSarif,
      },
      [repoDir, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].issuesFound, 3);
  });
});

// ─── CI/CD metadata (spec E.4) ──────────────────────────────────────────────

describe('CLI mock mode: CI/CD metadata', () => {
  afterEach(cleanupOutput);

  it('omits ciMetadata when no CI env vars are set', async () => {
    const { exitCode } = await runCLI({ AGHAST_MOCK_AI: 'true' });
    assert.equal(exitCode, 0);

    const results = await readResults();
    // Either no metadata at all, or metadata without ciMetadata.
    const metadata = results.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      assert.equal(metadata.ciMetadata, undefined);
    }
  });

  it('populates ciMetadata when GitHub Actions env is provided', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'BounceSecurity/aghast-internal',
      GITHUB_RUN_ID: '999',
      GITHUB_REF_NAME: 'feat/stretch-116-ci-metadata',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_RUN_STARTED_AT: '2026-05-04T12:00:00Z',
    });
    assert.equal(exitCode, 0);

    const results = await readResults();
    const metadata = results.metadata as Record<string, unknown> | undefined;
    assert.ok(metadata, 'metadata should be present');
    const ciMetadata = metadata.ciMetadata as Record<string, unknown> | undefined;
    assert.ok(ciMetadata, 'ciMetadata should be present');
    assert.equal(
      ciMetadata.jobUrl,
      'https://github.com/BounceSecurity/aghast-internal/actions/runs/999',
    );
    assert.equal(ciMetadata.branch, 'feat/stretch-116-ci-metadata');
    assert.equal(ciMetadata.pipelineSource, 'push');
    assert.equal(ciMetadata.jobStartedAt, '2026-05-04T12:00:00Z');
  });
});

// ─── Script-based target discovery ────────────────────────────────────────────

describe('CLI mock mode: script discovery', () => {
  afterEach(cleanupOutput);

  it('PASS: script emits 3 lines, mock AI returns no issues per target', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [repoDir, '--config-dir', scriptDiscoveryConfigDir],
    );
    assert.equal(exitCode, 0, `Expected exit 0 but got ${exitCode}. stderr: ${stderr}`);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks.length, 1);
    assert.equal(checks[0].checkId, 'aghast-script-demo');
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 3, 'Should analyze 3 targets from script output');
    assert.equal(checks[0].issuesFound, 0);
  });
});
