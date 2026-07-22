import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CsvFormatter,
  escapeCsvField,
  normalizeDescription,
} from '../src/formatters/csv-formatter.js';
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

describe('CsvFormatter', () => {
  const formatter = new CsvFormatter();

  it('id is "csv"', () => {
    assert.equal(formatter.id, 'csv');
  });

  it('fileExtension is ".csv"', () => {
    assert.equal(formatter.fileExtension, '.csv');
  });

  it('empty results emits header row only', () => {
    const out = formatter.format(makeResults());
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      'checkId,checkName,status,file,startLine,endLine,severity,confidence,description,recommendation,judgeVerdict,judgeConfidence,judgeRationale',
    );
  });

  it('all-pass scan (no issues, no errors) emits header row only', () => {
    const results = makeResults({
      checks: [
        { checkId: 'c1', checkName: 'Check 1', status: 'PASS', issuesFound: 0, executionTime: 10 },
        { checkId: 'c2', checkName: 'Check 2', status: 'PASS', issuesFound: 0, executionTime: 10 },
      ],
      summary: { totalChecks: 2, passedChecks: 2, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'only header row');
  });

  it('single issue produces a header + issue row with correct columns', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'src/app.ts', startLine: 10, endLine: 15,
        description: 'SQL injection', severity: 'high', confidence: 'medium',
        recommendation: 'Use parameterized queries',
      }],
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.equal(
      lines[1],
      // Trailing empty cells are the judge columns, which are always present so
      // the header shape does not change with runtime configuration.
      'c1,C1,FAIL,src/app.ts,10,15,high,medium,SQL injection,Use parameterized queries,,,',
    );
  });

  it('mix of pass and fail checks: only fail issues + error rows are emitted', () => {
    const results = makeResults({
      checks: [
        { checkId: 'c1', checkName: 'Pass One', status: 'PASS', issuesFound: 0, executionTime: 10 },
        { checkId: 'c2', checkName: 'Fail One', status: 'FAIL', issuesFound: 1, executionTime: 10 },
      ],
      issues: [{
        checkId: 'c2', checkName: 'Fail One',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'bad',
      }],
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith('c2,Fail One,FAIL,a.ts,'));
  });

  it('ERROR-status check produces a row even with no issues', () => {
    const results = makeResults({
      checks: [{
        checkId: 'broken', checkName: 'Broken Check', status: 'ERROR',
        issuesFound: 0, executionTime: 5, error: 'Provider failed',
      }],
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes('broken'));
    assert.ok(lines[1].includes('ERROR'));
    assert.ok(lines[1].includes('Provider failed'));
  });

  it('output ends with CRLF', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x' }],
    });
    const out = formatter.format(results);
    assert.ok(out.endsWith('\r\n'));
  });

  it('description containing comma is wrapped in quotes', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: 'Found, multiple, issues',
      }],
    });
    const out = formatter.format(results);
    assert.ok(out.includes('"Found, multiple, issues"'));
  });

  it('formula-injection: a description that starts with = is guarded in the row', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: '=HYPERLINK("http://evil","click")',
        recommendation: '@SUM(1+1)',
      }],
    });
    const out = formatter.format(results);
    const row = out.split('\r\n')[1]!;
    // description contains a comma → RFC-quoted with the leading-quote guard inside.
    assert.ok(row.includes(`"'=HYPERLINK(""http://evil"",""click"")"`), `unexpected row: ${row}`);
    // recommendation has no comma → guarded but not RFC-quoted.
    assert.ok(row.includes(`,'@SUM(1+1),`), `recommendation not guarded: ${row}`);
  });

  it('description containing double quotes has them doubled', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: 'Bad "user input"',
      }],
    });
    const out = formatter.format(results);
    assert.ok(out.includes('"Bad ""user input"""'));
  });

  it('description containing newlines is flattened to spaces', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: 'Line one\nLine two\r\nLine three',
      }],
    });
    const out = formatter.format(results);
    // Newlines in the description should be collapsed; the cell stays a single line
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2, 'header + one issue row only');
    assert.ok(lines[1].includes('Line one Line two Line three'));
  });

  it('description longer than 500 chars is truncated with an ellipsis', () => {
    const long = 'a'.repeat(2000);
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1, description: long,
      }],
    });
    const out = formatter.format(results);
    // Find the truncated form (last char should be the ellipsis)
    assert.ok(out.includes('a…'), 'truncated description should end in ellipsis');
    assert.ok(!out.includes('a'.repeat(600)), 'should not contain the full long description');
  });

  it('undefined optional fields render as empty cells', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
        // severity/confidence/recommendation absent
      }],
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines[1], 'c1,C1,FAIL,a.ts,1,1,,,x,,,,');
  });

  it('orphaned issue (no matching checks entry) gets status UNKNOWN', () => {
    // Defence-in-depth: if an issue references a checkId that isn't in the
    // checks list, the row should not be silently labelled FAIL — it should
    // surface the data inconsistency as UNKNOWN.
    const results = makeResults({
      checks: [],
      issues: [{
        checkId: 'orphan', checkName: 'Orphan',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
      }],
    });
    const out = formatter.format(results);
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith('orphan,Orphan,UNKNOWN,'));
  });

  it('checkName with comma is properly escaped', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'Tricky, Check', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'Tricky, Check',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
      }],
    });
    const out = formatter.format(results);
    assert.ok(out.includes('"Tricky, Check"'));
  });
});

