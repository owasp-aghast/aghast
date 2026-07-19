/**
 * Individual issue file writer (Spec E.3.2).
 *
 * Generates one file per `SecurityIssue` in `security_issues_<project>/<check-id>/`,
 * named `issue_<NNN>_<filename>.<ext>`. Three output formats are supported:
 * `markdown` (default), `json`, and `html`.
 *
 * HTML output escapes user-controlled fields (descriptions, code snippets,
 * file paths, recommendations, data flow steps) to prevent XSS via injected
 * markup in AI responses or source code snippets.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { ScanResults, SecurityIssue, DataFlowStep } from './types.js';
// Reuse the shared escaper from the HTML report formatter rather than keeping a
// second copy — it also handles null/undefined, which a local `string`-only
// version did not.
import { escapeHtml } from './formatters/html-formatter.js';

export type IndividualIssueFormat = 'markdown' | 'json' | 'html';

const FORMAT_EXTENSIONS: Record<IndividualIssueFormat, string> = {
  markdown: 'md',
  json: 'json',
  html: 'html',
};

/**
 * Windows reserved device names (case-insensitive, base name with or without
 * extension). Files with these names cannot be created on Windows even from
 * cross-platform code, so we prefix them with an underscore to make them safe.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Replace characters that are unsafe in filenames across Windows / macOS / Linux
 * with underscores. Strips leading dots so we never produce dotfiles by accident.
 * Also escapes Windows reserved device names (CON, PRN, NUL, etc.) by prefixing
 * with an underscore so the writer doesn't fail on Windows.
 */
