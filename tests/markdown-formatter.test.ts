import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MarkdownFormatter,
  fencedCode,
  inlineCode,
  languageForFile,
  escapeMarkdownText,
} from '../src/formatters/markdown-formatter.js';
import type { ScanResults } from '../src/types.js';

function makeResults(overrides: Partial<ScanResults> = {}): ScanResults {
  return {
    scanId: 'scan-20260101120000-abc123',
    timestamp: '2026-01-01T12:00:00.000Z',
    version: '0.1.0',
    repository: { path: '/tmp/repo', isGitRepository: true },
    issues: [],
    checks: [],
    summary: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      flaggedChecks: 0,
      errorChecks: 0,
      totalIssues: 0,
    },
    executionTime: 100,
    startTime: '2026-01-01T12:00:00.000Z',
    endTime: '2026-01-01T12:00:00.100Z',
    agentProvider: { name: 'mock', models: ['mock'] },
    ...overrides,
  };
}

describe('MarkdownFormatter — basics', () => {
  const formatter = new MarkdownFormatter();

  it('id is "markdown"', () => {
    assert.equal(formatter.id, 'markdown');
  });

  it('fileExtension is ".md"', () => {
    assert.equal(formatter.fileExtension, '.md');
  });

  it('output ends with a single trailing newline', () => {
    const output = formatter.format(makeResults());
    assert.ok(output.endsWith('\n'));
    assert.ok(!output.endsWith('\n\n'));
  });
});

describe('MarkdownFormatter — empty / no-issues scan', () => {
  const formatter = new MarkdownFormatter();

  it('contains all required sections in correct order', () => {
    const md = formatter.format(makeResults());
    const headerIdx = md.indexOf('# Security Scan Report');
    const summaryIdx = md.indexOf('## Executive Summary');
    const tableIdx = md.indexOf('## Summary Table');
    const findingsIdx = md.indexOf('## Detailed Findings');
    const statsIdx = md.indexOf('## Statistics');

    assert.ok(headerIdx >= 0, 'Header section present');
    assert.ok(summaryIdx > headerIdx, 'Executive Summary follows header');
    assert.ok(tableIdx > summaryIdx, 'Summary Table follows Executive Summary');
    assert.ok(findingsIdx > tableIdx, 'Detailed Findings follows Summary Table');
    assert.ok(statsIdx > findingsIdx, 'Statistics follows Detailed Findings');
  });

  it('omits Flagged/Errors/CI Metadata when not applicable', () => {
    const md = formatter.format(makeResults());
    assert.ok(!md.includes('## Flagged Items'));
    assert.ok(!md.includes('## Errors'));
    assert.ok(!md.includes('## CI Metadata'));
  });

  it('Executive Summary reports zero applicable checks when totalChecks=0', () => {
    const md = formatter.format(makeResults());
    assert.ok(md.includes('No checks were applicable'));
  });

  it('Summary Table indicates no checks were executed when checks empty', () => {
    const md = formatter.format(makeResults());
    assert.ok(md.includes('_No checks were executed._'));
  });

  it('Detailed Findings indicates no failing checks when none failed', () => {
    const md = formatter.format(makeResults());
    assert.ok(md.includes('_No failing checks._'));
  });
});

describe('MarkdownFormatter — all-pass scan', () => {
  const formatter = new MarkdownFormatter();

  it('produces a passing-summary line', () => {
    const md = formatter.format(makeResults({
      checks: [
        { checkId: 'c1', checkName: 'Check One', status: 'PASS', issuesFound: 0, executionTime: 10 },
        { checkId: 'c2', checkName: 'Check Two', status: 'PASS', issuesFound: 0, executionTime: 20 },
      ],
      summary: {
        totalChecks: 2, passedChecks: 2, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0,
      },
    }));
    assert.ok(md.includes('All 2 check(s) passed with no issues detected.'));
  });

  it('renders both checks in the Summary Table with PASS status', () => {
    const md = formatter.format(makeResults({
      checks: [
        { checkId: 'c1', checkName: 'Check One', status: 'PASS', issuesFound: 0, executionTime: 10 },
        { checkId: 'c2', checkName: 'Check Two', status: 'PASS', issuesFound: 0, executionTime: 20 },
      ],
      summary: {
        totalChecks: 2, passedChecks: 2, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0,
      },
    }));
    assert.ok(md.includes('| `c1` | Check One | PASS | 0 | 10 |'));
    assert.ok(md.includes('| `c2` | Check Two | PASS | 0 | 20 |'));
  });
});

