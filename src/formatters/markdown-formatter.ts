/**
 * Markdown output formatter — produces a human-readable security report.
 * See SPECIFICATION.md Appendix E.3.1.
 *
 * Sections (in order):
 *   1. Header                — Title, date, AI provider/model, repository info
 *   2. Executive Summary     — One-paragraph overview of the scan outcome
 *   3. Summary Table         — All checks with PASS/FAIL/FLAG/ERROR status
 *   4. Detailed Findings     — Failed checks with descriptions, snippets, recs
 *   5. Flagged Items         — Checks needing human review (only when present)
 *   6. Errors                — Checks with ERROR status (only when present)
 *   7. Statistics            — Totals for the scan
 *   8. CI Metadata           — Job URL / branch / pipeline info (only when set)
 */

import type {
  ScanResults,
  CIMetadata,
  SecurityIssue,
  CheckExecutionSummary,
  RepositoryInfo,
} from '../types.js';
import type { OutputFormatter } from './types.js';

/** File-extension to fenced-code-block language tag. Default is `text`. */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  scala: 'scala',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  md: 'markdown',
};

/** Resolves the fenced-code-block language tag from a file path. */
export function languageForFile(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0 || lastDot === filePath.length - 1) return 'text';
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'text';
}

/** Returns the longest backtick run in `code` so we can pick a longer fence. */
function chooseFence(code: string): string {
  // Fast path: no backticks in body → standard 3-backtick fence.
  if (code.indexOf('`') === -1) return '```';
  let longest = 0;
  const re = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Wraps code in a fenced block with a language tag, escaping nested fences safely. */
export function fencedCode(code: string, language: string): string {
  const fence = chooseFence(code);
  // Strip a single trailing newline (LF or CRLF) so we control spacing inside
  // the block. Without CRLF handling, Windows-line-ending snippets would leave
  // a stray \r before the closing fence.
  const body = code.replace(/\r?\n$/, '');
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * Wraps `value` in a backtick fence long enough to survive any backticks
 * already inside `value`. Per CommonMark, an inline-code span uses a backtick
 * run of length N around a body that contains no run of length N — minimum
 * length 1 (unlike fenced code blocks, which require minimum 3). Pad with a
 * leading/trailing space if the body itself starts or ends with a backtick.
 * Newlines are collapsed to spaces because inline-code spans must be
 * single-line (and table cells must not contain raw newlines).
 */
export function inlineCode(value: string): string {
  const flat = value.replace(/\r?\n/g, ' ');
  // Compute longest backtick run inline (don't reuse chooseFence — its
  // minimum is 3 for block fences, but inline-code minimum is 1).
  let longest = 0;
  const re = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(flat)) !== null) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = '`'.repeat(longest + 1);
  const padStart = flat.startsWith('`') ? ' ' : '';
  const padEnd = flat.endsWith('`') ? ' ' : '';
  return `${fence}${padStart}${flat}${padEnd}${fence}`;
}

/**
 * Escapes characters so a string is safe inside a Markdown table cell.
 *
 * Order matters:
 *   1. Backslashes first, so subsequent `\|` insertions aren't mis-parsed
 *      (input `a\|b` would otherwise become `a\\|b`, which renders as a
 *      literal `\` followed by an UNESCAPED `|` — splitting the cell).
 *   2. Pipes next.
 *   3. Backticks (escape so they don't open inline-code spans inside the
 *      cell — a single backtick in a `checkName` would otherwise bleed
 *      across columns).
 *   4. Collapse newlines to spaces — table cells must be single-line.
 */
function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ');
}

/** Sentence-case label for a status (e.g. `PASS` → `Passed`). */
function statusLabel(status: CheckExecutionSummary['status']): string {
  switch (status) {
    case 'PASS': return 'Passed';
    case 'FAIL': return 'Failed';
    case 'FLAG': return 'Flagged';
    case 'ERROR': return 'Error';
  }
}

