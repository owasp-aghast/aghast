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
      'checkId,checkName,status,file,startLine,endLine,severity,confidence,description,recommendation',
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
      'c1,C1,FAIL,src/app.ts,10,15,high,medium,SQL injection,Use parameterized queries',
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
    assert.equal(lines[1], 'c1,C1,FAIL,a.ts,1,1,,,x,');
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