describe('MarkdownFormatter — mixed scan', () => {
  const formatter = new MarkdownFormatter();
  const mixed = makeResults({
    repository: {
      path: '/tmp/repo',
      isGitRepository: true,
      remoteUrl: 'https://github.com/example/repo',
      branch: 'main',
      commit: 'abc1234',
    },
    checks: [
      { checkId: 'c-pass', checkName: 'Passing', status: 'PASS', issuesFound: 0, executionTime: 5 },
      { checkId: 'c-fail', checkName: 'SQL Injection', status: 'FAIL', issuesFound: 1, executionTime: 50 },
      { checkId: 'c-flag', checkName: 'Needs Review', status: 'FLAG', issuesFound: 0, executionTime: 30 },
      {
        checkId: 'c-err', checkName: 'Errored', status: 'ERROR',
        issuesFound: 0, executionTime: 12, error: 'Provider timed out',
      },
    ],
    issues: [
      {
        checkId: 'c-fail',
        checkName: 'SQL Injection',
        file: 'src/app.ts',
        startLine: 10,
        endLine: 15,
        description: 'User input is concatenated into a SQL query.',
        codeSnippet: 'const q = `SELECT * FROM users WHERE id = ${userId}`;',
        severity: 'high',
        confidence: 'high',
        recommendation: 'Use parameterized queries.',
        dataFlow: [
          { file: 'src/handler.ts', lineNumber: 5, label: 'User input received' },
          { file: 'src/db.ts', lineNumber: 42, label: 'Passed to SQL query' },
        ],
      },
    ],
    summary: {
      totalChecks: 4, passedChecks: 1, failedChecks: 1, flaggedChecks: 1, errorChecks: 1, totalIssues: 1,
    },
    metadata: {
      ciMetadata: {
        jobUrl: 'https://ci.example.com/jobs/123',
        pipelineSource: 'github-actions',
      },
    },
  });

  it('Header includes repository remote/branch/commit', () => {
    const md = formatter.format(mixed);
    assert.match(md, /^- \*\*Remote URL:\*\* <https:\/\/github\.com\/example\/repo>$/m);
    assert.ok(md.includes('`main`'));
    assert.ok(md.includes('`abc1234`'));
  });

  it('Executive Summary mentions failing checks and issue count', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('**1 failing**'));
    assert.ok(md.includes('**1 issue(s)**'));
  });

  it('Detailed Findings includes failing check description and snippet with language tag', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('### SQL Injection (`c-fail`)'));
    assert.ok(md.includes('User input is concatenated into a SQL query.'));
    assert.ok(md.includes('```ts\n'));
    assert.ok(md.includes('const q = `SELECT * FROM users WHERE id = ${userId}`;'));
  });

  it('renders data flow steps as a numbered list', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('1. `src/handler.ts`:5 - User input received'));
    assert.ok(md.includes('2. `src/db.ts`:42 - Passed to SQL query'));
  });

  it('renders the recommendation block', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('**Recommendation:**'));
    assert.ok(md.includes('Use parameterized queries.'));
  });

  it('Flagged Items section appears with the flagged check', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('## Flagged Items'));
    assert.ok(md.includes('| `c-flag` | Needs Review | 0 |'));
  });

  it('Errors section appears with error message', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('## Errors'));
    assert.ok(md.includes('### Errored (`c-err`)'));
    assert.ok(md.includes('Provider timed out'));
  });

  it('Statistics section reports correct totals', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('- **Total checks:** 4'));
    assert.ok(md.includes('- **Passed:** 1'));
    assert.ok(md.includes('- **Failed:** 1'));
    assert.ok(md.includes('- **Flagged:** 1'));
    assert.ok(md.includes('- **Errors:** 1'));
    assert.ok(md.includes('- **Total issues:** 1'));
  });

  it('CI Metadata section renders ciMetadata fields in display order', () => {
    const md = formatter.format(mixed);
    assert.ok(md.includes('## CI Metadata'));
    // Fixed, human-readable order (Job URL → Ref → Trigger → Started) rather
    // than alphabetical key order: `metadata` is the closed `ScanMetadata`
    // type, so the fields are known ahead of time and can be labelled.
    const jobIdx = md.indexOf('**Job URL:**');
    const triggerIdx = md.indexOf('**Trigger:**');
    assert.ok(jobIdx > 0 && triggerIdx > 0);
    assert.ok(jobIdx < triggerIdx, 'Job URL should precede Trigger');
    assert.match(md, /^- \*\*Job URL:\*\* https:\/\/ci\.example\.com\/jobs\/123$/m);
    assert.ok(md.includes('github-actions'));
  });

  it('CI Metadata section omits fields that are not set', () => {
    const md = formatter.format(mixed);
    // `mixed` sets only jobUrl and pipelineSource.
    assert.ok(!md.includes('**Ref:**'), 'unset branch should not render a row');
    assert.ok(!md.includes('**Started:**'), 'unset jobStartedAt should not render a row');
  });

  it('cost metadata does not leak into the CI Metadata section', () => {
    // `metadata` also carries `cost`, which is not CI metadata. A generic
    // key-iteration would have dumped it under this heading as a JSON blob.
    const md = formatter.format(makeResults({
      metadata: {
        ciMetadata: { jobUrl: 'https://ci.example.com/jobs/9' },
        cost: { totalCostUsd: 1.23, currency: 'USD' },
      },
    }));
    const section = md.slice(md.indexOf('## CI Metadata'));
    assert.ok(!section.includes('totalCostUsd'), 'cost must not appear under CI Metadata');
    assert.ok(!section.includes('1.23'));
  });

  it('collapses a bare CR (not just CRLF/LF) in a CI-metadata value so it cannot inject a heading', () => {
    // CI env vars are attacker-influenceable on forked-PR builds. A lone `\r`
    // is still a CommonMark line ending; escapeInlineText must collapse it to
    // a space like CRLF/LF, or the bullet splits into two lines and a leading
    // `#` on the second becomes a real heading.
    const md = formatter.format(makeResults({
      metadata: { ciMetadata: { pipelineSource: 'foo\r# Fake Heading' } },
    }));
    assert.ok(md.includes('- **Trigger:** foo # Fake Heading'), 'bare CR must collapse to a space');
    assert.ok(
      !md.split('\n').some((l) => l === '# Fake Heading'),
      'must not emit a real heading line',
    );
  });
});