function renderHeader(results: ScanResults): string {
  const lines: string[] = [];
  lines.push('# Security Scan Report');
  lines.push('');
  lines.push(`- **Scan ID:** ${inlineCode(results.scanId)}`);
  lines.push(`- **Date:** ${results.timestamp}`);
  lines.push(`- **aghast version:** ${results.version}`);
  const models = results.agentProvider.models.length > 0
    ? results.agentProvider.models.join(', ')
    : '(none)';
  lines.push(`- **Agent provider:** ${results.agentProvider.name} (model: ${models})`);
  lines.push('');
  lines.push(...renderRepository(results.repository));
  return lines.join('\n');
}

function renderRepository(repo: RepositoryInfo): string[] {
  const lines: string[] = [];
  lines.push('## Repository');
  lines.push('');
  lines.push(`- **Path:** ${inlineCode(repo.path)}`);
  // Wrap the remote URL in `<...>` (CommonMark autolink syntax) so it
  // remains clickable while the angle-bracket form prevents underscores or
  // other markdown-special characters in the URL from being interpreted as
  // formatting. If the URL itself contains `<` or `>` (illegal per RFC 3986
  // but possible in pathological inputs) we fall back to inline-code so the
  // angle-bracket pair stays balanced.
  if (repo.remoteUrl) {
    const url = repo.remoteUrl;
    const safeAutoLink = !url.includes('<') && !url.includes('>') && !/\s/.test(url);
    lines.push(`- **Remote URL:** ${safeAutoLink ? `<${url}>` : inlineCode(url)}`);
  }
  if (repo.branch) lines.push(`- **Branch:** ${inlineCode(repo.branch)}`);
  if (repo.commit) lines.push(`- **Commit:** ${inlineCode(repo.commit)}`);
  lines.push(`- **Git repository:** ${repo.isGitRepository ? 'yes' : 'no'}`);
  return lines;
}

function renderExecutiveSummary(results: ScanResults): string {
  const { summary } = results;
  let outcome: string;
  if (summary.totalChecks === 0) {
    outcome = 'No checks were applicable to this repository.';
  } else if (summary.failedChecks > 0 && summary.errorChecks > 0) {
    outcome = `The scan found **${summary.failedChecks} failing** check(s) with a total of **${summary.totalIssues} issue(s)**, and **${summary.errorChecks}** check(s) errored before completing.`;
  } else if (summary.failedChecks > 0) {
    outcome = `The scan found **${summary.failedChecks} failing** check(s) with a total of **${summary.totalIssues} issue(s)** that require attention.`;
  } else if (summary.errorChecks > 0) {
    outcome = `The scan completed with **${summary.errorChecks}** check(s) in an error state and no failing checks.`;
  } else if (summary.flaggedChecks > 0) {
    outcome = `The scan completed with **${summary.flaggedChecks}** check(s) flagged for human review and no failing checks.`;
  } else {
    outcome = `All ${summary.totalChecks} check(s) passed with no issues detected.`;
  }
  return `## Executive Summary\n\n${outcome}`;
}

function renderSummaryTable(results: ScanResults): string {
  const lines: string[] = [];
  lines.push('## Summary Table');
  lines.push('');
  if (results.checks.length === 0) {
    lines.push('_No checks were executed._');
    return lines.join('\n');
  }
  lines.push('| Check ID | Name | Status | Issues | Time (ms) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const check of results.checks) {
    lines.push(
      `| ${inlineCode(check.checkId)} `
      + `| ${escapeTableCell(check.checkName)} `
      + `| ${check.status} `
      + `| ${check.issuesFound} `
      + `| ${check.executionTime} |`,
    );
  }
  return lines.join('\n');
}

