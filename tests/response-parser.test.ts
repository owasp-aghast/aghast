import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentResponse } from '../src/response-parser.js';

describe('parseAgentResponse', () => {
  it('parses valid PASS response (empty issues)', () => {
    const raw = JSON.stringify({ issues: [] });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.deepEqual(result.issues, []);
  });

  it('parses valid FAIL response with issues', () => {
    const raw = JSON.stringify({
      issues: [
        {
          file: 'src/api/users.ts',
          startLine: 45,
          endLine: 52,
          description: 'Missing authorization check.',
        },
        {
          file: 'src/api/orders.ts',
          startLine: 78,
          endLine: 85,
          description: 'SQL injection vulnerability.',
        },
      ],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 2);
    assert.equal(result.issues[0].file, 'src/api/users.ts');
    assert.equal(result.issues[0].startLine, 45);
    assert.equal(result.issues[0].endLine, 52);
    assert.equal(result.issues[0].description, 'Missing authorization check.');
    assert.equal(result.issues[1].file, 'src/api/orders.ts');
  });

  it('returns undefined for malformed JSON', () => {
    const result = parseAgentResponse('This is not valid JSON at all.');
    assert.equal(result, undefined);
  });

  it('returns undefined when issues field is missing', () => {
    const raw = JSON.stringify({
      findings: [{ location: 'src/api/users.ts', line: 45 }],
    });
    const result = parseAgentResponse(raw);
    assert.equal(result, undefined);
  });

  it('returns undefined when issues is not an array', () => {
    const raw = JSON.stringify({ issues: 'not an array' });
    const result = parseAgentResponse(raw);
    assert.equal(result, undefined);
  });

  it('returns undefined for non-object JSON', () => {
    const result = parseAgentResponse('"just a string"');
    assert.equal(result, undefined);
  });

  it('returns undefined for null JSON', () => {
    const result = parseAgentResponse('null');
    assert.equal(result, undefined);
  });

  it('skips issues missing required file field', () => {
    const raw = JSON.stringify({
      issues: [
        { startLine: 10, endLine: 20, description: 'no file field' },
        { file: 'src/app.ts', startLine: 1, endLine: 5, description: 'valid issue' },
      ],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].file, 'src/app.ts');
  });

  it('skips issues missing required description field', () => {
    const raw = JSON.stringify({
      issues: [
        { file: 'src/app.ts', startLine: 1, endLine: 5 },
        { file: 'src/other.ts', startLine: 10, endLine: 15, description: 'valid' },
      ],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].file, 'src/other.ts');
  });

  it('skips issues missing required line numbers', () => {
    // Line numbers are required per spec A.3 - issues without them are skipped
    const raw = JSON.stringify({
      issues: [
        { file: 'src/app.ts', description: 'issue without lines' },
        { file: 'src/other.ts', startLine: 1, endLine: 10, description: 'valid' },
      ],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].file, 'src/other.ts');
  });

  it('skips issues with non-numeric startLine/endLine', () => {
    // Line numbers must be numbers - issues with invalid types are skipped
    const raw = JSON.stringify({
      issues: [
        {
          file: 'src/app.ts',
          startLine: 'not a number',
          endLine: 'also not',
          description: 'issue',
        },
        {
          file: 'src/valid.ts',
          startLine: 1,
          endLine: 5,
          description: 'valid issue',
        },
      ],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].file, 'src/valid.ts');
  });

  it('preserves summary and analysisNotes', () => {
    const raw = JSON.stringify({
      issues: [{ file: 'a.ts', startLine: 1, endLine: 10, description: 'issue' }],
      summary: 'Found 1 issue.',
      analysisNotes: 'Focused on auth patterns.',
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.summary, 'Found 1 issue.');
    assert.equal(result.analysisNotes, 'Focused on auth patterns.');
  });

  it('ignores non-string summary and analysisNotes', () => {
    const raw = JSON.stringify({
      issues: [],
      summary: 42,
      analysisNotes: { nested: true },
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.summary, undefined);
    assert.equal(result.analysisNotes, undefined);
  });

  it('parses false-positive verdict and rationale on empty issues', () => {
    const raw = JSON.stringify({
      issues: [],
      verdict: 'false-positive',
      rationale: 'Input is validated upstream.',
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'false-positive');
    assert.equal(result.rationale, 'Input is validated upstream.');
  });

  it('parses true-positive verdict alongside issues', () => {
    const raw = JSON.stringify({
      issues: [{ file: 'a.ts', startLine: 1, endLine: 5, description: 'sqli' }],
      verdict: 'true-positive',
      rationale: 'Tainted input reaches the sink.',
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'true-positive');
    assert.equal(result.rationale, 'Tainted input reaches the sink.');
    assert.equal(result.issues.length, 1);
  });

  it('ignores an unrecognized verdict value and non-string rationale', () => {
    const raw = JSON.stringify({
      issues: [],
      verdict: 'maybe',
      rationale: { nested: true },
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, undefined);
    assert.equal(result.rationale, undefined);
  });

  it('skips non-object items in issues array', () => {
    const raw = JSON.stringify({
      issues: ['string item', null, 42, { file: 'a.ts', startLine: 1, endLine: 5, description: 'ok' }],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].file, 'a.ts');
  });

  it('parses valid dataFlow array on an issue', () => {
    const raw = JSON.stringify({
      issues: [{
        file: 'src/app.ts',
        startLine: 10,
        endLine: 20,
        description: 'SQL injection',
        dataFlow: [
          { file: 'src/handler.ts', lineNumber: 5, label: 'User input received' },
          { file: 'src/db.ts', lineNumber: 42, label: 'Passed to SQL query' },
        ],
      }],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].dataFlow);
    assert.equal(result.issues[0].dataFlow!.length, 2);
    assert.equal(result.issues[0].dataFlow![0].file, 'src/handler.ts');
    assert.equal(result.issues[0].dataFlow![0].lineNumber, 5);
    assert.equal(result.issues[0].dataFlow![0].label, 'User input received');
    assert.equal(result.issues[0].dataFlow![1].file, 'src/db.ts');
  });

  it('drops malformed dataFlow entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      issues: [{
        file: 'src/app.ts',
        startLine: 1,
        endLine: 5,
        description: 'issue',
        dataFlow: [
          { file: 'src/a.ts', lineNumber: 1, label: 'valid step' },
          { file: 'src/b.ts', lineNumber: 'not a number', label: 'bad' },
          { lineNumber: 3, label: 'missing file' },
          { file: 'src/c.ts', lineNumber: 10 },
          { file: 'src/d.ts', lineNumber: 20, label: 'also valid' },
        ],
      }],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues[0].dataFlow!.length, 2);
    assert.equal(result.issues[0].dataFlow![0].file, 'src/a.ts');
    assert.equal(result.issues[0].dataFlow![1].file, 'src/d.ts');
  });

  it('issue without dataFlow has no dataFlow field', () => {
    const raw = JSON.stringify({
      issues: [{
        file: 'src/app.ts',
        startLine: 1,
        endLine: 5,
        description: 'issue without data flow',
      }],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues[0].dataFlow, undefined);
  });

  it('empty dataFlow array results in no dataFlow field', () => {
    const raw = JSON.stringify({
      issues: [{
        file: 'src/app.ts',
        startLine: 1,
        endLine: 5,
        description: 'issue',
        dataFlow: [],
      }],
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.issues[0].dataFlow, undefined);
  });

  it('flagged:true on empty issues sets result.flagged', () => {
    const raw = JSON.stringify({ issues: [], flagged: true });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.flagged, true);
    assert.deepEqual(result.issues, []);
  });

  it('flagged:true with issues still parses both', () => {
    const raw = JSON.stringify({
      issues: [{ file: 'src/a.ts', startLine: 1, endLine: 5, description: 'issue' }],
      flagged: true,
    });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.flagged, true);
    assert.equal(result.issues.length, 1);
  });

  it('no flagged field → result.flagged is undefined', () => {
    const raw = JSON.stringify({ issues: [] });
    const result = parseAgentResponse(raw);
    assert.ok(result);
    assert.equal(result.flagged, undefined);
  });
});