describe('MarkdownFormatter — all-error scan', () => {
  const formatter = new MarkdownFormatter();

  it('renders Errors section with each errored check and no Detailed Findings entries', () => {
    const md = formatter.format(makeResults({
      checks: [
        { checkId: 'c1', checkName: 'C1', status: 'ERROR', issuesFound: 0, executionTime: 5, error: 'boom' },
        { checkId: 'c2', checkName: 'C2', status: 'ERROR', issuesFound: 0, executionTime: 5, error: 'kaboom' },
      ],
      summary: {
        totalChecks: 2, passedChecks: 0, failedChecks: 0, flaggedChecks: 0, errorChecks: 2, totalIssues: 0,
      },
    }));
    assert.ok(md.includes('## Errors'));
    assert.ok(md.includes('boom'));
    assert.ok(md.includes('kaboom'));
    assert.ok(md.includes('_No failing checks._'));
    assert.ok(md.includes('completed with **2** check(s) in an error state'));
  });

  it('renders raw agent response when present in an errored check', () => {
    const md = formatter.format(makeResults({
      checks: [{
        checkId: 'c1', checkName: 'C1', status: 'ERROR', issuesFound: 0, executionTime: 5,
        error: 'parse failed', rawAiResponse: 'Sorry, I cannot answer.',
      }],
      summary: {
        totalChecks: 1, passedChecks: 0, failedChecks: 0, flaggedChecks: 0, errorChecks: 1, totalIssues: 0,
      },
    }));
    assert.ok(md.includes('**Raw agent response:**'));
    assert.ok(md.includes('Sorry, I cannot answer.'));
  });
});