function renderDetailedFindings(results: ScanResults): string {
  const failingChecks = results.checks.filter((c) => c.status === 'FAIL');
  const lines: string[] = [];
  lines.push('## Detailed Findings');
  lines.push('');
  if (failingChecks.length === 0) {
    lines.push('_No failing checks._');
    return lines.join('\n');
  }
  for (const check of failingChecks) {
    lines.push(`### ${check.checkName} (${inlineCode(check.checkId)})`);
    lines.push('');
    lines.push(`- **Status:** ${statusLabel(check.status)}`);
    lines.push(`- **Issues found:** ${check.issuesFound}`);
    if (typeof check.targetsAnalyzed === 'number') {
      lines.push(`- **Targets analyzed:** ${check.targetsAnalyzed}`);
    }
    lines.push('');
    const issues = results.issues.filter((i) => i.checkId === check.checkId);
    if (issues.length === 0) {
      lines.push('_No issue details were attached to this check._');
      lines.push('');
      continue;
    }
    issues.forEach((issue, idx) => {
      lines.push(...renderIssue(issue, idx + 1));
      lines.push('');
    });
  }
  // Trim trailing blank line so section terminates cleanly.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function renderIssue(issue: SecurityIssue, ordinal: number): string[] {
  const lines: string[] = [];
  // Note: issue ordinal restarts at 1 inside each failing check. The H4
  // headings are scoped under their check's H3 parent so the structure is
  // clear when reading top-to-bottom; consumers that flatten H4s (e.g. TOC
  // generators) will see duplicate "Issue 1" anchors and should disambiguate
  // by including the parent H3 in the anchor.
  lines.push(`#### Issue ${ordinal}: ${inlineCode(issue.file)} lines ${issue.startLine}-${issue.endLine}`);
  lines.push('');
  if (issue.severity) lines.push(`- **Severity:** ${issue.severity}`);
  if (issue.confidence) lines.push(`- **Confidence:** ${issue.confidence}`);
  lines.push(`- **Location:** ${inlineCode(issue.file)}:${issue.startLine}-${issue.endLine}`);
  lines.push('');
  lines.push('**Description:**');
  lines.push('');
  lines.push(issue.description);
  if (issue.codeSnippet) {
    lines.push('');
    lines.push('**Code:**');
    lines.push('');
    lines.push(fencedCode(issue.codeSnippet, languageForFile(issue.file)));
  }
  if (issue.dataFlow && issue.dataFlow.length > 0) {
    lines.push('');
    lines.push('**Data flow:**');
    lines.push('');
    issue.dataFlow.forEach((step, i) => {
      lines.push(`${i + 1}. ${inlineCode(step.file)}:${step.lineNumber} - ${step.label}`);
    });
  }
  if (issue.recommendation) {
    lines.push('');
    lines.push('**Recommendation:**');
    lines.push('');
    lines.push(issue.recommendation);
  }
  return lines;
}

function renderFlaggedItems(results: ScanResults): string | null {
  const flagged = results.checks.filter((c) => c.status === 'FLAG');
  if (flagged.length === 0) return null;
  const lines: string[] = [];
  lines.push('## Flagged Items');
  lines.push('');
  lines.push('The following checks completed but have been flagged for human review.');
  lines.push('');
  lines.push('| Check ID | Name | Issues |');
  lines.push('| --- | --- | --- |');
  for (const check of flagged) {
    lines.push(
      `| ${inlineCode(check.checkId)} `
      + `| ${escapeTableCell(check.checkName)} `
      + `| ${check.issuesFound} |`,
    );
  }
  return lines.join('\n');
}