describe('escapeCsvField', () => {
  it('plain string passes through', () => {
    assert.equal(escapeCsvField('hello'), 'hello');
  });
  it('number is stringified', () => {
    assert.equal(escapeCsvField(42), '42');
  });
  it('undefined → empty', () => {
    assert.equal(escapeCsvField(undefined), '');
  });
  it('comma → quoted', () => {
    assert.equal(escapeCsvField('a,b'), '"a,b"');
  });
  it('quote → quoted+doubled', () => {
    assert.equal(escapeCsvField('a"b'), '"a""b"');
  });
  it('newline → quoted', () => {
    assert.equal(escapeCsvField('a\nb'), '"a\nb"');
  });

  it('formula-injection: prefixes a quote when the field starts with =', () => {
    assert.equal(escapeCsvField('=1+1'), "'=1+1");
  });
  it('formula-injection: guards +, -, @ triggers too', () => {
    assert.equal(escapeCsvField('+1'), "'+1");
    assert.equal(escapeCsvField('-1'), "'-1");
    assert.equal(escapeCsvField('@SUM(A1)'), "'@SUM(A1)");
  });
  it('formula-injection: guard composes with RFC-4180 quoting', () => {
    // `=cmd,x` needs both the leading-quote guard and comma-quoting.
    assert.equal(escapeCsvField('=cmd,x'), `"'=cmd,x"`);
  });
  it('formula-injection: a tab-led field is guarded (tab alone needs no RFC quoting)', () => {
    assert.equal(escapeCsvField('\t=1'), "'\t=1");
  });
  it('formula-injection: a CR-led field is guarded and RFC-quoted', () => {
    assert.equal(escapeCsvField('\r=1'), `"'\r=1"`);
  });
  it('formula-injection: does not touch a value with a formula char mid-string', () => {
    assert.equal(escapeCsvField('a=b'), 'a=b');
  });

  it('formula-injection guard is skipped for numbers, so a negative line number is not corrupted', () => {
    // `-` is a formula trigger, but startLine/endLine/judge.confidence are
    // genuinely numeric columns, never attacker-controlled free text — a
    // negative value must stay a plain number, not gain a leading `'`.
    assert.equal(escapeCsvField(-5), '-5');
    assert.equal(escapeCsvField(-0.5), '-0.5');
  });
  it('a string that merely looks numeric is still guarded (the guard is type-based, not content-based)', () => {
    assert.equal(escapeCsvField('-5'), "'-5");
  });
});

describe('normalizeDescription', () => {
  it('preserves short single-line input', () => {
    assert.equal(normalizeDescription('hello world'), 'hello world');
  });
  it('collapses CRLF/LF/CR sequences to single space', () => {
    assert.equal(normalizeDescription('a\r\nb\nc\rd'), 'a b c d');
  });
  it('truncates input longer than 500 chars and appends ellipsis', () => {
    const out = normalizeDescription('x'.repeat(600));
    assert.equal(out.length, 500);
    assert.ok(out.endsWith('…'));
  });
});

describe('CsvFormatter: judge verdict columns', () => {
  const formatter = new CsvFormatter();

  it('emits verdict, confidence and rationale for a judged issue', () => {
    const out = formatter.format(makeResults({
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1,
        description: 'x',
        judge: {
          verdict: 'false_positive',
          confidence: 0.92,
          rationale: 'Input is validated upstream.',
          model: 'claude-opus-4-7',
          provider: 'claude-code',
        },
      }],
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issueCount: 1, executionTime: 1 }],
    }));
    const row = out.split('\r\n')[1]!;
    assert.ok(row.endsWith('false_positive,0.92,Input is validated upstream.'), `unexpected row: ${row}`);
  });

  it('flattens and quotes a multi-line rationale so the row stays intact', () => {
    const out = formatter.format(makeResults({
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1,
        description: 'x',
        judge: {
          verdict: 'uncertain',
          confidence: 0.4,
          rationale: 'Line one,\nline two\r\nline three',
          model: 'm', provider: 'p',
        },
      }],
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issueCount: 1, executionTime: 1 }],
    }));
    const lines = out.split('\r\n').filter((l) => l.length > 0);
    // The embedded newlines must not split the row, and the comma must be quoted.
    assert.equal(lines.length, 2, `rationale newlines leaked into new rows: ${JSON.stringify(lines)}`);
    assert.ok(lines[1]!.includes('"Line one, line two line three"'), `unexpected row: ${lines[1]}`);
  });

  it('scan-level cost is deliberately absent — summing a repeated scalar would mislead', () => {
    const out = formatter.format(makeResults({
      metadata: { cost: { totalCostUsd: 1.23, currency: 'USD' } },
      issues: [
        { checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x' },
        { checkId: 'c1', checkName: 'C1', file: 'b.ts', startLine: 2, endLine: 2, description: 'y' },
      ],
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issueCount: 2, executionTime: 1 }],
    }));
    assert.ok(!out.includes('1.23'), 'cost must not appear per-row in CSV');
    assert.ok(!out.toLowerCase().includes('cost'), 'no cost column should exist');
  });
});