describe('MarkdownFormatter — issue without optional fields', () => {
  const formatter = new MarkdownFormatter();

  it('omits codeSnippet/recommendation/dataFlow blocks when not provided', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 5 }],
      issues: [{
        checkId: 'c1',
        checkName: 'C1',
        file: 'a.txt',
        startLine: 1,
        endLine: 1,
        description: 'thing',
      }],
      summary: {
        totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1,
      },
    }));
    assert.ok(md.includes('### C1 (`c1`)'));
    assert.ok(md.includes('thing'));
    assert.ok(!md.includes('**Code:**'));
    assert.ok(!md.includes('**Recommendation:**'));
    assert.ok(!md.includes('**Data flow:**'));
  });
});

describe('languageForFile', () => {
  it('maps known extensions correctly', () => {
    assert.equal(languageForFile('src/app.ts'), 'ts');
    assert.equal(languageForFile('a.tsx'), 'tsx');
    assert.equal(languageForFile('a.py'), 'python');
    assert.equal(languageForFile('a.rb'), 'ruby');
    assert.equal(languageForFile('a.go'), 'go');
    assert.equal(languageForFile('a.java'), 'java');
    assert.equal(languageForFile('a.cs'), 'csharp');
    assert.equal(languageForFile('a.YAML'), 'yaml');
  });

  it('returns "text" for unknown / missing extensions', () => {
    assert.equal(languageForFile('Makefile'), 'text');
    assert.equal(languageForFile('a.unknownext'), 'text');
    assert.equal(languageForFile('a.'), 'text');
  });
});

describe('fencedCode', () => {
  it('uses three backticks for plain code', () => {
    const out = fencedCode('const x = 1;', 'ts');
    assert.equal(out, '```ts\nconst x = 1;\n```');
  });

  it('escapes by extending the fence when the body contains backticks', () => {
    const out = fencedCode('here is ``` inside', 'text');
    // Body has 3 backticks, so the fence must be at least 4 backticks long.
    assert.ok(out.startsWith('````text\n'));
    assert.ok(out.endsWith('\n````'));
  });

  it('grows the fence by one beyond the longest backtick run (4 → 5)', () => {
    const out = fencedCode('here is ```` inside', 'text');
    assert.ok(out.startsWith('`````text\n'));
    assert.ok(out.endsWith('\n`````'));
  });

  it('strips a single trailing LF newline from the body', () => {
    const out = fencedCode('abc\n', 'text');
    assert.equal(out, '```text\nabc\n```');
  });

  it('strips a trailing CRLF newline so the closing fence sits cleanly', () => {
    const out = fencedCode('abc\r\n', 'text');
    // Should NOT contain a stray \r before the closing fence.
    assert.equal(out, '```text\nabc\n```');
  });
});

