/**
 * Unit tests for individual issue file writer (Spec E.3.2).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { writeIndividualIssueFiles } from '../src/issue-file-writer.js';
import type { ScanResults, SecurityIssue } from '../src/types.js';

function makeIssue(overrides: Partial<SecurityIssue> = {}): SecurityIssue {
  return {
    checkId: 'aghast-sqli',
    checkName: 'SQL Injection',
    file: 'src/example.ts',
    startLine: 10,
    endLine: 12,
    description: 'User input concatenated into SQL query.',
    severity: 'critical',
    confidence: 'high',
    codeSnippet: "db.query(`SELECT * FROM u WHERE id=${id}`);",
    recommendation: 'Use parameterised queries.',
    ...overrides,
  };
}

function makeResults(issues: SecurityIssue[], repoPath = '/repos/my-app'): ScanResults {
  return {
    scanId: 'scan-test',
    timestamp: new Date().toISOString(),
    version: '0.0.0-test',
    repository: { path: repoPath, isGitRepository: false },
    issues,
    checks: [],
    summary: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      flaggedChecks: 0,
      errorChecks: 0,
      totalIssues: issues.length,
    },
    executionTime: 0,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    agentProvider: { name: 'mock', models: ['mock'] },
  };
}

describe('writeIndividualIssueFiles', () => {
  let tmp: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aghast-issue-files-'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates security_issues_<project>/<check-id>/ structure with markdown by default', async () => {
    const out = resolve(tmp, 'case1');
    const results = makeResults([makeIssue()]);
    const { rootDir, files } = await writeIndividualIssueFiles(results, out, 'markdown');

    assert.ok(rootDir.endsWith('security_issues_my-app'), `unexpected rootDir: ${rootDir}`);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /aghast-sqli[\\/]issue_001_example\.ts\.md$/);
    const body = await readFile(files[0]!, 'utf-8');
    assert.ok(body.includes('# SQL Injection (aghast-sqli)'));
    assert.ok(body.includes('**Lines**: 10-12'));
    assert.ok(body.includes('**Severity**: critical'));
    assert.ok(body.includes('## Description'));
    assert.ok(body.includes('User input concatenated'));
    assert.ok(body.includes('## Code Snippet'));
    assert.ok(body.includes('## Recommendation'));
  });

  it('numbers issues in same check from 001 and zero-pads to 3 digits', async () => {
    const out = resolve(tmp, 'case2');
    const issues: SecurityIssue[] = [];
    for (let i = 0; i < 12; i++) {
      issues.push(makeIssue({ file: `src/file${i}.ts` }));
    }
    const { files } = await writeIndividualIssueFiles(makeResults(issues), out, 'markdown');
    assert.equal(files.length, 12);
    assert.match(files[0]!, /issue_001_file0\.ts\.md$/);
    assert.match(files[9]!, /issue_010_file9\.ts\.md$/);
    assert.match(files[11]!, /issue_012_file11\.ts\.md$/);
  });

  it('handles filename collisions (same source file, multiple issues)', async () => {
    const out = resolve(tmp, 'case3');
    const issues = [
      makeIssue({ file: 'src/foo.ts', startLine: 1, endLine: 1, description: 'first' }),
      makeIssue({ file: 'src/foo.ts', startLine: 5, endLine: 5, description: 'second' }),
      makeIssue({ file: 'src/foo.ts', startLine: 9, endLine: 9, description: 'third' }),
    ];
    const { files } = await writeIndividualIssueFiles(makeResults(issues), out, 'markdown');
    assert.equal(files.length, 3);
    // All filenames must be distinct due to NNN prefix.
    const set = new Set(files);
    assert.equal(set.size, 3);
    assert.match(files[0]!, /issue_001_foo\.ts\.md$/);
    assert.match(files[1]!, /issue_002_foo\.ts\.md$/);
    assert.match(files[2]!, /issue_003_foo\.ts\.md$/);
  });

  it('groups issues by checkId into separate subdirectories', async () => {
    const out = resolve(tmp, 'case4');
    const issues = [
      makeIssue({ checkId: 'aghast-sqli', checkName: 'SQLi', file: 'a.ts' }),
      makeIssue({ checkId: 'aghast-xss', checkName: 'XSS', file: 'b.ts' }),
      makeIssue({ checkId: 'aghast-sqli', checkName: 'SQLi', file: 'c.ts' }),
    ];
    const { rootDir, files } = await writeIndividualIssueFiles(makeResults(issues), out, 'markdown');
    assert.equal(files.length, 3);
    const sqliDir = resolve(rootDir, 'aghast-sqli');
    const xssDir = resolve(rootDir, 'aghast-xss');
    const sqliFiles = await readdir(sqliDir);
    const xssFiles = await readdir(xssDir);
    assert.equal(sqliFiles.length, 2);
    assert.equal(xssFiles.length, 1);
    // Per-check numbering restarts at 001.
    assert.ok(sqliFiles.some(f => f.startsWith('issue_001_')));
    assert.ok(sqliFiles.some(f => f.startsWith('issue_002_')));
    assert.ok(xssFiles.some(f => f.startsWith('issue_001_')));
  });

  it('writes JSON format', async () => {
    const out = resolve(tmp, 'case5');
    const issue = makeIssue();
    const { files } = await writeIndividualIssueFiles(makeResults([issue]), out, 'json');
    assert.match(files[0]!, /\.json$/);
    const body = await readFile(files[0]!, 'utf-8');
    const parsed = JSON.parse(body);
    assert.equal(parsed.checkId, 'aghast-sqli');
    assert.equal(parsed.startLine, 10);
    assert.equal(parsed.codeSnippet, issue.codeSnippet);
  });

  it('writes HTML format and escapes user-controlled content (XSS safety)', async () => {
    const out = resolve(tmp, 'case6');
    const malicious = makeIssue({
      checkName: '<script>alert(1)</script>',
      description: 'Naughty: <img src=x onerror=alert(2)>',
      codeSnippet: '</code></pre><script>steal()</script>',
      recommendation: '"><svg/onload=alert(3)>',
      file: 'src/<weird>file"name.ts',
    });
    const { files } = await writeIndividualIssueFiles(makeResults([malicious]), out, 'html');
    assert.match(files[0]!, /\.html$/);
    const body = await readFile(files[0]!, 'utf-8');

    // Must NOT contain unescaped script/event-handler markup that came from user input.
    assert.ok(!body.includes('<script>alert(1)</script>'), 'checkName script tag must be escaped');
    assert.ok(!body.includes('<img src=x'), 'description img tag must be escaped');
    assert.ok(!body.includes('<script>steal()'), 'codeSnippet script tag must be escaped');
    assert.ok(!body.includes('<svg/onload'), 'recommendation svg/onload must be escaped');

    // Must contain the escaped equivalents.
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(body.includes('&lt;img src=x onerror=alert(2)&gt;'));
    assert.ok(body.includes('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;steal()&lt;/script&gt;'));
    assert.ok(body.includes('&quot;&gt;&lt;svg/onload=alert(3)&gt;'));

    // Doc must still be a valid (well-formed) HTML5 document.
    assert.ok(body.startsWith('<!doctype html>'));
    assert.ok(body.includes('<html'));
    assert.ok(body.includes('</html>'));
  });

  it('sanitises filename: strips path separators and unsafe characters', async () => {
    const out = resolve(tmp, 'case7');
    const issue = makeIssue({ file: 'src/sub/dir/weird name?.ts' });
    const { files } = await writeIndividualIssueFiles(makeResults([issue]), out, 'markdown');
    // basename only (no path separators), no spaces or '?', preserving dot.
    assert.match(files[0]!, /issue_001_weird_name_\.ts\.md$/);
    assert.ok(!files[0]!.includes('?'));
    assert.ok(!files[0]!.includes(' '));
  });

  it('falls back gracefully when issue has empty file path', async () => {
    const out = resolve(tmp, 'case8');
    const issue = makeIssue({ file: '' });
    const { files } = await writeIndividualIssueFiles(makeResults([issue]), out, 'markdown');
    assert.match(files[0]!, /issue_001_unknown\.md$/);
  });

  it('renders dataFlow steps (markdown and html)', async () => {
    const out = resolve(tmp, 'case9');
    const issue = makeIssue({
      dataFlow: [
        { file: 'src/in.ts', lineNumber: 4, label: 'tainted source' },
        { file: 'src/sink.ts', lineNumber: 22, label: 'reaches dangerous <sink>' },
      ],
    });
    const md = await writeIndividualIssueFiles(makeResults([issue]), out, 'markdown');
    const mdBody = await readFile(md.files[0]!, 'utf-8');
    assert.ok(mdBody.includes('## Data Flow Trace'));
    assert.ok(mdBody.includes('1. `src/in.ts:4` — tainted source'));
    assert.ok(mdBody.includes('2. `src/sink.ts:22` — reaches dangerous <sink>'));

    const out2 = resolve(tmp, 'case9b');
    const html = await writeIndividualIssueFiles(makeResults([issue]), out2, 'html');
    const htmlBody = await readFile(html.files[0]!, 'utf-8');
    assert.ok(htmlBody.includes('<h2>Data Flow Trace</h2>'));
    // Step label angle brackets must be escaped.
    assert.ok(htmlBody.includes('reaches dangerous &lt;sink&gt;'));
  });

  it('omits optional sections when fields absent (markdown)', async () => {
    const out = resolve(tmp, 'case10');
    const minimal: SecurityIssue = {
      checkId: 'c',
      checkName: 'C',
      file: 'a.ts',
      startLine: 1,
      endLine: 1,
      description: 'd',
    };
    const { files } = await writeIndividualIssueFiles(makeResults([minimal]), out, 'markdown');
    const body = await readFile(files[0]!, 'utf-8');
    assert.ok(!body.includes('## Code Snippet'));
    assert.ok(!body.includes('## Recommendation'));
    assert.ok(!body.includes('## Data Flow Trace'));
    assert.ok(!body.includes('**Severity**'));
    assert.ok(!body.includes('**Confidence**'));
    // Single-line range collapses to just the number.
    assert.ok(body.includes('**Lines**: 1\n'));
  });

  it('escapes Windows reserved device names in filenames', async () => {
    const out = resolve(tmp, 'case-windows-reserved');
    const issues = [
      makeIssue({ file: 'src/CON.ts' }),
      makeIssue({ file: 'src/nul' }),
      makeIssue({ file: 'src/com1.log' }),
    ];
    const { files } = await writeIndividualIssueFiles(makeResults(issues), out, 'markdown');
    // Each filename's source-name component should be prefixed with `_` so
    // Windows can write it (CON, NUL, COM1 are reserved device names).
    assert.match(files[0]!, /issue_001__CON\.ts\.md$/);
    assert.match(files[1]!, /issue_002__nul\.md$/);
    assert.match(files[2]!, /issue_003__com1\.log\.md$/);
  });

  it('uses dynamic-length code fence so embedded triple backticks do not break out', async () => {
    const out = resolve(tmp, 'case-fence');
    const issue = makeIssue({
      codeSnippet: 'before\n```\nstill in code\n```\nafter',
    });
    const { files } = await writeIndividualIssueFiles(makeResults([issue]), out, 'markdown');
    const body = await readFile(files[0]!, 'utf-8');
    // Snippet contains a 3-backtick run, so the wrapper fence must be >= 4 backticks.
    assert.ok(body.includes('````\nbefore'), 'wrapper fence should be at least 4 backticks');
    assert.ok(body.includes('after\n````'), 'closing fence should match wrapper length');
    // Inner triple backticks remain literal — they no longer terminate the block.
    assert.ok(body.includes('```\nstill in code\n```'));
  });

  it('throws on unsupported individual issue format', async () => {
    const out = resolve(tmp, 'case-unsupported');
    await assert.rejects(
      // @ts-expect-error testing runtime guard against bad programmatic input
      () => writeIndividualIssueFiles(makeResults([makeIssue()]), out, 'pdf'),
      /Unsupported individual issue format: pdf/,
    );
  });

  it('derives project name from remoteUrl when path is missing', async () => {
    const out = resolve(tmp, 'case11');
    const results: ScanResults = makeResults([makeIssue()]);
    results.repository = { path: '', remoteUrl: 'git@github.com:org/cool-project.git', isGitRepository: true };
    const { rootDir } = await writeIndividualIssueFiles(results, out, 'markdown');
    assert.ok(rootDir.endsWith('security_issues_cool-project'), `unexpected rootDir: ${rootDir}`);
  });
});

