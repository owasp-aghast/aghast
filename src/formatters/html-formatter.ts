/**
 * HTML output formatter — self-contained interactive report.
 *
 * Emits a single .html file with inline CSS + JS. Includes:
 *   - Header with title, scan timestamp, repository info
 *   - Summary statistics (totals + per-status counters)
 *   - Filterable, severity-badged issues table
 *   - Expandable per-check sections with optional code snippets
 *   - The full `ScanResults` embedded as a JSON island for client-side filtering
 *
 * All user-controlled strings are HTML-escaped via `escapeHtml`. The embedded
 * JSON has `</` sequences neutralised so an attacker-controlled string cannot
 * break out of the `<script type="application/json">` tag.
 */

import type {
  ScanResults,
  SecurityIssue,
  CheckExecutionSummary,
  RepositoryInfo,
} from '../types.js';
import type { OutputFormatter } from './types.js';

/** Escapes the five HTML special characters. */
export function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Embeds JSON inside a `<script type="application/json">` block safely.
 *
 * Two patterns matter for HTML's script-data tokenizer:
 *   1. `</` — replaced with `<\/` so a stray `</script>` cannot terminate the
 *      script element early. `\/` is valid JSON for `/`, so JSON.parse
 *      round-trips faithfully.
 *   2. `<!--` — the script-data tokenizer enters a "script data escaped"
 *      state on `<!--`, in which a nested `<script>...</script>` pair can
 *      terminate the outer element ahead of the literal closing tag we control.
 *      Encoding `<` as the Unicode escape `<` is unambiguous JSON
 *      (parses back to `<`) and prevents the tokenizer from ever entering the
 *      escaped state.
 */
export function escapeJsonForScriptTag(json: string): string {
  return json
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '\\u003c!--');
}