describe('inlineCode', () => {
  it('wraps plain text in single backticks', () => {
    assert.equal(inlineCode('hello'), '`hello`');
  });

  it('extends the fence when the value contains a backtick', () => {
    const out = inlineCode('hello `world`');
    assert.ok(out.startsWith('``'));
    assert.ok(out.endsWith('``'));
    assert.ok(out.includes('hello `world`'));
  });

  it('pads with a space when the value starts or ends with a backtick', () => {
    const out = inlineCode('`leading');
    // Body starts with a backtick — must be padded so the inline-code span
    // doesn't end immediately.
    assert.ok(/^`+ /.test(out), `expected padded leading backtick, got ${out}`);
  });

  it('flattens newlines so it is safe inside a table cell', () => {
    assert.equal(inlineCode('a\nb'), '`a b`');
  });

  it('flattens a bare CR too (CommonMark treats it as a line ending)', () => {
    // A lone `\r` (no trailing `\n`) is still a CommonMark line ending. Left
    // uncollapsed, it would split the surrounding Markdown into two physical
    // lines before the backtick span closes — `value` here is often
    // AI-response-controlled (e.g. issue.file), so this is a real injection
    // vector, not just a cosmetic gap.
    assert.equal(inlineCode('a\rb'), '`a b`');
  });
});

describe('escapeMarkdownText', () => {
  it('escapes backslash first, then inline formatting characters', () => {
    // Backslash must be doubled before other escapes are inserted, so an input
    // `a\*b` becomes `a\\\*b` (literal backslash, then escaped asterisk).
    assert.equal(escapeMarkdownText('a\\*b'), 'a\\\\\\*b');
  });

  it('neutralises inline HTML by escaping angle brackets', () => {
    // Per CommonMark/GFM, `\<` renders as a literal `<`, so the tag never
    // becomes active HTML.
    assert.equal(
      escapeMarkdownText('<script>alert(1)</script>'),
      '\\<script\\>alert(1)\\</script\\>',
    );
  });

  it('escapes each inline-formatting character', () => {
    assert.equal(escapeMarkdownText('`*_[]<>|~'), '\\`\\*\\_\\[\\]\\<\\>\\|\\~');
  });

  it('preserves newlines but escapes each line independently', () => {
    assert.equal(escapeMarkdownText('a|b\nc`d'), 'a\\|b\nc\\`d');
  });

  it('normalises CRLF to LF', () => {
    assert.equal(escapeMarkdownText('a\r\nb'), 'a\nb');
  });

  it('normalises a bare CR to LF too (CommonMark treats it as a line ending)', () => {
    // A lone `\r` (no following `\n`) is still a line ending per CommonMark/GFM.
    // If left unsplit, content after it would bypass the per-line block-marker
    // escapes below and a compliant renderer would still treat it as a new line.
    assert.equal(escapeMarkdownText('a\rb'), 'a\nb');
  });

  it('escapes a leading heading marker after a bare-CR line break', () => {
    assert.equal(
      escapeMarkdownText('Intro text\r# Fake Heading\rMore text'),
      'Intro text\n\\# Fake Heading\nMore text',
    );
  });

  it('escapes a leading heading marker so a description cannot inject a heading', () => {
    assert.equal(escapeMarkdownText('# Not a heading'), '\\# Not a heading');
    // Only the first marker needs escaping — the line no longer starts with `#`.
    assert.equal(escapeMarkdownText('### x'), '\\### x');
  });

  it('escapes leading list / thematic-break / setext markers', () => {
    assert.equal(escapeMarkdownText('- item'), '\\- item');
    assert.equal(escapeMarkdownText('+ item'), '\\+ item');
    assert.equal(escapeMarkdownText('=== underline'), '\\=== underline');
    assert.equal(escapeMarkdownText('---'), '\\---');
  });

  it('escapes a leading ordered-list marker', () => {
    assert.equal(escapeMarkdownText('1. first'), '1\\. first');
    assert.equal(escapeMarkdownText('2) second'), '2\\) second');
  });

  it('escapes block markers even after leading indentation', () => {
    assert.equal(escapeMarkdownText('   # indented'), '   \\# indented');
  });

  it('leaves ordinary prose untouched', () => {
    assert.equal(escapeMarkdownText('Use a parameterized query here.'), 'Use a parameterized query here.');
  });
});

describe('MarkdownFormatter — hostile AI-controlled description / recommendation', () => {
  const formatter = new MarkdownFormatter();

  function withIssue(description: string, recommendation?: string): ScanResults {
    return makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1,
        description, recommendation,
      }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    });
  }

  it('escapes inline HTML in the description (no active <script> tag survives)', () => {
    const md = formatter.format(withIssue('Payload: <script>alert(1)</script> end'));
    assert.ok(!md.includes('<script>'), 'raw <script> tag must not appear');
    assert.ok(md.includes('\\<script\\>'), 'angle brackets should be escaped');
  });

  it('escapes a pipe in the description so it cannot forge a table cell', () => {
    const md = formatter.format(withIssue('a | b | c'));
    assert.ok(md.includes('a \\| b \\| c'));
  });

  it('escapes a leading heading marker in the description', () => {
    const md = formatter.format(withIssue('# Injected Heading'));
    assert.ok(md.includes('\\# Injected Heading'));
    assert.ok(!md.split('\n').some((l) => l === '# Injected Heading'), 'must not emit a real heading line');
  });

  it('escapes backticks in the description so they cannot break out into code', () => {
    const md = formatter.format(withIssue('use `rm -rf` now'));
    assert.ok(md.includes('use \\`rm -rf\\` now'));
  });

  it('escapes hostile content in the recommendation field too', () => {
    const md = formatter.format(withIssue('benign', 'Fix: <img src=x onerror=alert(1)> and | pipes'));
    // The closing `>` is escaped, so the raw tag (which needs an unescaped `>`
    // to render) can't appear.
    assert.ok(!md.includes('onerror=alert(1)>'), 'raw <img ...> tag must not appear');
    assert.ok(md.includes('\\<img src=x onerror=alert(1)\\> and \\| pipes'));
  });

  it('a bare CR in issue.file cannot inject a heading via inlineCode in the Issue title', () => {
    // issue.file is parsed verbatim from the AI's JSON response and rendered
    // via inlineCode() in the "#### Issue N: `file` lines ..." heading (and
    // the Location bullet). A lone `\r` is still a CommonMark line ending; if
    // inlineCode doesn't collapse it, the backtick span never closes and a
    // leading `#` on the "next line" renders as a real heading.
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts\r# Fake Heading', startLine: 1, endLine: 2,
        description: 'd',
      }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    assert.ok(md.includes('`a.ts # Fake Heading`'), 'bare CR in file must collapse to a space inside the code span');
    assert.ok(
      !md.split('\n').some((l) => l === '# Fake Heading'),
      'must not emit a real heading line',
    );
  });
});

