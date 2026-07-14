/**
 * Integration tests for CLI mock agent provider mode (part 2).
 *
 * CLI flags, env vars, runtime config, ERROR/FLAG scenarios, debug mode,
 * and semgrep-only checks.
 *
 * Part 1 is in cli-mock-mode.test.ts.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile, unlink, access } from 'node:fs/promises';
import {
  testDir as __dirname,
  fixtureRepo,
  singleCheckConfigDir,
  multiTargetConfigDir,
  flagCheckConfigDir,
  mixedResultsConfigDir,
  semgrepOnlyConfigDir,
  mixedWithSemgrepOnlyConfigDir,
  sarifVerifyConfigDir,
  sarifVerifyEmptyConfigDir,
  perCheckModelConfigDir,
  failFixtureRepo,
  malformedFixture,
  cli3TargetsSarif,
  emptyResultsSarif,
  mixedDiscoveryConfigDir,
  fpValidationConfigDir,
  fpValidationFalsePositiveFixture,
  fpValidationTruePositiveFixture,
  createScopedHelpers,
} from './cli-test-helpers.js';

// Use scoped output paths to avoid conflicts when test files run concurrently
const { runCLI, runCLISarif, cleanupOutput, readResults, sarifOutputFile } = createScopedHelpers('part2');

// ─── Iteration 6: CLI flags, env vars, runtime config ────────────────────────

describe('CLI: --fail-on-check-failure flag', () => {
  afterEach(cleanupOutput);

  it('--fail-on-check-failure with PASS response exits 0', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--fail-on-check-failure']);
    assert.equal(exitCode, 0);
  });

  it('--fail-on-check-failure with FAIL response exits 1', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--fail-on-check-failure']);
    assert.equal(exitCode, 1);
  });

  it('without --fail-on-check-failure flag, FAIL response still exits 0', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: failFixtureRepo,
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir]);
    assert.equal(exitCode, 0);
  });
});

describe('CLI: --output flag', () => {
  it('--output <path> writes file to specified path', async () => {
    const tmpOutput = resolve(__dirname, 'fixtures', 'tmp-output.json');
    try {
      const { exitCode } = await runCLI(
        { AGHAST_MOCK_AI: 'true' },
        [fixtureRepo, '--config-dir', singleCheckConfigDir, '--output', tmpOutput]
      );
      assert.equal(exitCode, 0);
      await access(tmpOutput); // throws if file doesn't exist
    } finally {
      try {
        await unlink(tmpOutput);
      } catch {
        // File may not exist
      }
    }
  });
});

describe('CLI: ANTHROPIC_API_KEY and --agent-provider flag', () => {
  afterEach(cleanupOutput);

  it('missing ANTHROPIC_API_KEY and not logged in exits 1 with error message', async () => {
    // AGHAST_MOCK_LOCAL_LOGIN=false forces the local-login probe to report "not logged in"
    // so the test is hermetic regardless of the host's actual Claude login state.
    const { exitCode, stderr } = await runCLI({
      ANTHROPIC_API_KEY: '',
      AGHAST_LOCAL_CLAUDE: '',
      AGHAST_MOCK_AI: '',
      AGHAST_MOCK_LOCAL_LOGIN: 'false',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('ANTHROPIC_API_KEY'));
  });

  it('AGHAST_LOCAL_CLAUDE=true skips ANTHROPIC_API_KEY requirement', async () => {
    // This would fail at the API call stage (no real local Claude in tests),
    // but it should NOT fail with the credentials error.
    // Use a short timeout — we only need to confirm the API key check was skipped,
    // not wait for the full local Claude connection attempt to time out.
    const { stderr } = await runCLI({
      ANTHROPIC_API_KEY: undefined,
      AGHAST_LOCAL_CLAUDE: 'true',
      AGHAST_MOCK_AI: undefined,
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir], { timeout: 5_000 });
    assert.ok(!stderr.includes('No Claude credentials found'));
  });

  it('detected local login skips ANTHROPIC_API_KEY requirement', async () => {
    // No API key and AGHAST_LOCAL_CLAUDE unset: the provider auto-detects a logged-in
    // local session (mocked here). The auth gate should pass — the run fails later at the
    // real API call stage, but NOT with the credentials error.
    const { stderr } = await runCLI({
      ANTHROPIC_API_KEY: undefined,
      AGHAST_LOCAL_CLAUDE: undefined,
      AGHAST_MOCK_AI: undefined,
      AGHAST_MOCK_LOCAL_LOGIN: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir], { timeout: 5_000 });
    assert.ok(!stderr.includes('No Claude credentials found'));
  });

  it('unknown --agent-provider exits 1 with error message', async () => {
    const { exitCode, stderr } = await runCLI({
      AGHAST_MOCK_AI: undefined,
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--agent-provider', 'unknown-provider']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown agent provider'));
  });

  it('unknown --agent-provider error message lists known providers from registry', async () => {
    const { exitCode, stderr } = await runCLI({
      AGHAST_MOCK_AI: undefined,
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--agent-provider', 'unknown-provider']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown agent provider'), 'Should mention unknown provider');
    assert.ok(stderr.includes('claude-code'), 'Error should list claude-code as a valid option from registry');
  });

  it('--agent-provider claude-code (explicit) with mock mode exits 0', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--agent-provider', 'claude-code']);
    assert.equal(exitCode, 0);
  });

  it('--model flag is accepted (no error)', async () => {
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--model', 'claude-opus-4-6']);
    assert.equal(exitCode, 0);
  });
});

describe('CLI: --runtime-config flag', () => {
  afterEach(cleanupOutput);

  it('malformed runtime config exits 1 with error message', async () => {
    const malformedPath = resolve(__dirname, 'fixtures', 'runtime-config', 'malformed.json');
    const { exitCode, stderr } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--runtime-config', malformedPath]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Invalid JSON'));
  });

  it('valid runtime config is loaded without error', async () => {
    const validPath = resolve(__dirname, 'fixtures', 'runtime-config', 'valid.json');
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--runtime-config', validPath]);
    assert.equal(exitCode, 0);
  });

  it('missing runtime config file uses defaults', async () => {
    const absentPath = resolve(__dirname, 'fixtures', 'runtime-config', 'nonexistent.json');
    const { exitCode } = await runCLI({
      AGHAST_MOCK_AI: 'true',
    }, [fixtureRepo, '--config-dir', singleCheckConfigDir, '--runtime-config', absentPath]);
    assert.equal(exitCode, 0);
  });
});

// ─── Iteration 7: ERROR and FLAG scenarios ───────────────────────────────────

const flagResponseFixture = resolve(__dirname, 'fixtures', 'ai-responses', 'flag-response.json');

describe('CLI mock mode: ERROR and FLAG scenarios', () => {
  afterEach(cleanupOutput);

  it('FLAG single check: AGHAST_MOCK_AI=<flag-response> → status FLAG, flaggedChecks=1', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: flagResponseFixture },
      [fixtureRepo, '--config-dir', flagCheckConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'FLAG');
    assert.equal(checks[0].issuesFound, 0);
    assert.equal(summary.flaggedChecks, 1);
    assert.equal(summary.passedChecks, 0);
    assert.equal(summary.failedChecks, 0);
    assert.equal(summary.totalIssues, 0);
  });

  it('FLAG single check: stdout shows FLAG in summary banner', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: flagResponseFixture },
      [fixtureRepo, '--config-dir', flagCheckConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: REVIEW REQUIRED'), 'Summary banner should show REVIEW REQUIRED');
  });

  it('FLAG multi-target: all targets flag → check status FLAG, flaggedChecks=1', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: flagResponseFixture, AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', multiTargetConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'FLAG');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(summary.flaggedChecks, 1);
    assert.equal(summary.totalIssues, 0);
  });

  it('malformed AI response via AGHAST_MOCK_AI=<path> → ERROR status, exit code 0', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: malformedFixture },
      [fixtureRepo, '--config-dir', singleCheckConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'ERROR');
    assert.ok(checks[0].rawAiResponse, 'ERROR check should include rawAiResponse');
  });

  it('malformed AI + --fail-on-check-failure → exit code 1', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: malformedFixture },
      [fixtureRepo, '--config-dir', singleCheckConfigDir, '--fail-on-check-failure'],
    );
    assert.equal(exitCode, 1);
  });
});

// ─── Iteration 10: --debug flag and token usage ──────────────────────────────

describe('CLI mock mode: --debug flag', () => {
  afterEach(cleanupOutput);

  it('--debug produces [debug] output in stdout/stderr', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', singleCheckConfigDir, '--debug'],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('[debug]'), 'Debug output should contain [debug] tags');
  });

  it('--debug does not affect scan results or exit code', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', singleCheckConfigDir, '--debug'],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].issuesFound, 0);
  });

  it('non-debug mode does not show [debug] output', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', singleCheckConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(!combined.includes('[debug]'), 'Non-debug output should NOT contain [debug] tags');
  });

  it('--debug with FAIL response still exits correctly (no flag)', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [fixtureRepo, '--config-dir', singleCheckConfigDir, '--debug'],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
  });

  it('--debug with --fail-on-check-failure still exits 1 on FAIL', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [fixtureRepo, '--config-dir', singleCheckConfigDir, '--debug', '--fail-on-check-failure'],
    );
    assert.equal(exitCode, 1);
  });
});

// ─── Continued: ERROR and FLAG scenarios ─────────────────────────────────────

describe('CLI mock mode: ERROR and FLAG scenarios (continued)', () => {
  afterEach(cleanupOutput);

  it('partial results: Semgrep error + repo-wide PASS → 2 checks, errorChecks=1, exit 0', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: '/nonexistent/mock-semgrep.sarif' },
      [fixtureRepo, '--config-dir', mixedResultsConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 2, 'Both checks should appear in output');
    assert.equal(summary.totalChecks, 2);
    assert.equal(summary.errorChecks, 1);
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.totalIssues, 0);

    const repoWide = checks.find((c) => c.checkId === 'aghast-repo-wide');
    const multiTarget = checks.find((c) => c.checkId === 'aghast-mt-sqli');
    assert.ok(repoWide, 'Should have repo-wide check');
    assert.ok(multiTarget, 'Should have multi-target check');
    assert.equal(repoWide!.status, 'PASS');
    assert.equal(multiTarget!.status, 'ERROR');
  });
});

// ─── Semgrep-only checks ─────────────────────────────────────────────────────

describe('CLI mock mode: semgrep-only checks', () => {
  afterEach(cleanupOutput);

  it('PASS: empty SARIF → PASS, 0 issues', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].checkId, 'aghast-semgrep-only');
    assert.equal(checks[0].targetsAnalyzed, 0);
    assert.equal(checks[0].issuesFound, 0);
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.totalIssues, 0);
  });

  it('FAIL: 3 SARIF findings → FAIL, issues mapped with correct fields', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(checks[0].issuesFound, 3);
    assert.equal(issues.length, 3);
    assert.equal(summary.failedChecks, 1);
    assert.equal(summary.totalIssues, 3);

    // Verify issue fields from SARIF + check config
    for (const issue of issues) {
      assert.equal(issue.checkId, 'aghast-semgrep-only');
      assert.equal(issue.checkName, 'Semgrep-Only Check');
      assert.equal(issue.file, 'src/example.ts');
      assert.ok(issue.description, 'Should have description from SARIF message');
      assert.ok(typeof issue.startLine === 'number');
      assert.ok(typeof issue.endLine === 'number');
    }
  });

  it('severity and confidence from check config appear on issues', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;

    for (const issue of issues) {
      assert.equal(issue.severity, 'high', 'severity should come from check config');
      assert.equal(issue.confidence, 'high', 'confidence should come from check config');
    }
  });

  it('ERROR: bad mock SARIF path → ERROR status', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: '/nonexistent/bad.sarif' },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks[0].status, 'ERROR');
    assert.ok(checks[0].error, 'Should have error message');
    assert.equal(summary.errorChecks, 1);
  });

  it('summary banner shows ISSUES DETECTED when a check fails', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: ISSUES DETECTED'), 'Summary banner should show ISSUES DETECTED');
  });

  it('summary banner shows NO ISSUES DETECTED for empty SARIF', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: NO ISSUES DETECTED'), 'Summary banner should show NO ISSUES DETECTED');
  });

  it('mixed config: semgrep-only + AI check both processed', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', mixedWithSemgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 2);

    // AI check (aghast-sql-injection) should PASS (default mock AI returns empty issues)
    const aiCheck = checks.find((c) => c.checkId === 'aghast-sql-injection');
    assert.ok(aiCheck, 'Should have AI check');
    assert.equal(aiCheck!.status, 'PASS');

    // semgrep-only check should FAIL with 3 issues
    const sgoCheck = checks.find((c) => c.checkId === 'aghast-semgrep-only');
    assert.ok(sgoCheck, 'Should have semgrep-only check');
    assert.equal(sgoCheck!.status, 'FAIL');
    assert.equal(sgoCheck!.targetsAnalyzed, 3);
    assert.equal(sgoCheck!.issuesFound, 3);

    assert.equal(summary.totalChecks, 2);
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.failedChecks, 1);
    assert.equal(summary.totalIssues, 3);
  });

  it('semgrep-only scan does not log "Using model"', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(!combined.includes('Using model'), 'Semgrep-only scan should not log "Using model"');
  });

  it('semgrep-only scan sets agentProvider.name to "none" in results', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );

    const results = await readResults();
    const agentProvider = results.agentProvider as Record<string, unknown>;
    assert.equal(agentProvider.name, 'none', 'agentProvider.name should be "none" for semgrep-only scans');
    assert.deepEqual(agentProvider.models, [], 'agentProvider.models should be empty for semgrep-only scans');
  });

  it('mixed scan (AI + semgrep-only) still logs "Using model"', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', mixedWithSemgrepOnlyConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('Using model'), 'Mixed scan should log "Using model"');
  });

  it('SARIF output format includes semgrep-only findings', async () => {
    const { exitCode } = await runCLISarif(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir, '--output-format', 'sarif'],
    );
    assert.equal(exitCode, 0);

    const raw = await readFile(sarifOutputFile, 'utf-8');
    const sarif = JSON.parse(raw) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const sarifResults = runs[0].results as Array<Record<string, unknown>>;

    assert.equal(sarifResults.length, 3, 'SARIF should have 3 results from semgrep-only');
    for (const r of sarifResults) {
      assert.equal(r.ruleId, 'aghast-semgrep-only');
    }
  });

  it('--fail-on-check-failure exits 1 on FAIL', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir, '--fail-on-check-failure'],
    );
    assert.equal(exitCode, 1);
  });

  it('codeSnippet is extracted for semgrep-only findings', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: cli3TargetsSarif },
      [fixtureRepo, '--config-dir', semgrepOnlyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;

    // At least one issue should have codeSnippet (src/example.ts exists)
    const issueWithSnippet = issues.find((i) => i.codeSnippet !== undefined);
    assert.ok(issueWithSnippet, 'At least one issue should have codeSnippet');
    assert.ok(
      (issueWithSnippet!.codeSnippet as string).includes('SELECT'),
      'Snippet should contain SQL from fixture file',
    );
  });
});

// ─── sarif discovery checks ─────────────────────────────────────────

describe('CLI mock mode: sarif discovery checks', () => {
  afterEach(cleanupOutput);

  it('PASS: empty SARIF (0 findings) → PASS', async () => {
    // sarifVerifyEmptyConfigDir check points to sast-empty.sarif (0 findings)
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', sarifVerifyEmptyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const summary = results.summary as Record<string, number>;

    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].checkId, 'aghast-sarif-val');
    assert.equal(checks[0].targetsAnalyzed, 0);
    assert.equal(checks[0].issuesFound, 0);
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.totalIssues, 0);
  });

  it('PASS: SARIF with findings + mock AI returns empty issues → PASS (all false positives)', async () => {
    // Default AGHAST_MOCK_AI=true returns {"issues": []} for every target
    // sarifVerifyConfigDir check points to sast-3-targets.sarif (3 findings)
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', sarifVerifyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(checks[0].issuesFound, 0);
  });

  it('FAIL: SARIF with findings + mock AI returns issues → FAIL', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [fixtureRepo, '--config-dir', sarifVerifyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.ok(checks[0].issuesFound as number > 0);
    assert.ok(issues.length > 0);

    // Issues should have correct check metadata
    for (const issue of issues) {
      assert.equal(issue.checkId, 'aghast-sarif-val');
      assert.equal(issue.checkName, 'SARIF Verification Check');
    }
  });

  it('ERROR: sarifFile not found at specified path → ERROR status', async () => {
    // sarifVerifyConfigDir check points to sast-3-targets.sarif; run against a repo without it
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [singleCheckConfigDir, '--config-dir', sarifVerifyConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults(`${singleCheckConfigDir}/security_checks_results.json`);
    const checks = results.checks as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'ERROR');
    assert.ok(checks[0].error, `Expected error message`);
  });

  it('targetsAnalyzed field is present in check summary', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', sarifVerifyConfigDir],
    );

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].targetsAnalyzed, 3);
  });

  it('severity and confidence from check config appear on issues', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: failFixtureRepo },
      [fixtureRepo, '--config-dir', sarifVerifyConfigDir],
    );

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;

    for (const issue of issues) {
      assert.equal(issue.severity, 'high');
      assert.equal(issue.confidence, 'medium');
    }
  });
});

// ─── false-positive-validation mode: verdict + rationale ─────────────────────

describe('CLI mock mode: false-positive-validation rationale', () => {
  afterEach(cleanupOutput);

  it('FALSE POSITIVE: dismissals are retained as validation records with rationale', async () => {
    // 3 SARIF findings, AI returns {"issues":[], "verdict":"false-positive", "rationale": ...}
    // for every one → PASS, no issues, but a validations array recording the dismissals.
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: fpValidationFalsePositiveFixture },
      [fixtureRepo, '--config-dir', fpValidationConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;
    const validations = results.validations as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'PASS');
    assert.equal(checks[0].targetsAnalyzed, 3);
    assert.equal(issues.length, 0, 'False positives produce no issues');

    assert.ok(Array.isArray(validations), 'validations array should be present');
    assert.equal(validations.length, 3, 'One validation record per dismissed finding');
    for (const v of validations) {
      assert.equal(v.verdict, 'false-positive');
      assert.equal(v.checkId, 'aghast-fp-val');
      assert.match(v.rationale as string, /coerced to an integer/);
      assert.equal(v.issueIndex, undefined, 'False positives have no issueIndex');
      const target = v.target as Record<string, unknown>;
      assert.equal(target.file, 'src/example.ts');
      assert.ok(typeof target.startLine === 'number');
    }

    // Per-check verdict counts surface in the summary.
    const counts = checks[0].validationsCount as Record<string, number>;
    assert.deepEqual(counts, { truePositive: 0, falsePositive: 3 });
  });

  it('TRUE POSITIVE: confirmed findings produce issues and linked validation records', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: fpValidationTruePositiveFixture },
      [fixtureRepo, '--config-dir', fpValidationConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    const issues = results.issues as Array<Record<string, unknown>>;
    const validations = results.validations as Array<Record<string, unknown>>;

    assert.equal(checks[0].status, 'FAIL');
    assert.equal(issues.length, 3, 'One issue per confirmed finding');
    assert.equal(validations.length, 3);

    for (const v of validations) {
      assert.equal(v.verdict, 'true-positive');
      assert.match(v.rationale as string, /flows unsanitized/);
      // issueIndex links back to the confirmed issue in results.issues.
      const idx = v.issueIndex as number;
      assert.equal(typeof idx, 'number');
      assert.ok(issues[idx], 'issueIndex points at a real issue');
      assert.equal((issues[idx] as Record<string, unknown>).checkId, 'aghast-fp-val');
    }

    const counts = checks[0].validationsCount as Record<string, number>;
    assert.deepEqual(counts, { truePositive: 3, falsePositive: 0 });
  });

  it('SARIF output: false positives become pass results with a suppression justification', async () => {
    const { exitCode } = await runCLISarif(
      { AGHAST_MOCK_AI: fpValidationFalsePositiveFixture },
      [fixtureRepo, '--config-dir', fpValidationConfigDir, '--output-format', 'sarif'],
    );
    assert.equal(exitCode, 0);

    const raw = await readFile(sarifOutputFile, 'utf-8');
    const sarif = JSON.parse(raw) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const sarifResults = runs[0].results as Array<Record<string, unknown>>;

    assert.equal(sarifResults.length, 3, 'One pass result per dismissed finding');
    for (const r of sarifResults) {
      assert.equal(r.kind, 'pass');
      assert.equal(r.ruleId, 'aghast-fp-val');
      const suppressions = r.suppressions as Array<Record<string, unknown>>;
      assert.equal(suppressions.length, 1);
      assert.equal(suppressions[0].kind, 'external');
      assert.match(suppressions[0].justification as string, /coerced to an integer/);
    }
  });
});

// ─── Per-check model ─────────────────────────────────────────────────────────

describe('CLI: per-check model override', () => {
  afterEach(cleanupOutput);

  it('logs per-check model message when check has model field', async () => {
    const { stdout, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', perCheckModelConfigDir],
    );
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('per-check model'),
      'Should log per-check model override message',
    );
  });

  it('per-check model appears in results agentProvider.models', async () => {
    await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', perCheckModelConfigDir],
    );

    const results = await readResults();
    const agentProvider = results.agentProvider as { name: string; models: string[] };
    assert.ok(
      agentProvider.models.includes('claude-sonnet-4-6'),
      `models array should include the per-check model, got: ${JSON.stringify(agentProvider.models)}`,
    );
  });

  it('check with model field still produces valid PASS result', async () => {
    const { exitCode } = await runCLI(
      { AGHAST_MOCK_AI: 'true' },
      [fixtureRepo, '--config-dir', perCheckModelConfigDir],
    );
    assert.equal(exitCode, 0);

    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
  });
});

// ─── --generic-prompt with mixed discovery types ─────────────────────────────

describe('CLI: --generic-prompt with mixed discovery types', () => {
  afterEach(cleanupOutput);

  it('errors when --generic-prompt is used with checks having different discovery types', async () => {
    const { exitCode, stderr } = await runCLI(
      { AGHAST_MOCK_AI: 'true', AGHAST_MOCK_SARIF: emptyResultsSarif },
      [fixtureRepo, '--config-dir', mixedDiscoveryConfigDir, '--generic-prompt', 'custom-prompt.md'],
    );
    assert.notEqual(exitCode, 0, 'Should exit with error');
    assert.ok(
      stderr.includes('--generic-prompt') && stderr.includes('different discovery types'),
      `Expected mixed discovery error, got: ${stderr}`,
    );
  });
});