function safeFilename(name: string): string {
  if (!name) return 'unknown';
  // Use only the basename — issues may carry full paths like "src/foo/bar.ts"
  const base = basename(name.replace(/[\\/]+/g, '/'));
  // Replace anything that's not alphanumeric, dash, dot, underscore.
  let cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Avoid leading dots (would create hidden files on POSIX).
  cleaned = cleaned.replace(/^\.+/, '');
  // Collapse runs of underscores for readability.
  cleaned = cleaned.replace(/_+/g, '_');
  if (cleaned.length === 0) return 'unknown';
  // Escape Windows reserved device names (CON, PRN, NUL, COM1-9, LPT1-9).
  // Match either the bare name or "name.ext" (case-insensitive).
  const stem = cleaned.split('.')[0]!.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

/**
 * Derive a project name for the output directory. Prefers the basename of
 * the repository path (when it appears to be a filesystem path), otherwise
 * falls back to the last path segment of a remote URL.
 */
function deriveProjectName(results: ScanResults): string {
  const repoPath = results.repository?.path;
  if (repoPath) {
    // Use basename — repoPath may be absolute on Windows or POSIX.
    const normalised = repoPath.replace(/[\\/]+$/, '');
    const base = basename(normalised.split(sep).join('/'));
    if (base) return safeFilename(base);
  }
  const remote = results.repository?.remoteUrl;
  if (remote) {
    const stripped = remote.replace(/\.git$/i, '').replace(/[\\/]+$/, '');
    const tail = stripped.split('/').pop();
    if (tail) return safeFilename(tail);
  }
  return 'project';
}

/** Pad an integer to 3 digits with leading zeros (e.g. 1 -> "001"). */
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function formatLineRange(issue: SecurityIssue): string {
  if (issue.startLine === issue.endLine) return String(issue.startLine);
  return `${issue.startLine}-${issue.endLine}`;
}

function renderMarkdown(issue: SecurityIssue): string {
  const lines: string[] = [];
  lines.push(`# ${issue.checkName} (${issue.checkId})`);
  lines.push('');
  lines.push(`- **File**: \`${issue.file}\``);
  lines.push(`- **Lines**: ${formatLineRange(issue)}`);
  if (issue.severity) lines.push(`- **Severity**: ${issue.severity}`);
  if (issue.confidence) lines.push(`- **Confidence**: ${issue.confidence}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(issue.description);
  if (issue.codeSnippet) {
    lines.push('');
    lines.push('## Code Snippet');
    lines.push('');
    // CommonMark allows variable-length fences: pick a length one longer than
    // the longest run of backticks in the snippet so embedded fences don't
    // break out of the code block.
    const longest = (issue.codeSnippet.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    lines.push(fence);
    lines.push(issue.codeSnippet);
    lines.push(fence);
  }
  if (issue.recommendation) {
    lines.push('');
    lines.push('## Recommendation');
    lines.push('');
    lines.push(issue.recommendation);
  }
  if (issue.dataFlow && issue.dataFlow.length > 0) {
    lines.push('');
    lines.push('## Data Flow Trace');
    lines.push('');
    issue.dataFlow.forEach((step: DataFlowStep, idx: number) => {
      lines.push(`${idx + 1}. \`${step.file}:${step.lineNumber}\` — ${step.label}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

function renderJson(issue: SecurityIssue): string {
  // Pretty-printed for human review, includes all SecurityIssue fields.
  return JSON.stringify(issue, null, 2) + '\n';
}

function renderHtml(issue: SecurityIssue): string {
  const parts: string[] = [];
  parts.push('<!doctype html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push(`<title>${escapeHtml(issue.checkName)} — ${escapeHtml(issue.file)}</title>`);
  parts.push('<style>');
  parts.push('body{font-family:sans-serif;max-width:900px;margin:2em auto;padding:0 1em;}');
  parts.push('pre{background:#f4f4f4;padding:1em;overflow:auto;}');
  parts.push('dt{font-weight:bold;}dd{margin:0 0 .5em 1em;}');
  parts.push('</style>');
  parts.push('</head>');
  parts.push('<body>');
  parts.push(`<h1>${escapeHtml(issue.checkName)} <small>(${escapeHtml(issue.checkId)})</small></h1>`);
  parts.push('<dl>');
  parts.push(`<dt>File</dt><dd><code>${escapeHtml(issue.file)}</code></dd>`);
  parts.push(`<dt>Lines</dt><dd>${escapeHtml(formatLineRange(issue))}</dd>`);
  if (issue.severity) parts.push(`<dt>Severity</dt><dd>${escapeHtml(issue.severity)}</dd>`);
  if (issue.confidence) parts.push(`<dt>Confidence</dt><dd>${escapeHtml(issue.confidence)}</dd>`);
  parts.push('</dl>');
  parts.push('<h2>Description</h2>');
  parts.push(`<p>${escapeHtml(issue.description)}</p>`);
  if (issue.codeSnippet) {
    parts.push('<h2>Code Snippet</h2>');
    parts.push(`<pre><code>${escapeHtml(issue.codeSnippet)}</code></pre>`);
  }
  if (issue.recommendation) {
    parts.push('<h2>Recommendation</h2>');
    parts.push(`<p>${escapeHtml(issue.recommendation)}</p>`);
  }
  if (issue.dataFlow && issue.dataFlow.length > 0) {
    parts.push('<h2>Data Flow Trace</h2>');
    parts.push('<ol>');
    for (const step of issue.dataFlow) {
      parts.push(
        `<li><code>${escapeHtml(step.file)}:${escapeHtml(String(step.lineNumber))}</code> — ${escapeHtml(step.label)}</li>`,
      );
    }
    parts.push('</ol>');
  }
  parts.push('</body>');
  parts.push('</html>');
  parts.push('');
  return parts.join('\n');
}

function renderIssue(issue: SecurityIssue, format: IndividualIssueFormat): string {
  switch (format) {
    case 'markdown':
      return renderMarkdown(issue);
    case 'json':
      return renderJson(issue);
    case 'html':
      return renderHtml(issue);
    default:
      // Fail fast: rather than silently writing the literal string "undefined"
      // to disk, throw if a programmatic caller passes an unknown format.
      throw new Error(`Unsupported individual issue format: ${String(format)}`);
  }
}

export interface WriteIndividualIssueFilesResult {
  /** Absolute path of the root output directory (`security_issues_<project>/`). */
  rootDir: string;
  /** Absolute paths of every issue file written. */
  files: string[];
}

/**
 * Write one file per issue in `outputDir/security_issues_<project>/<check-id>/`.
 *
 * - File names follow `issue_<NNN>_<filename>.<ext>` with NNN zero-padded to 3.
 * - Numbering is per check (each check directory restarts at 001).
 * - When two issues would produce the same filename (e.g. multiple issues in
 *   the same source file), the index disambiguates them — they remain unique
 *   on disk because NNN is different.
 *
 * @param results Scan results containing the issues to externalize.
 * @param outputDir Parent directory under which `security_issues_<project>/` is created.
 * @param format Output format (`markdown` | `json` | `html`).
 * @returns Root directory and the list of files written.
 */
export async function writeIndividualIssueFiles(
  results: ScanResults,
  outputDir: string,
  format: IndividualIssueFormat = 'markdown',
): Promise<WriteIndividualIssueFilesResult> {
  const projectName = deriveProjectName(results);
  const rootDir = resolve(outputDir, `security_issues_${projectName}`);
  await mkdir(rootDir, { recursive: true });

  // Group issues by checkId, preserving order (the order issues were collected).
  const grouped = new Map<string, SecurityIssue[]>();
  for (const issue of results.issues) {
    const list = grouped.get(issue.checkId);
    if (list) list.push(issue);
    else grouped.set(issue.checkId, [issue]);
  }

  const ext = FORMAT_EXTENSIONS[format];
  const files: string[] = [];

  for (const [checkId, issues] of grouped) {
    const checkDir = resolve(rootDir, safeFilename(checkId));
    await mkdir(checkDir, { recursive: true });
    let n = 1;
    for (const issue of issues) {
      const fileSlug = safeFilename(issue.file);
      const fileName = `issue_${pad3(n)}_${fileSlug}.${ext}`;
      const fullPath = resolve(checkDir, fileName);
      await writeFile(fullPath, renderIssue(issue, format), 'utf-8');
      files.push(fullPath);
      n++;
    }
  }

  return { rootDir, files };
}