describe('MarkdownFormatter — escape edge cases', () => {
  const formatter = new MarkdownFormatter();

  it('checkName with a literal pipe in summary table is escaped (cell does not split)', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c-pipe', checkName: 'has | pipe', status: 'PASS', issuesFound: 0, executionTime: 1 }],
      summary: { totalChecks: 1, passedChecks: 1, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    }));
    // `\|` is the escaped form; a literal unescaped `|` would split the cell.
    assert.ok(md.includes('has \\| pipe'), 'pipe should be escaped in cell content');
  });

  it('checkName with a backslash immediately before a pipe is escaped correctly', () => {
    // Regression: input "a\|b" must not become "a\\|b" (which renders as
    // backslash + UNESCAPED pipe and splits the cell). The backslash itself
    // must be doubled before the pipe is escaped.
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c-bs', checkName: 'a\\|b', status: 'PASS', issuesFound: 0, executionTime: 1 }],
      summary: { totalChecks: 1, passedChecks: 1, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    }));
    // Expected output: backslash doubled (\\\\) then escaped pipe (\\|).
    assert.ok(md.includes('a\\\\\\|b'), `expected a\\\\\\\\\\\\| sequence, got ${md}`);
  });

  it('checkName containing a backtick does not bleed into the next cell', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c-bt', checkName: 'with `tick` in it', status: 'PASS', issuesFound: 0, executionTime: 1 }],
      summary: { totalChecks: 1, passedChecks: 1, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    }));
    // Backticks must be escaped in checkName so they don't open inline-code
    // spans inside the table cell.
    assert.ok(md.includes('with \\`tick\\` in it'));
    // The full row should still have the right number of `|` separators.
    const rowLine = md.split('\n').find((l) => l.includes('c-bt'));
    assert.ok(rowLine, 'row line for c-bt exists');
    // Count of unescaped pipes (5 separators for 5 columns + leading | makes 6).
    const pipes = (rowLine!.match(/(?<!\\)\|/g) || []).length;
    assert.equal(pipes, 6, `expected 6 unescaped pipes, got ${pipes} in row: ${rowLine}`);
  });

  it('checkName with a bare CR does not split the table row across lines', () => {
    // A lone `\r` is still a CommonMark line ending; escapeTableCell must
    // collapse it to a space like CRLF/LF, or a multi-line cell would break
    // the table's row structure.
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c-cr', checkName: 'foo\rbar', status: 'PASS', issuesFound: 0, executionTime: 1 }],
      summary: { totalChecks: 1, passedChecks: 1, failedChecks: 0, flaggedChecks: 0, errorChecks: 0, totalIssues: 0 },
    }));
    assert.ok(md.includes('foo bar'), 'bare CR must collapse to a space');
    const rowLine = md.split('\n').find((l) => l.includes('c-cr'));
    assert.ok(rowLine && rowLine.includes('foo bar'), 'row must stay on a single line');
  });

  it('issue.file containing a backtick is wrapped in a longer fence (not broken)', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'src/a`b.ts', startLine: 1, endLine: 1,
        description: 'd',
      }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    // Must NOT contain a single-backtick fence around the path (which would
    // break at the inner backtick). Should appear with a 2-backtick fence.
    assert.ok(md.includes('``src/a`b.ts``'), `expected 2-backtick fence around path, got: ${md}`);
  });

  it('renders a code snippet that itself contains triple backticks with an extended fence', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.md', startLine: 1, endLine: 1,
        description: 'd',
        codeSnippet: 'before\n```\nfoo\n```\nafter',
      }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    // Body contains a 3-backtick run, so fence must be at least 4 backticks.
    assert.ok(md.includes('````markdown\n'), `expected 4-backtick opening fence, got ${md}`);
    assert.ok(md.includes('\n````\n'), 'expected 4-backtick closing fence');
  });

  it('renders targetsAnalyzed bullet on a failing check when present', () => {
    const md = formatter.format(makeResults({
      checks: [{
        checkId: 'c1', checkName: 'C1', status: 'FAIL',
        issuesFound: 1, executionTime: 5, targetsAnalyzed: 7,
      }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'd' }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    assert.ok(md.includes('- **Targets analyzed:** 7'));
  });

  it('omits targetsAnalyzed bullet when undefined', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 5 }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'd' }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    assert.ok(!md.includes('Targets analyzed'));
  });

  it('omits Remote URL / Branch / Commit lines when those repo fields are absent', () => {
    const md = formatter.format(makeResults());
    assert.ok(!md.includes('Remote URL'));
    assert.ok(!md.includes('**Branch:**'));
    assert.ok(!md.includes('**Commit:**'));
  });

  it('uses hyphen (not en-dash) consistently in issue heading and Location bullet', () => {
    const md = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 10, endLine: 15, description: 'd' }],
      summary: { totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0, errorChecks: 0, totalIssues: 1 },
    }));
    // Heading and Location bullet both use ASCII hyphen.
    assert.ok(md.includes('lines 10-15'));
    assert.ok(md.includes(':10-15'));
    // Must NOT contain the previous en-dash glyph.
    assert.ok(!md.includes('10–15'), 'no en-dash in line range');
  });

  it('Errors section heading uses the same `### Name (id)` shape as Detailed Findings', () => {
    const md = formatter.format(makeResults({
      checks: [
        { checkId: 'e1', checkName: 'Err One', status: 'ERROR', issuesFound: 0, executionTime: 1, error: 'x' },
        { checkId: 'e2', checkName: 'Err Two', status: 'ERROR', issuesFound: 0, executionTime: 1, error: 'y' },
      ],
      summary: { totalChecks: 2, passedChecks: 0, failedChecks: 0, flaggedChecks: 0, errorChecks: 2, totalIssues: 0 },
    }));
    assert.ok(md.includes('### Err One (`e1`)'));
    assert.ok(md.includes('### Err Two (`e2`)'));
    // The previous "### 1. " ordinal style must NOT be present.
    assert.ok(!/^### \d+\.\s/m.test(md), 'no ordinal-prefixed H3 in Errors section');
  });

  // NOTE: there is deliberately no key-escaping test any more. `metadata` is now
  // the closed `ScanMetadata` type, so CI metadata labels are hardcoded in the
  // formatter rather than taken from user input — there is no attacker-controlled
  // key left to escape. Values are still user-influenced; see the test below.


  it('repository remoteUrl is rendered as a CommonMark autolink', () => {
    const md = formatter.format(makeResults({
      repository: {
        path: '/tmp/repo',
        isGitRepository: true,
        remoteUrl: 'https://github.com/example/repo_with_underscore',
      },
    }));
    // Autolink form `<url>` keeps it clickable AND prevents the underscore
    // from being interpreted as italics.
    assert.ok(
      md.includes('- **Remote URL:** <https://github.com/example/repo_with_underscore>'),
      `expected autolink, got: ${md}`,
    );
  });

  it('repository remoteUrl with angle brackets falls back to inline-code', () => {
    const md = formatter.format(makeResults({
      repository: {
        path: '/tmp/repo',
        isGitRepository: true,
        remoteUrl: 'https://example.com/<weird>',
      },
    }));
    // Must NOT emit an unbalanced `<...>` autolink. Falls back to inline-code.
    assert.ok(!md.includes('**Remote URL:** <https://example.com/<'),
      'must not emit unbalanced angle brackets');
    assert.ok(md.includes('`https://example.com/<weird>`'));
  });

  it('CI metadata string value containing markdown-special characters is escaped', () => {
    // CI metadata comes from environment variables, which are attacker-
    // influenceable on forked-PR builds — values must stay escaped.
    const md = formatter.format(makeResults({
      metadata: { ciMetadata: { jobUrl: '[ci](http://x)' } },
    }));
    // `[` must be escaped so the value does not render as a markdown link.
    assert.ok(md.includes('\\[ci\\]'));
  });

  it('CI metadata branch value with markdown-special characters is escaped', () => {
    // GitHub Actions sets GITHUB_REF_NAME from the branch name, which a
    // contributor controls on a fork.
    const md = formatter.format(makeResults({
      metadata: { ciMetadata: { branch: 'feat/*bold*_and_`code`' } },
    }));
    assert.ok(md.includes('\\*bold\\*'), 'asterisks must be escaped');
    assert.ok(md.includes('\\`code\\`'), 'backticks must be escaped');
  });
});

