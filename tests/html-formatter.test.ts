import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HtmlFormatter,
  escapeHtml,
  escapeJsonForScriptTag,
} from '../src/formatters/html-formatter.js';
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

describe('HtmlFormatter', () => {
  const formatter = new HtmlFormatter();

  it('id is "html"', () => {
    assert.equal(formatter.id, 'html');
  });

  it('fileExtension is ".html"', () => {
    assert.equal(formatter.fileExtension, '.html');
  });

  it('output starts with <!DOCTYPE html>', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.startsWith('<!DOCTYPE html>'));
  });

  it('output is self-contained (inline <style> + inline <script>)', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.includes('<style>'));
    assert.ok(out.includes('</style>'));
    assert.ok(out.includes('<script>'));
    assert.ok(out.includes('</script>'));
    // No external resources
    assert.ok(!out.includes('<link rel="stylesheet"'));
    assert.ok(!/<script[^>]*src=/.test(out));
  });

  it('includes a <meta charset="utf-8">', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.includes('<meta charset="utf-8"'));
  });

  it('includes scanId and timestamp in the header', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.includes('scan-20260101120000-abc123'));
    assert.ok(out.includes('2026-01-01T12:00:00.000Z'));
  });

  it('includes summary stats', () => {
    const out = formatter.format(makeResults({
      summary: { totalChecks: 5, passedChecks: 3, failedChecks: 1, flaggedChecks: 0, errorChecks: 1, totalIssues: 7 },
    }));
    // "Checks", "Passed", "Failed", etc. labels appear
    assert.ok(out.includes('Checks'));
    assert.ok(out.includes('Passed'));
    assert.ok(out.includes('Failed'));
    assert.ok(out.includes('Issues'));
  });

  it('empty issues set shows "No issues detected" message', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.includes('No issues detected'));
  });

  it('includes embedded JSON in <script type="application/json">', () => {
    const out = formatter.format(makeResults());
    assert.ok(out.includes('<script id="aghast-results" type="application/json">'));
  });

  it('embedded JSON parses back to the original ScanResults', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x' }],
    });
    const out = formatter.format(results);
    // Extract embedded JSON. Use matchAll + assert exactly one tag so a future
    // change that adds another application/json script doesn't silently break
    // the assumption that this regex picks the right one (F8).
    const matches = Array.from(
      out.matchAll(/<script id="aghast-results" type="application\/json">([\s\S]*?)<\/script>/g),
    );
    assert.equal(matches.length, 1, 'exactly one aghast-results script tag');
    const embedded = matches[0][1];
    // The </ → <\/ and <!-- → <!-- escapes are valid JSON: `\/` decodes
    // to `/` and `<` decodes to `<`, so JSON.parse handles them directly.
    const parsed = JSON.parse(embedded) as ScanResults;
    assert.equal(parsed.scanId, results.scanId);
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0].file, 'a.ts');
  });

  it('includes a row per issue in the issues table', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 2, executionTime: 10 }],
      issues: [
        { checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'first' },
        { checkId: 'c1', checkName: 'C1', file: 'b.ts', startLine: 2, endLine: 2, description: 'second' },
      ],
    }));
    assert.ok(out.includes('a.ts'));
    assert.ok(out.includes('b.ts'));
    assert.ok(out.includes('first'));
    assert.ok(out.includes('second'));
  });

  it('renders severity badges', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x', severity: 'high',
      }],
    }));
    assert.ok(out.includes('class="badge sev-high"'));
    assert.ok(out.includes('>high<'));
  });

  it('renders code snippets in expandable check sections', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
        codeSnippet: 'const x = 1;',
      }],
    }));
    assert.ok(out.includes('<details>'));
    assert.ok(out.includes('<pre class="snippet">const x = 1;</pre>'));
  });

  it('escapes HTML in description fields', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: '<script>alert("xss")</script>',
      }],
    }));
    // The escaped form must appear in the rendered HTML body
    assert.ok(out.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    // Strip the JSON island (which intentionally contains the raw string, but is inert
    // because of type="application/json") and ensure no executable <script>alert tag survives.
    const htmlBody = out.replace(
      /<script id="aghast-results" type="application\/json">[\s\S]*?<\/script>/,
      '',
    );
    assert.ok(!htmlBody.includes('<script>alert'), 'unescaped alert script tag must not appear in rendered body');
  });

  it('escapes HTML in file names', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: '<img src=x onerror=alert(1)>.ts', startLine: 1, endLine: 1, description: 'x',
      }],
    }));
    // Escaped form must appear in the rendered HTML body
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;.ts'));
    // Strip JSON island (raw string is inert there) and ensure no live <img ... onerror tag survives.
    const htmlBody = out.replace(
      /<script id="aghast-results" type="application\/json">[\s\S]*?<\/script>/,
      '',
    );
    assert.ok(!htmlBody.includes('<img src=x onerror=alert(1)>'));
  });

  it('escapes HTML in code snippets', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
        codeSnippet: '<script>steal()</script>',
      }],
    }));
    assert.ok(!out.includes('<pre class="snippet"><script>steal()</script>'));
    assert.ok(out.includes('&lt;script&gt;steal()&lt;/script&gt;'));
  });

  it('embedded JSON with </script> in attacker-controlled string is neutralised', () => {
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: '</script><script>alert(1)</script>',
      }],
    });
    const out = formatter.format(results);
    // Extract the JSON island; ensure it contains the escaped form, not the raw closing tag.
    const match = out.match(/<script id="aghast-results" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'should find aghast-results script tag');
    const island = match![1];
    // The raw closing-script-tag pattern must not appear inside the JSON island
    assert.ok(!island.includes('</script>'), 'raw </script> must not appear in JSON island');
    assert.ok(island.includes('<\\/script>'), 'escaped form </ → <\\/ must appear');
  });

  it('embedded JSON with <!-- + nested </script> in attacker-controlled string is neutralised', () => {
    // Without escaping <!--, HTML's script-data-escaped state would let a nested
    // <script>...</script> pair terminate the outer <script type=application/json>
    // before the closing </script> tag we control.
    const results = makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 10 }],
      issues: [{
        checkId: 'c1', checkName: 'C1',
        file: 'a.ts', startLine: 1, endLine: 1,
        description: '<!--<script>x</script>-->',
      }],
    });
    const out = formatter.format(results);
    const match = out.match(/<script id="aghast-results" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'should find aghast-results script tag');
    const island = match![1];
    assert.ok(!island.includes('<!--'), 'raw <!-- must not appear in JSON island');
    assert.ok(island.includes('\\u003c!--'), 'escaped <!-- → \\u003c!-- must appear');
  });

  it('orphaned issue (no matching checks entry) gets status UNKNOWN', () => {
    // Defence-in-depth: if an issue references a checkId that isn't in the
    // checks list, the table row should not be silently labelled FAIL — it
    // should surface the data inconsistency as UNKNOWN.
    const out = formatter.format(makeResults({
      checks: [],
      issues: [{
        checkId: 'orphan', checkName: 'Orphan',
        file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
      }],
    }));
    assert.ok(out.includes('class="badge status-unknown"'), 'should use status-unknown badge class');
    assert.ok(out.includes('>UNKNOWN<'), 'should render the UNKNOWN status text');
    assert.ok(!out.includes('class="badge status-fail">FAIL<'), 'must not silently render as FAIL');
  });

  it('multi-check report renders one <details> per check', () => {
    const out = formatter.format(makeResults({
      checks: [
        { checkId: 'c1', checkName: 'Check One', status: 'PASS', issuesFound: 0, executionTime: 10 },
        { checkId: 'c2', checkName: 'Check Two', status: 'FAIL', issuesFound: 1, executionTime: 10 },
      ],
      issues: [{ checkId: 'c2', checkName: 'Check Two', file: 'b.ts', startLine: 1, endLine: 1, description: 'x' }],
    }));
    const detailsCount = (out.match(/<details>/g) ?? []).length;
    assert.equal(detailsCount, 2);
  });

  it('ERROR check renders error message in details', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'ERROR', issuesFound: 0, executionTime: 5, error: 'boom' }],
    }));
    assert.ok(out.includes('class="badge status-error"'));
    assert.ok(out.includes('boom'));
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, ", \'', () => {
    assert.equal(escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
  it('undefined → empty string', () => {
    assert.equal(escapeHtml(undefined), '');
  });
  it('null → empty string', () => {
    assert.equal(escapeHtml(null), '');
  });
  it('numbers stringify', () => {
    assert.equal(escapeHtml(42), '42');
  });
});

