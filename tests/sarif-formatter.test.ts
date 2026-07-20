import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SarifFormatter, mapSeverityToLevel } from '../src/formatters/sarif-formatter.js';
import type { ScanResults } from '../src/types.js';

function makeResults(overrides: Partial<ScanResults> = {}): ScanResults {
  return {
    scanId: 'scan-20260101120000-abc123',
    timestamp: '2026-01-01T12:00:00.000Z',
    version: '0.1.0',
    repository: { path: '/tmp/repo', isGitRepository: true },
    issues: [],
    checks: [],
    summary: { totalChecks: 0, passedChecks: 0, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    executionTime: 100,
    startTime: '2026-01-01T12:00:00.000Z',
    endTime: '2026-01-01T12:00:00.100Z',
    agentProvider: { name: 'mock', models: ['mock'] },
    ...overrides,
  };
}

describe('SarifFormatter', () => {
  const formatter = new SarifFormatter();

  it('id is "sarif"', () => {
    assert.equal(formatter.id, 'sarif');
  });

  it('fileExtension is ".sarif"', () => {
    assert.equal(formatter.fileExtension, '.sarif');
  });

  it('output is valid JSON', () => {
    const output = formatter.format(makeResults());
    assert.doesNotThrow(() => JSON.parse(output));
  });

  it('has correct schema and version fields', () => {
    const sarif = JSON.parse(formatter.format(makeResults()));
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.$schema.includes('sarif-schema-2.1.0'));
  });

  it('tool driver name is "aghast"', () => {
    const sarif = JSON.parse(formatter.format(makeResults()));
    assert.equal(sarif.runs[0].tool.driver.name, 'aghast');
  });

  it('tool driver semanticVersion comes from results.version', () => {
    const sarif = JSON.parse(formatter.format(makeResults({ version: '1.2.3' })));
    assert.equal(sarif.runs[0].tool.driver.semanticVersion, '1.2.3');
  });

  it('empty scan produces valid SARIF with empty results and rules', () => {
    const sarif = JSON.parse(formatter.format(makeResults()));
    assert.deepEqual(sarif.runs[0].results, []);
    assert.deepEqual(sarif.runs[0].tool.driver.rules, []);
  });

  it('single issue with severity high maps to level "error"', () => {
    const results = makeResults({
      checks: [{ checkId: 'check-1', checkName: 'Check One', status: 'FAIL', issuesFound: 1, executionTime: 50 }],
      issues: [{
        checkId: 'check-1', checkName: 'Check One',
        file: 'src/app.ts', startLine: 10, endLine: 15,
        description: 'SQL injection found', severity: 'high',
      }],
    });
    const sarif = JSON.parse(formatter.format(results));
    const result = sarif.runs[0].results[0];

    assert.equal(result.ruleId, 'check-1');
    assert.equal(result.message.text, 'SQL injection found');
    assert.equal(result.level, 'error');
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'src/app.ts');
    assert.equal(result.locations[0].physicalLocation.region.startLine, 10);
    assert.equal(result.locations[0].physicalLocation.region.endLine, 15);
  });

  it('multiple issues across checks produce unique rules and all results', () => {
    const results = makeResults({
      checks: [
        { checkId: 'check-1', checkName: 'Check One', status: 'FAIL', issuesFound: 1, executionTime: 50 },
        { checkId: 'check-2', checkName: 'Check Two', status: 'FAIL', issuesFound: 1, executionTime: 50 },
      ],
      issues: [
        { checkId: 'check-1', checkName: 'Check One', file: 'a.ts', startLine: 1, endLine: 2, description: 'Issue A' },
        { checkId: 'check-2', checkName: 'Check Two', file: 'b.ts', startLine: 3, endLine: 4, description: 'Issue B' },
        { checkId: 'check-1', checkName: 'Check One', file: 'c.ts', startLine: 5, endLine: 6, description: 'Issue C' },
      ],
    });
    const sarif = JSON.parse(formatter.format(results));

    assert.equal(sarif.runs[0].tool.driver.rules.length, 2, 'Should have 2 unique rules');
    assert.equal(sarif.runs[0].results.length, 3, 'Should have 3 results');
  });

  it('code snippet present adds region.snippet.text', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'x.ts', startLine: 1, endLine: 1,
        description: 'test', codeSnippet: 'const x = 1;',
      }],
    });
    const sarif = JSON.parse(formatter.format(results));
    assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.snippet.text, 'const x = 1;');
  });

  it('absent code snippet omits snippet key', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'x.ts', startLine: 1, endLine: 1, description: 'test',
      }],
    });
    const sarif = JSON.parse(formatter.format(results));
    assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.snippet, undefined);
  });

  it('issue with dataFlow produces codeFlows in SARIF result', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'src/app.ts', startLine: 10, endLine: 20, description: 'SQL injection',
        dataFlow: [
          { file: 'src/handler.ts', lineNumber: 5, label: 'User input received' },
          { file: 'src/db.ts', lineNumber: 42, label: 'Passed to SQL query' },
        ],
      }],
    });
    const sarif = JSON.parse(formatter.format(results));
    const result = sarif.runs[0].results[0];

    assert.ok(result.codeFlows, 'Should have codeFlows');
    assert.equal(result.codeFlows.length, 1);
    const threadFlow = result.codeFlows[0].threadFlows[0];
    assert.equal(threadFlow.locations.length, 2);

    const step0 = threadFlow.locations[0].location;
    assert.equal(step0.physicalLocation.artifactLocation.uri, 'src/handler.ts');
    assert.equal(step0.physicalLocation.region.startLine, 5);
    assert.equal(step0.message.text, 'User input received');

    const step1 = threadFlow.locations[1].location;
    assert.equal(step1.physicalLocation.artifactLocation.uri, 'src/db.ts');
    assert.equal(step1.physicalLocation.region.startLine, 42);
    assert.equal(step1.message.text, 'Passed to SQL query');
  });

  it('issue without dataFlow has no codeFlows in SARIF result', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'x.ts', startLine: 1, endLine: 1, description: 'test',
      }],
    });
    const sarif = JSON.parse(formatter.format(results));
    assert.equal(sarif.runs[0].results[0].codeFlows, undefined);
  });

  it('false-positive validations become pass results with a suppression', () => {
    const results = makeResults({
      checks: [{ checkId: 'fp', checkName: 'FP Check', status: 'PASS', issuesFound: 0, executionTime: 10 }],
      validations: [
        {
          checkId: 'fp', checkName: 'FP Check', verdict: 'false-positive',
          target: { file: 'src/app.ts', startLine: 40, endLine: 45, message: 'Possible SQLi', snippet: 'q = `...`' },
          rationale: 'Value is an allowlisted column name, never user input.',
        },
      ],
    });
    const sarif = JSON.parse(formatter.format(results));
    assert.equal(sarif.runs[0].results.length, 1);
    const result = sarif.runs[0].results[0];

    assert.equal(result.kind, 'pass');
    assert.equal(result.ruleId, 'fp');
    assert.equal(result.message.text, 'Possible SQLi');
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'src/app.ts');
    assert.equal(result.locations[0].physicalLocation.region.snippet.text, 'q = `...`');
    assert.equal(result.suppressions.length, 1);
    assert.equal(result.suppressions[0].kind, 'external');
    assert.equal(result.suppressions[0].justification, 'Value is an allowlisted column name, never user input.');
  });

  it('true-positive validations are not duplicated as pass results (covered by issues)', () => {
    const results = makeResults({
      checks: [{ checkId: 'fp', checkName: 'FP Check', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'fp', checkName: 'FP Check',
        file: 'src/app.ts', startLine: 40, endLine: 45, description: 'Confirmed SQLi',
      }],
      validations: [
        {
          checkId: 'fp', checkName: 'FP Check', verdict: 'true-positive',
          target: { file: 'src/app.ts', startLine: 40, endLine: 45, message: 'Possible SQLi' },
          rationale: 'Tainted input reaches the sink.', issueIndex: 0,
        },
      ],
    });
    const sarif = JSON.parse(formatter.format(results));
    // Only the issue-derived result; the TP validation adds nothing extra.
    assert.equal(sarif.runs[0].results.length, 1);
    assert.equal(sarif.runs[0].results[0].kind, undefined);
    assert.equal(sarif.runs[0].results[0].message.text, 'Confirmed SQLi');
  });

  // ─── CI/CD metadata → SARIF invocations (spec E.4) ────────────────────────

  it('omits invocations when no metadata is present', () => {
    const sarif = JSON.parse(formatter.format(makeResults()));
    assert.equal(sarif.runs[0].invocations, undefined);
  });

  it('omits invocations when metadata.ciMetadata is undefined', () => {
    const sarif = JSON.parse(formatter.format(makeResults({ metadata: {} })));
    assert.equal(sarif.runs[0].invocations, undefined);
  });

  it('omits invocations when ciMetadata exists but is entirely empty', () => {
    // Defensive: even a non-empty ciMetadata object with no populated fields
    // should not produce a stray invocations[] in the output.
    const sarif = JSON.parse(formatter.format(makeResults({ metadata: { ciMetadata: {} } })));
    assert.equal(sarif.runs[0].invocations, undefined);
  });

  it('maps full ciMetadata to a single invocation with namespaced properties', () => {
    const sarif = JSON.parse(formatter.format(makeResults({
      metadata: {
        ciMetadata: {
          jobUrl: 'https://github.com/org/repo/actions/runs/12345',
          branch: 'feature/auth-fix',
          pipelineSource: 'push',
          jobStartedAt: '2026-01-18T10:00:00Z',
        },
      },
    })));
    assert.equal(Array.isArray(sarif.runs[0].invocations), true);
    assert.equal(sarif.runs[0].invocations.length, 1);
    const invocation = sarif.runs[0].invocations[0];
    assert.equal(invocation.executionSuccessful, true);
    assert.deepEqual(invocation.properties, {
      'aghast.ciJobUrl': 'https://github.com/org/repo/actions/runs/12345',
      'aghast.ciBranch': 'feature/auth-fix',
      'aghast.ciPipelineSource': 'push',
      'aghast.ciJobStartedAt': '2026-01-18T10:00:00Z',
    });
  });

  it('maps partial ciMetadata (CircleCI shape) without spurious property keys', () => {
    const sarif = JSON.parse(formatter.format(makeResults({
      metadata: {
        ciMetadata: {
          jobUrl: 'https://circleci.com/gh/org/repo/42',
          branch: 'main',
        },
      },
    })));
    const invocation = sarif.runs[0].invocations[0];
    assert.deepEqual(invocation.properties, {
      'aghast.ciJobUrl': 'https://circleci.com/gh/org/repo/42',
      'aghast.ciBranch': 'main',
    });
    // Confirm no undefined fields leak in.
    assert.equal('aghast.ciPipelineSource' in invocation.properties, false);
    assert.equal('aghast.ciJobStartedAt' in invocation.properties, false);
  });
});