describe('MarkdownFormatter: cost and judge verdicts', () => {
  const formatter = new MarkdownFormatter();

  it('renders estimated cost in Statistics', () => {
    const out = formatter.format(makeResults({
      metadata: { cost: { totalCostUsd: 1.5, currency: 'USD' } },
    }));
    assert.match(out, /- \*\*Estimated cost:\*\* \$1\.50/);
  });

  it('shows sub-cent cost at four decimals rather than rounding to $0.00', () => {
    const out = formatter.format(makeResults({
      metadata: { cost: { totalCostUsd: 0.0023, currency: 'USD' } },
    }));
    assert.match(out, /\$0\.0023/, 'a tiny cost must not read as free');
    assert.ok(!out.includes('$0.00 '), 'must not round a real cost to zero');
  });

  it('omits cost entirely when no pricing was available', () => {
    const out = formatter.format(makeResults());
    assert.ok(!out.includes('Estimated cost'), 'no cost section without cost metadata');
  });

  it('renders a Judge Verdicts section only when the judge ran', () => {
    const without = formatter.format(makeResults());
    assert.ok(!without.includes('## Judge Verdicts'), 'no judge section when the stage did not run');

    const withJudge = formatter.format(makeResults({
      summary: {
        totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0,
        errorChecks: 0, totalIssues: 3,
        judgedIssues: 3, falsePositives: 1, uncertainJudgements: 1,
      },
    }));
    assert.match(withJudge, /## Judge Verdicts/);
    assert.match(withJudge, /- \*\*Issues judged:\*\* 3/);
    assert.match(withJudge, /- \*\*Judged false positive:\*\* 1/);
  });

  it('renders a per-issue verdict and escapes the model-authored rationale', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1,
        description: 'x',
        judge: {
          verdict: 'true_positive', confidence: 0.85,
          // Pipes and backticks would otherwise corrupt surrounding markdown.
          rationale: 'Sees `raw` input | unsanitised',
          model: 'claude-opus-4-7', provider: 'claude-code',
        },
      }],
    }));
    assert.match(out, /\*\*Verdict:\*\* true_positive \(85% confidence\)/);
    // Built by concatenation so the backslash-backtick pair is unambiguous in
    // source: the formatter emits \` for a backtick and \| for a pipe.
    const bs = String.fromCharCode(92); // backslash
    const tick = String.fromCharCode(96); // backtick
    assert.ok(out.includes(bs + tick + 'raw' + bs + tick), 'backticks in rationale must be escaped');
    assert.ok(out.includes(bs + '|'), 'pipes in rationale must be escaped');
  });

  it('collapses a bare CR in the judge rationale so it cannot inject a heading', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1,
        description: 'x',
        judge: {
          verdict: 'true_positive', confidence: 0.85,
          rationale: 'foo\r# Fake Heading',
          model: 'claude-opus-4-7', provider: 'claude-code',
        },
      }],
    }));
    assert.ok(out.includes('- **Rationale:** foo # Fake Heading'), 'bare CR must collapse to a space');
    assert.ok(
      !out.split('\n').some((l) => l === '# Fake Heading'),
      'must not emit a real heading line',
    );
  });
});