function severityClass(severity: string | undefined): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'sev-high';
    case 'medium':
      return 'sev-medium';
    case 'low':
    case 'informational':
      return 'sev-low';
    default:
      return 'sev-unknown';
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'PASS':
      return 'status-pass';
    case 'FAIL':
      return 'status-fail';
    case 'FLAG':
      return 'status-flag';
    case 'ERROR':
      return 'status-error';
    default:
      return 'status-unknown';
  }
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --fg: #1f2329;
  --muted: #6a7280;
  --card: #ffffff;
  --border: #e2e5ea;
  --pass: #15803d;
  --fail: #b91c1c;
  --flag: #b45309;
  --error: #6b21a8;
  --sev-high: #b91c1c;
  --sev-medium: #b45309;
  --sev-low: #2563eb;
  --sev-unknown: #6a7280;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c;
    --fg: #e6e8eb;
    --muted: #9ba1aa;
    --card: #1c2026;
    --border: #2a2f37;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.5;
}
.container { max-width: 1200px; margin: 0 auto; padding: 24px; }
header { margin-bottom: 24px; }
header h1 { margin: 0 0 4px; font-size: 1.6rem; }
header .meta { color: var(--muted); font-size: 0.9rem; }
.muted { color: var(--muted); }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.stat .num { font-size: 1.6rem; font-weight: 600; }
.stat .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #fff;
}
.badge.sev-high { background: var(--sev-high); }
.badge.sev-medium { background: var(--sev-medium); }
.badge.sev-low { background: var(--sev-low); }
.badge.sev-unknown { background: var(--sev-unknown); }
.badge.status-pass { background: var(--pass); }
.badge.status-fail { background: var(--fail); }
.badge.status-flag { background: var(--flag); }
.badge.status-error { background: var(--error); }
.badge.status-unknown { background: var(--sev-unknown); }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.controls input, .controls select {
  background: var(--card);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
}
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th { background: var(--card); font-weight: 600; }
tr.hidden { display: none; }
details { margin-top: 8px; }
details summary { cursor: pointer; font-weight: 600; }
pre.snippet {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  overflow-x: auto;
  font-size: 0.8rem;
  margin: 8px 0 0;
}
.empty { color: var(--muted); font-style: italic; }
footer { color: var(--muted); font-size: 0.8rem; text-align: center; margin: 32px 0 16px; }
`;

const CLIENT_JS = `
(function () {
  var data;
  try {
    data = JSON.parse(document.getElementById('aghast-results').textContent);
  } catch (e) {
    return;
  }
  var search = document.getElementById('filter-search');
  var severity = document.getElementById('filter-severity');
  var status = document.getElementById('filter-status');
  var rows = Array.prototype.slice.call(document.querySelectorAll('#issues-table tbody tr'));

  function applyFilters() {
    var q = (search.value || '').toLowerCase();
    var sev = severity.value;
    var st = status.value;
    rows.forEach(function (row) {
      var text = row.getAttribute('data-search') || '';
      var rowSev = row.getAttribute('data-severity') || '';
      var rowStatus = row.getAttribute('data-status') || '';
      var matches = (!q || text.indexOf(q) !== -1)
        && (!sev || rowSev === sev)
        && (!st || rowStatus === st);
      row.classList.toggle('hidden', !matches);
    });
  }

  if (search) search.addEventListener('input', applyFilters);
  if (severity) severity.addEventListener('change', applyFilters);
  if (status) status.addEventListener('change', applyFilters);

  // Expose data for debugging / extensibility.
  window.aghastResults = data;
})();
`;

function renderHeader(results: ScanResults): string {
  const repo = results.repository;
  const repoLabel = repo.remoteUrl
    ? `${escapeHtml(repo.remoteUrl)}`
    : escapeHtml(repo.path);
  const branch = repo.branch ? ` <span class="muted">on ${escapeHtml(repo.branch)}</span>` : '';
  const commit = repo.commit ? ` <span class="muted">@ ${escapeHtml(repo.commit.slice(0, 12))}</span>` : '';
  return `
    <header>
      <h1>aghast Security Scan Report</h1>
      <div class="meta">
        Scan ID: <code>${escapeHtml(results.scanId)}</code> &middot;
        Generated: ${escapeHtml(results.timestamp)} &middot;
        Provider: ${escapeHtml(results.agentProvider.name)}
      </div>
      <div class="meta">
        Repository: ${repoLabel}${branch}${commit}
      </div>
    </header>
  `;
}

/**
 * Format a cost for display. Sub-cent runs are common with cheap models, and
 * rounding them to "$0.00" reads as "free" rather than "very small".
 */
function formatCost(amount: number, currency: string): string {
  const decimals = amount > 0 && amount < 0.01 ? 4 : 2;
  const value = amount.toFixed(decimals);
  return currency === 'USD' ? `$${value}` : `${value} ${escapeHtml(currency)}`;
}

function renderSummary(results: ScanResults, _repo: RepositoryInfo): string {
  const { summary } = results;
  const extra: string[] = [];

  // Judge tiles appear only when the stage ran. `judgedIssues` is the marker:
  // every other counter is legitimately zero on a clean scan and cannot
  // distinguish "judge ran and found nothing" from "judge never ran".
  if (summary.judgedIssues !== undefined) {
    extra.push(
      `<div class="stat"><div class="num">${summary.judgedIssues}</div><div class="label">Judged</div></div>`,
    );
    if (summary.falsePositives !== undefined) {
      extra.push(
        `<div class="stat"><div class="num">${summary.falsePositives}</div><div class="label">False positives</div></div>`,
      );
    }
    if (summary.uncertainJudgements !== undefined) {
      extra.push(
        `<div class="stat"><div class="num">${summary.uncertainJudgements}</div><div class="label">Uncertain</div></div>`,
      );
    }
  }

  const cost = results.metadata?.cost;
  if (cost) {
    extra.push(
      `<div class="stat"><div class="num">${escapeHtml(formatCost(cost.totalCostUsd, cost.currency))}</div>`
      + `<div class="label">Est. cost</div></div>`,
    );
  }

  return `
    <section class="summary-grid">
      <div class="stat"><div class="num">${summary.totalChecks}</div><div class="label">Checks</div></div>
      <div class="stat"><div class="num">${summary.passedChecks}</div><div class="label">Passed</div></div>
      <div class="stat"><div class="num">${summary.failedChecks}</div><div class="label">Failed</div></div>
      <div class="stat"><div class="num">${summary.flaggedChecks}</div><div class="label">Flagged</div></div>
      <div class="stat"><div class="num">${summary.errorChecks}</div><div class="label">Errors</div></div>
      <div class="stat"><div class="num">${summary.totalIssues}</div><div class="label">Issues</div></div>
      ${extra.join('\n      ')}
    </section>
  `;
}

function renderIssuesTable(issues: SecurityIssue[], statusByCheck: Map<string, string>): string {
  if (issues.length === 0) {
    return `<section class="card"><h2>Issues</h2><p class="empty">No issues detected.</p></section>`;
  }
  // Only carry a Verdict column when the judge actually annotated something.
  // A permanently empty column on every non-judged scan is worse than none.
  const hasVerdicts = issues.some((i) => i.judge);
  const rows = issues.map((issue) => {
    const sev = issue.severity ?? '';
    const sevCls = severityClass(issue.severity);
    const sevBadge = `<span class="badge ${sevCls}">${escapeHtml(sev || 'unknown')}</span>`;
    const verdictCell = hasVerdicts
      ? `<td>${issue.judge
          ? `<span class="badge">${escapeHtml(issue.judge.verdict)}</span> `
            + `<span title="${escapeHtml(issue.judge.rationale ?? '')}">`
            + `${Math.round(issue.judge.confidence * 100)}%</span>`
          : ''}</td>`
      : '';
    // Fall back to 'UNKNOWN' (not 'FAIL') for orphaned issues so the row's
    // status badge and the data-status filter don't lie when an issue
    // references a checkId that isn't in the checks list.
    const status = statusByCheck.get(issue.checkId) ?? 'UNKNOWN';
    const statusCls = statusClass(status);
    const statusBadge = `<span class="badge ${statusCls}">${escapeHtml(status)}</span>`;
    const searchBlob = `${issue.checkId} ${issue.checkName} ${issue.file} ${issue.description}`.toLowerCase();
    return `
      <tr data-severity="${escapeHtml(sev)}" data-status="${escapeHtml(status)}" data-search="${escapeHtml(searchBlob)}">
        <td>${escapeHtml(issue.checkId)}</td>
        <td>${escapeHtml(issue.checkName)}</td>
        <td>${statusBadge}</td>
        <td>${sevBadge}</td>
        <td><code>${escapeHtml(issue.file)}</code>:${escapeHtml(issue.startLine)}-${escapeHtml(issue.endLine)}</td>
        <td>${escapeHtml(issue.description)}</td>
        ${verdictCell}
      </tr>
    `;
  }).join('');
  return `
    <section class="card">
      <h2>Issues</h2>
      <div class="controls">
        <input id="filter-search" type="search" placeholder="Filter by text..." />
        <select id="filter-severity">
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="informational">Informational</option>
        </select>
        <select id="filter-status">
          <option value="">All statuses</option>
          <option value="PASS">Pass</option>
          <option value="FAIL">Fail</option>
          <option value="FLAG">Flag</option>
          <option value="ERROR">Error</option>
        </select>
      </div>
      <table id="issues-table" aria-label="Security issues">
        <thead>
          <tr><th>Check ID</th><th>Check</th><th>Status</th><th>Severity</th><th>Location</th><th>Description</th>${hasVerdicts ? '<th>Verdict</th>' : ''}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderCheckDetails(checks: CheckExecutionSummary[], issuesByCheck: Map<string, SecurityIssue[]>): string {
  if (checks.length === 0) {
    return '';
  }
  const sections = checks.map((check) => {
    const checkIssues = issuesByCheck.get(check.checkId) ?? [];
    const statusBadge = `<span class="badge ${statusClass(check.status)}">${escapeHtml(check.status)}</span>`;
    const errorBlock = check.error
      ? `<p><strong>Error:</strong> ${escapeHtml(check.error)}</p>`
      : '';
    const issuesBlock = checkIssues.length === 0
      ? '<p class="empty">No issues for this check.</p>'
      : checkIssues.map((issue) => {
        const snippet = issue.codeSnippet
          ? `<pre class="snippet">${escapeHtml(issue.codeSnippet)}</pre>`
          : '';
        const recommendation = issue.recommendation
          ? `<p><strong>Recommendation:</strong> ${escapeHtml(issue.recommendation)}</p>`
          : '';
        return `
          <div class="card">
            <div><strong><code>${escapeHtml(issue.file)}</code>:${escapeHtml(issue.startLine)}-${escapeHtml(issue.endLine)}</strong>
              ${issue.severity ? `<span class="badge ${severityClass(issue.severity)}">${escapeHtml(issue.severity)}</span>` : ''}
            </div>
            <p>${escapeHtml(issue.description)}</p>
            ${recommendation}
            ${snippet}
          </div>
        `;
      }).join('');
    return `
      <details>
        <summary>${escapeHtml(check.checkName)} (${escapeHtml(check.checkId)}) ${statusBadge} &middot; ${check.issuesFound} issue(s)</summary>
        ${errorBlock}
        ${issuesBlock}
      </details>
    `;
  }).join('');
  return `<section class="card"><h2>Checks</h2>${sections}</section>`;
}

export class HtmlFormatter implements OutputFormatter {
  readonly id = 'html';
  readonly fileExtension = '.html';

  format(results: ScanResults): string {
    const statusByCheck = new Map<string, string>();
    const issuesByCheck = new Map<string, SecurityIssue[]>();
    for (const check of results.checks) {
      statusByCheck.set(check.checkId, check.status);
      issuesByCheck.set(check.checkId, []);
    }
    for (const issue of results.issues) {
      const arr = issuesByCheck.get(issue.checkId);
      if (arr) arr.push(issue);
      else issuesByCheck.set(issue.checkId, [issue]);
    }

    const embeddedJson = escapeJsonForScriptTag(JSON.stringify(results));
    const title = `aghast scan ${escapeHtml(results.scanId)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    ${renderHeader(results)}
    ${renderSummary(results, results.repository)}
    ${renderIssuesTable(results.issues, statusByCheck)}
    ${renderCheckDetails(results.checks, issuesByCheck)}
    <footer>Generated by aghast v${escapeHtml(results.version)}</footer>
  </div>
  <script id="aghast-results" type="application/json">${embeddedJson}</script>
  <script>${CLIENT_JS}</script>
</body>
</html>
`;
  }
}