function renderErrors(results: ScanResults): string | null {
  const errored = results.checks.filter((c) => c.status === 'ERROR');
  if (errored.length === 0) return null;
  const lines: string[] = [];
  lines.push('## Errors');
  lines.push('');
  lines.push('The following checks failed to execute and produced no findings.');
  lines.push('');
  // Use the same H3 shape as Detailed Findings (`### Name (id)`) — no leading
  // ordinal — so the report's heading style is consistent across sections.
  errored.forEach((check) => {
    lines.push(`### ${check.checkName} (${inlineCode(check.checkId)})`);
    lines.push('');
    if (check.error) {
      lines.push('**Error message:**');
      lines.push('');
      lines.push(fencedCode(check.error, 'text'));
    } else {
      lines.push('_No error message was captured._');
    }
    if (check.rawAiResponse) {
      lines.push('');
      lines.push('**Raw agent response:**');
      lines.push('');
      lines.push(fencedCode(check.rawAiResponse, 'text'));
    }
    lines.push('');
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function renderStatistics(results: ScanResults): string {
  const { summary } = results;
  const lines: string[] = [];
  lines.push('## Statistics');
  lines.push('');
  lines.push(`- **Total checks:** ${summary.totalChecks}`);
  lines.push(`- **Passed:** ${summary.passedChecks}`);
  lines.push(`- **Failed:** ${summary.failedChecks}`);
  lines.push(`- **Flagged:** ${summary.flaggedChecks}`);
  lines.push(`- **Errors:** ${summary.errorChecks}`);
  lines.push(`- **Total issues:** ${summary.totalIssues}`);
  lines.push(`- **Execution time (ms):** ${results.executionTime}`);
  lines.push(`- **Start:** ${results.startTime}`);
  lines.push(`- **End:** ${results.endTime}`);
  if (results.tokenUsage) {
    lines.push(
      `- **Tokens:** total ${results.tokenUsage.totalTokens.toLocaleString('en-US')} `
      + `(input ${results.tokenUsage.inputTokens.toLocaleString('en-US')}, `
      + `output ${results.tokenUsage.outputTokens.toLocaleString('en-US')})`,
    );
  }
  return lines.join('\n');
}

/**
 * Escape characters that would otherwise be interpreted as Markdown formatting
 * when interpolating arbitrary user/CI strings into bullet content. Conservative
 * — only escapes the syntactic characters that change rendering: `\`, `*`, `_`,
 * `` ` ``, `<`, `[`, `]`, `|`. Newlines collapsed to spaces (bullets are
 * single-line). Keep this scoped to the CI-metadata path where keys/values come
 * from arbitrary `Record<string, unknown>` input.
 */
function escapeInlineText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[*_`<[\]|]/g, (m) => `\\${m}`)
    .replace(/\r?\n/g, ' ');
}

/** Human-readable labels for CIMetadata fields, in display order. */
const CI_METADATA_LABELS: ReadonlyArray<readonly [keyof CIMetadata, string]> = [
  ['jobUrl', 'Job URL'],
  ['branch', 'Ref'],
  ['pipelineSource', 'Trigger'],
  ['jobStartedAt', 'Started'],
];

/**
 * Renders `metadata.ciMetadata` as a labelled bullet list.
 *
 * This was originally written when `ScanResults.metadata` was an untyped
 * `Record<string, unknown>` and iterated its top-level keys. #260 replaced that
 * with the closed `ScanMetadata` type, whose members (`ciMetadata`, `cost`) are
 * nested objects — so the generic iteration would have emitted a JSON blob per
 * key, and would also have folded `cost` under a heading titled "CI Metadata".
 *
 * Values are still escaped: they originate from CI environment variables, which
 * are attacker-influenceable on forked-PR builds.
 */
function renderCIMetadata(results: ScanResults): string | null {
  const ci = results.metadata?.ciMetadata;
  if (!ci) return null;

  const lines: string[] = [];
  for (const [key, label] of CI_METADATA_LABELS) {
    const value = ci[key];
    if (value == null || value === '') continue;
    lines.push(`- **${label}:** ${escapeInlineText(value)}`);
  }
  // Every field is optional, so a present-but-empty object yields no rows —
  // emit nothing rather than a bare heading.
  if (lines.length === 0) return null;

  return ['## CI Metadata', '', ...lines].join('\n');
}

export class MarkdownFormatter implements OutputFormatter {
  readonly id = 'markdown';
  readonly fileExtension = '.md';

  format(results: ScanResults): string {
    const sections: string[] = [
      renderHeader(results),
      renderExecutiveSummary(results),
      renderSummaryTable(results),
      renderDetailedFindings(results),
    ];
    const flagged = renderFlaggedItems(results);
    if (flagged) sections.push(flagged);
    const errors = renderErrors(results);
    if (errors) sections.push(errors);
    sections.push(renderStatistics(results));
    const ci = renderCIMetadata(results);
    if (ci) sections.push(ci);
    return sections.join('\n\n') + '\n';
  }
}