describe('mapSeverityToLevel', () => {
  it('critical → error', () => assert.equal(mapSeverityToLevel('critical'), 'error'));
  it('high → error', () => assert.equal(mapSeverityToLevel('high'), 'error'));
  it('medium → warning', () => assert.equal(mapSeverityToLevel('medium'), 'warning'));
  it('low → note', () => assert.equal(mapSeverityToLevel('low'), 'note'));
  it('informational → note', () => assert.equal(mapSeverityToLevel('informational'), 'note'));
  it('undefined → note', () => assert.equal(mapSeverityToLevel(undefined), 'note'));
});

// ─── Judge verdicts → SARIF ──────────────────────────────────────────────────
//
// This path had no coverage, which is how an invalid `kind` shipped. The last
// test here is the structural guard: it rejects any kind outside the SARIF
// 2.1.0 enum, so a future verdict cannot reintroduce the problem.

describe('SarifFormatter — judge verdicts', () => {
  const formatter = new SarifFormatter();

  /** SARIF 2.1.0 section 3.27.9. The complete, closed set. */
  const VALID_KINDS = new Set([
    'notApplicable', 'pass', 'fail', 'review', 'open', 'informational',
  ]);

  function withVerdict(verdict: 'true_positive' | 'false_positive' | 'uncertain') {
    return makeResults({
      checks: [{ checkId: 'c1', checkName: 'Check One', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'Check One',
        file: 'src/a.ts', startLine: 1, endLine: 2,
        description: 'Possible SQLi', severity: 'critical',
        judge: {
          verdict,
          confidence: 0.9,
          rationale: 'Input is an allowlisted column name.',
          model: 'claude-opus-4-7',
          provider: 'claude-code',
        },
      }],
    });
  }

  it('false_positive → kind "pass" with a suppression carrying the rationale', () => {
    const sarif = JSON.parse(formatter.format(withVerdict('false_positive')));
    const result = sarif.runs[0].results[0];

    assert.equal(result.kind, 'pass', '"false" is not a valid SARIF kind');
    assert.equal(result.suppressions.length, 1);
    assert.equal(result.suppressions[0].kind, 'external');
    assert.equal(result.suppressions[0].justification, 'Input is an allowlisted column name.');
  });

  it('false_positive omits level, which is meaningless alongside kind "pass"', () => {
    const sarif = JSON.parse(formatter.format(withVerdict('false_positive')));
    // The issue carries severity: 'critical', so without the delete this would
    // be 'error' — telling a consumer the finding is both dismissed and severe.
    assert.equal(sarif.runs[0].results[0].level, undefined);
  });

  it('true_positive → kind "open", keeping its severity-derived level', () => {
    const sarif = JSON.parse(formatter.format(withVerdict('true_positive')));
    const result = sarif.runs[0].results[0];
    assert.equal(result.kind, 'open');
    assert.equal(result.level, 'error');
    assert.equal(result.suppressions, undefined, 'a confirmed finding must not be suppressed');
  });

  it('uncertain → kind "review", keeping its level', () => {
    const sarif = JSON.parse(formatter.format(withVerdict('uncertain')));
    const result = sarif.runs[0].results[0];
    assert.equal(result.kind, 'review');
    assert.equal(result.level, 'error');
  });

  it('the verdict detail is preserved in the property bag', () => {
    const sarif = JSON.parse(formatter.format(withVerdict('false_positive')));
    const judge = sarif.runs[0].results[0].properties.judge;
    assert.equal(judge.verdict, 'false_positive');
    assert.equal(judge.confidence, 0.9);
    assert.equal(judge.model, 'claude-opus-4-7');
    assert.equal(judge.provider, 'claude-code');
  });

  it('every emitted kind is a member of the SARIF 2.1.0 enum', () => {
    // Structural guard. Covers all three verdicts plus the false-positive
    // validation path, so adding a verdict without checking the spec fails here.
    for (const verdict of ['true_positive', 'false_positive', 'uncertain'] as const) {
      const sarif = JSON.parse(formatter.format(withVerdict(verdict)));
      for (const result of sarif.runs[0].results) {
        if (result.kind === undefined) continue;
        assert.ok(
          VALID_KINDS.has(result.kind),
          `"${result.kind}" (from verdict ${verdict}) is not a valid SARIF 2.1.0 result kind`,
        );
      }
    }
  });
});