describe('escapeJsonForScriptTag', () => {
  it('replaces </ with <\\/', () => {
    assert.equal(escapeJsonForScriptTag('a</script>b'), 'a<\\/script>b');
  });
  it('plain JSON passes through', () => {
    assert.equal(escapeJsonForScriptTag('{"a":1}'), '{"a":1}');
  });
  it('replaces <!-- with \\u003c!-- so HTML script-data-escaped state cannot trigger', () => {
    // <!-- + a nested </script> pair can otherwise close the outer <script> early
    // in HTML's script-data tokenizer. Replacing < with its JSON unicode
    // escape < keeps JSON.parse round-trip-safe.
    assert.equal(
      escapeJsonForScriptTag('foo <!-- <script>x</script>--> bar'),
      'foo \\u003c!-- <script>x<\\/script>--> bar',
    );
  });
  it('output round-trips through JSON.parse', () => {
    const original = 'a</b><!--c-->d';
    const json = JSON.stringify({ x: original });
    const escaped = escapeJsonForScriptTag(json);
    const parsed = JSON.parse(escaped) as { x: string };
    assert.equal(parsed.x, original);
  });
});

describe('HtmlFormatter: cost and judge verdicts', () => {
  const formatter = new HtmlFormatter();

  it('renders an estimated-cost stat tile when cost metadata exists', () => {
    const out = formatter.format(makeResults({
      metadata: { cost: { totalCostUsd: 2.5, currency: 'USD' } },
    }));
    assert.ok(out.includes('Est. cost'), 'cost tile should be present');
    assert.ok(out.includes('$2.50'), 'cost value should be rendered');
  });

  it('omits the cost tile when there is no cost metadata', () => {
    const out = formatter.format(makeResults());
    assert.ok(!out.includes('Est. cost'), 'no cost tile without cost metadata');
  });

  it('renders judge tiles only when the judge stage ran', () => {
    const without = formatter.format(makeResults());
    assert.ok(!without.includes('>Judged<'), 'no judge tile when the stage did not run');

    const withJudge = formatter.format(makeResults({
      summary: {
        totalChecks: 1, passedChecks: 0, failedChecks: 1, flaggedChecks: 0,
        errorChecks: 0, totalIssues: 2,
        judgedIssues: 2, falsePositives: 1, uncertainJudgements: 0,
      },
    }));
    assert.ok(withJudge.includes('>Judged<'), 'judge tile should appear');
    assert.ok(withJudge.includes('False positives'), 'false-positive tile should appear');
  });

  it('adds a Verdict column only when at least one issue was judged', () => {
    const unjudged = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{ checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x' }],
    }));
    assert.ok(!unjudged.includes('<th>Verdict</th>'), 'no empty Verdict column on an unjudged scan');

    const judged = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
        judge: {
          verdict: 'false_positive', confidence: 0.9,
          rationale: 'Validated upstream', model: 'm', provider: 'p',
        },
      }],
    }));
    assert.ok(judged.includes('<th>Verdict</th>'), 'Verdict column should appear');
    assert.ok(judged.includes('false_positive'), 'verdict value should render');
    assert.ok(judged.includes('90%'), 'confidence should render as a percentage');
  });

  it('escapes a malicious rationale in the verdict tooltip (XSS safety)', () => {
    const out = formatter.format(makeResults({
      checks: [{ checkId: 'c1', checkName: 'C1', status: 'FAIL', issuesFound: 1, executionTime: 1 }],
      issues: [{
        checkId: 'c1', checkName: 'C1', file: 'a.ts', startLine: 1, endLine: 1, description: 'x',
        judge: {
          verdict: 'uncertain', confidence: 0.5,
          rationale: '"><script>alert(1)</script>',
          model: 'm', provider: 'p',
        },
      }],
    }));
    assert.ok(!out.includes('<script>alert(1)</script>'), 'rationale must not inject raw script markup');
    assert.ok(out.includes('&lt;script&gt;'), 'rationale should be HTML-escaped');
  });
});
