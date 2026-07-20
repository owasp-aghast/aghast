/**
 * CLI integration tests for the LLM judge stage.
 *
 * Spawns the real CLI with AGHAST_MOCK_AI=true and AGHAST_MOCK_JUDGE=<fixture>
 * to verify the judge pipeline end-to-end without live API calls.
 *
 * Coverage:
 * - Default off (no judge flags): identical output to pre-judge runs
 * - Enabled annotation only: issues get judge field, summary.judgedIssues populated
 * - --judge-drop-false-positives: FP issues removed, checks recomputed
 * - Uncertain → FLAG escalation: check becomes FLAG, flagSource:"judge"
 * - --judge-min-confidence: low-confidence TP demoted to uncertain → FLAG
 * - Per-check judge: false opt-out: issue skipped by judge
 * - Static-check issues judged (decision #3)
 * - Judge-stage failure (malformed response): verdict uncertain, check FLAG
 * - Mixed-provider mock: agentProvider.models lists both
 * - SARIF output: properties.judge and flagSource surfaced
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureRepo,
  singleCheckConfigDir,
  semgrepOnlyConfigDir,
  failFixtureRepo,
  cli3TargetsSarif,
  createScopedHelpers,
} from './cli-test-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));

const judgeResponses = resolve(testDir, 'fixtures', 'judge-responses');
const judgeOptOutConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'judge-opt-out');

const judgeTpFixture = resolve(judgeResponses, 'judge-tp-response.json');
const judgeFpFixture = resolve(judgeResponses, 'judge-fp-response.json');
const judgeUncertainFixture = resolve(judgeResponses, 'judge-uncertain-response.json');
const judgeLowConfFixture = resolve(judgeResponses, 'judge-low-confidence-tp.json');
const judgeMalformedFixture = resolve(judgeResponses, 'judge-malformed.txt');

// Use scoped helpers so parallel test files don't collide on output files.
const { runCLI: scopedRun, cleanupOutput, readResults, sarifOutputFile, runCLISarif } =
  createScopedHelpers('judge');

// ─── Default off ─────────────────────────────────────────────────────────────

describe('CLI judge: default off (no judge flags)', () => {
  afterEach(cleanupOutput);

  it('PASS scan without judge produces no judge fields on issues', async () => {
    const { exitCode } = await scopedRun({ AGHAST_MOCK_AI: 'true' });
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 0);
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, undefined);
  });

  it('FAIL scan without judge produces no judge field on issues', async () => {
    const { exitCode } = await scopedRun({ AGHAST_MOCK_AI: failFixtureRepo });
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].judge, undefined);
    assert.equal(issues[0].flagSource, undefined);
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, undefined);
  });
});

// ─── Enabled — annotation only ───────────────────────────────────────────────

describe('CLI judge: enabled (true_positive annotation)', () => {
  afterEach(cleanupOutput);

  it('FAIL scan with judge annotates issues with true_positive verdict', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should not be dropped (TP)');
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'Issue should have judge field');
    assert.equal(judge.verdict, 'true_positive');
    assert.equal(judge.model, 'claude-opus-4-7');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, 1);
    assert.equal(summary.falsePositives, 0);
    assert.equal(summary.uncertainJudgements, 0);
  });

  it('check remains FAIL after true_positive judge verdict', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
  });

  it('banner includes judge summary line', async () => {
    const { stdout, stderr } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const combined = stdout + stderr;
    assert.ok(combined.includes('Judged:'), 'Banner should include Judged line');
    assert.ok(combined.includes('claude-opus-4-7'), 'Banner should include judge model');
  });
});

// ─── --judge-drop-false-positives ────────────────────────────────────────────

describe('CLI judge: --judge-drop-false-positives', () => {
  afterEach(cleanupOutput);

  it('drops false-positive issues from output', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-drop-false-positives',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 0, 'FP issue should be dropped');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.totalIssues, 0);
    assert.equal(summary.falsePositives, 1);
  });

  it('check that loses all issues becomes PASS after drop', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-drop-false-positives',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.failedChecks, 0);
  });

  it('keeps false-positive issue when drop flag is NOT set', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'FP issue should be retained without --judge-drop-false-positives');
  });
});

// ─── Uncertain → FLAG escalation ─────────────────────────────────────────────

describe('CLI judge: uncertain verdict → FLAG escalation', () => {
  afterEach(cleanupOutput);

  it('check whose only issues are uncertain becomes FLAG', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.flaggedChecks, 1);
    assert.equal(summary.failedChecks, 0);
  });

  it('uncertain issue has flagSource: "judge"', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].flagSource, 'judge');
    assert.equal(summary(results).uncertainJudgements, 1);
  });
});

// ─── --judge-min-confidence ──────────────────────────────────────────────────

describe('CLI judge: --judge-min-confidence', () => {
  afterEach(cleanupOutput);

  it('true_positive below threshold is demoted to uncertain (→ FLAG)', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeLowConfFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-min-confidence', '0.5',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    const j = issues[0].judge as Record<string, unknown>;
    assert.equal(j.verdict, 'uncertain', 'Low-confidence TP should be demoted to uncertain');
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG', 'Check should escalate to FLAG');
  });

  it('true_positive above threshold is kept as true_positive', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-min-confidence', '0.5',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const j = issues[0].judge as Record<string, unknown>;
    assert.equal(j.verdict, 'true_positive');
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
  });
});

// ─── Per-check judge: false opt-out ──────────────────────────────────────────

describe('CLI judge: per-check judge: false opt-out', () => {
  afterEach(cleanupOutput);

  it('issues from a check with judge:false have no judge field', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', judgeOptOutConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should still appear (not dropped)');
    assert.equal(issues[0].judge, undefined, 'No judge field for opt-out check');
    // Check stays FAIL (not escalated)
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
    const sum = results.summary as Record<string, unknown>;
    assert.equal(sum.judgedIssues, 0, 'judgedIssues should be 0 when all checks opt out');
  });
});

// ─── Static-check issues judged (decision #3) ────────────────────────────────

describe('CLI judge: static-check issues are judged', () => {
  afterEach(cleanupOutput);

  it('static check findings receive judge annotation', async () => {
    await scopedRun({
      AGHAST_MOCK_SARIF: cli3TargetsSarif,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', semgrepOnlyConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.ok(issues.length > 0, 'Static findings should be present');
    for (const issue of issues) {
      const j = issue.judge as Record<string, unknown> | undefined;
      assert.ok(j, 'Each static issue should have a judge field');
      assert.equal(j.verdict, 'true_positive');
    }
    const sum = results.summary as Record<string, unknown>;
    assert.equal(sum.judgedIssues, issues.length);
  });
});

// ─── Judge failure → uncertain ───────────────────────────────────────────────

describe('CLI judge: malformed response → uncertain', () => {
  afterEach(cleanupOutput);

  it('malformed judge response results in verdict:uncertain', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeMalformedFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should still appear');
    const j = issues[0].judge as Record<string, unknown>;
    assert.ok(j, 'Issue should have judge field even on failure');
    assert.equal(j.verdict, 'uncertain');
    assert.ok(
      (j.rationale as string).includes('judge failed:'),
      'Rationale should mention judge failed',
    );
    // Check should FLAG-escalate (decision #6)
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG');
    assert.equal(issues[0].flagSource, 'judge');
  });
});

// ─── Mixed provider mock ─────────────────────────────────────────────────────

describe('CLI judge: mixed provider mock', () => {
  afterEach(cleanupOutput);

  it('agentProvider.models includes both scan model and judge model when issues exist', async () => {
    // Use failFixtureRepo so there are issues to judge: the judge actually runs
    // and adds its model to modelsUsed. A PASS scan (no issues) skips the judge
    // stage entirely and the judge model should NOT appear in the models list.
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'claude-haiku-4-5',
      '--judge-model', 'claude-opus-4-7',
    ]);
    const results = await readResults();
    const ap = results.agentProvider as { name: string; models: string[] };
    assert.ok(ap.models.includes('claude-haiku-4-5'), 'Scan model should be listed');
    assert.ok(ap.models.includes('claude-opus-4-7'), 'Judge model should be listed');
  });

  it('agentProvider.models does not include judge model on PASS scan (no issues to judge)', async () => {
    // When the scan produces no issues, the judge stage is skipped entirely.
    // The judge model should not appear in the models list.
    await scopedRun({
      AGHAST_MOCK_AI: 'true',
      AGHAST_MOCK_JUDGE: 'true',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'claude-haiku-4-5',
      '--judge-model', 'claude-opus-4-7',
    ]);
    const results = await readResults();
    const ap = results.agentProvider as { name: string; models: string[] };
    assert.ok(ap.models.includes('claude-haiku-4-5'), 'Scan model should be listed');
    assert.ok(!ap.models.includes('claude-opus-4-7'), 'Judge model should NOT be listed when judge never ran');
  });
});

// ─── SARIF output ────────────────────────────────────────────────────────────

describe('CLI judge: SARIF output', () => {
  afterEach(cleanupOutput);

  it('SARIF results include properties.judge and kind for judged issues', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    const sarifResult = results[0];
    assert.equal(sarifResult.kind, 'open', 'true_positive should map to kind:open');
    const props = sarifResult.properties as Record<string, unknown>;
    assert.ok(props, 'SARIF result should have properties');
    assert.ok(props.judge, 'properties.judge should be present');
    const judgeProps = props.judge as Record<string, unknown>;
    assert.equal(judgeProps.verdict, 'true_positive');
  });

  it('SARIF result for false_positive has kind:pass with a suppression', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    // "false" is not a member of the SARIF 2.1.0 kind enum, so it is mapped to
    // "pass" — the same representation this formatter already uses for
    // false-positive-validation dismissals — with the reason in a suppression.
    assert.equal(results[0].kind, 'pass', 'false_positive maps to kind:pass, not the invalid kind:false');
    const suppressions = results[0].suppressions as Array<Record<string, unknown>>;
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].kind, 'external');
    assert.ok(suppressions[0].justification, 'the judge rationale should be carried as the justification');
    assert.equal(results[0].level, undefined, 'level is meaningless alongside kind:pass');
  });

  it('SARIF result for uncertain has kind:review', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    assert.equal(results[0].kind, 'review', 'uncertain should map to kind:review');
  });
});

// ─── Budget abort during judge stage ─────────────────────────────────────────

describe('CLI judge: budget abort during judge stage', () => {
  afterEach(cleanupOutput);

  it('budget abort during judge: exits non-zero, issues retain scan results without judge field', async () => {
    // Strategy: use AGHAST_MOCK_TOKENS=1000000,0 so the scan records 1M tokens for
    // the check call. Set --budget-limit-tokens=500000 so that the per-issue
    // preflightBudget() call inside the judge worker sees 1M accumulated tokens
    // (> 500000 limit) and throws BudgetExceededError before executeCheck is called.
    // With only 1 issue in the fixture, the abort fires on the first (only) issue,
    // leaving it without a `judge` field.
    //
    // Verifies:
    //   - exit code is 1 (budget abort)
    //   - E7001 appears in stderr
    //   - output file was written (scan completed; 1 issue found)
    //   - the issue has no `judge` field (judge was aborted before running)
    const result = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_TOKENS: '1000000,0',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--model', 'claude-haiku-4-5',
      '--budget-limit-tokens', '500000',
    ]);
    assert.equal(result.exitCode, 1, `expected exit 1 (budget abort), got ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /E7001/, 'stderr should include E7001 budget error code');

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'scan should have completed with 1 issue before judge abort');
    assert.equal(issues[0].judge, undefined, 'issue should have no judge field (judge was aborted before running)');
  });
});

// ─── Judge retry ─────────────────────────────────────────────────────────────

describe('CLI judge: retry covers the judge stage', () => {
  afterEach(cleanupOutput);

  it('retries a transient judge failure when retry is enabled', async () => {
    // Two transient 503s from the judge provider against a budget of three
    // attempts. Before the judge was wired into withRetry these degraded the
    // verdict to `uncertain`, which escalates the check to FLAG — turning a
    // network blip into a flagged security finding.
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_JUDGE_FAIL_TIMES: '2',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--retry-max-attempts', '3',
    ]);
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'issue should carry a judge verdict');
    assert.equal(
      judge.verdict,
      'true_positive',
      'a retried transient failure must yield the real verdict, not `uncertain`',
    );
  });

  it('does not retry the judge when retry is not enabled', async () => {
    // Same failure, no opt-in: the judge call fails and the verdict degrades.
    // Pins that judge retry follows the same opt-in switch as check analysis
    // rather than being silently always-on.
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_JUDGE_FAIL_TIMES: '2',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
    ]);
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'issue should still carry a judge field');
    assert.equal(judge.verdict, 'uncertain', 'unretried judge failure degrades to uncertain');
  });
});

// Helper to get summary as a typed Record
function summary(results: Record<string, unknown>): Record<string, unknown> {
  return results.summary as Record<string, unknown>;
}
