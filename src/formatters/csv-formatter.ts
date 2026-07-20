/**
 * CSV output formatter — one row per SecurityIssue (plus a row per ERROR check)
 * for spreadsheet analysis (Excel, Google Sheets, etc.).
 *
 * Output contract:
 *   - Encoding: UTF-8, no BOM. Excel-on-Windows may render non-ASCII bytes as
 *     mojibake when a CSV is opened directly without an encoding hint; consumers
 *     that need Excel auto-detection should use the JSON or SARIF output instead,
 *     or import the CSV via Excel's "From Text/CSV" wizard which lets you pick
 *     UTF-8 explicitly.
 *   - Line terminator: CRLF (RFC 4180). Final row is also CRLF-terminated.
 *   - Quoting: RFC 4180 — fields containing `,`, `"`, CR, or LF are wrapped in
 *     double quotes; embedded `"` is doubled.
 *   - Description: flattened to a single line (CR/LF/CRLF → single space) and
 *     truncated to {@link DESCRIPTION_MAX_LENGTH} chars with a U+2026 ellipsis.
 *   - The structured `dataFlow` taint trace on `SecurityIssue` is intentionally
 *     omitted — flat per-issue rows can't represent a list well; SARIF/JSON
 *     output keeps the full trace.
 */

import type { ScanResults, SecurityIssue, CheckExecutionSummary } from '../types.js';
import type { OutputFormatter } from './types.js';

/** Maximum length of the description field in CSV output (longer values are truncated with an ellipsis). */
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Judge columns are appended at the end and are ALWAYS present, even when the
 * judge did not run (in which case they are empty).
 *
 * Two deliberate choices, both different from the HTML formatter:
 *
 *   - Appended, not inserted: a consumer reading by column index keeps working
 *     for every column it already knew about.
 *   - Unconditional, not "only when the judge ran": CSV is the format most
 *     likely to be machine-parsed, and a header row that changes shape
 *     depending on runtime configuration is far more hostile to a script than
 *     a couple of empty columns. HTML can afford to hide an empty column
 *     because a human reads it; a parser cannot.
 *
 * Scan-level cost is deliberately NOT a column. It is a single value for the
 * whole run, so repeating it on every row would invite summing it — yielding
 * cost × issue-count, silently and wrongly. It stays in the JSON, Markdown and
 * HTML reports, where it can be shown once.
 */
const CSV_HEADERS = [
  'checkId',
  'checkName',
  'status',
  'file',
  'startLine',
  'endLine',
  'severity',
  'confidence',
  'description',
  'recommendation',
  'judgeVerdict',
  'judgeConfidence',
  'judgeRationale',
] as const;

/** Escapes a single CSV field per RFC 4180. */
export function escapeCsvField(value: string | number | undefined): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  // Wrap in quotes if it contains a comma, quote, CR, or LF.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Truncates a description to fit within the CSV column and replaces newlines
 * with spaces so each issue stays on a single row.
 */
export function normalizeDescription(description: string): string {
  // Replace any sequence of CR/LF with a single space so the cell stays on one line
  // (CSV viewers do support multi-line cells via quoting, but flattening keeps spreadsheets readable).
  const flattened = description.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length <= DESCRIPTION_MAX_LENGTH) return flattened;
  return flattened.slice(0, DESCRIPTION_MAX_LENGTH - 1) + '…'; // ellipsis
}

function statusForIssue(issue: SecurityIssue, checkStatusByCheckId: Map<string, string>): string {
  // Fall back to 'UNKNOWN' (not 'FAIL') for orphaned issues so a row in the
  // spreadsheet doesn't claim a check status that wasn't actually reported.
  return checkStatusByCheckId.get(issue.checkId) ?? 'UNKNOWN';
}

function issueRow(issue: SecurityIssue, checkStatus: string): string {
  return [
    escapeCsvField(issue.checkId),
    escapeCsvField(issue.checkName),
    escapeCsvField(checkStatus),
    escapeCsvField(issue.file),
    escapeCsvField(issue.startLine),
    escapeCsvField(issue.endLine),
    escapeCsvField(issue.severity),
    escapeCsvField(issue.confidence),
    escapeCsvField(normalizeDescription(issue.description)),
    escapeCsvField(issue.recommendation),
    escapeCsvField(issue.judge?.verdict),
    // Confidence as a plain 0–1 number: spreadsheets can format or threshold it,
    // which a "85%" string would prevent.
    escapeCsvField(issue.judge?.confidence),
    // Model-authored free text — flattened and truncated like description, so a
    // multi-paragraph rationale cannot blow up the row.
    escapeCsvField(issue.judge?.rationale ? normalizeDescription(issue.judge.rationale) : undefined),
  ].join(',');
}

function errorCheckRow(check: CheckExecutionSummary): string {
  // Surface execution errors so they show up alongside issues in spreadsheets.
  // No file/line/severity/confidence/recommendation — just the error in the description column.
  const description = normalizeDescription(check.error ? `Check execution error: ${check.error}` : 'Check execution error');
  return [
    escapeCsvField(check.checkId),
    escapeCsvField(check.checkName),
    escapeCsvField(check.status),
    '', // file
    '', // startLine
    '', // endLine
    '', // severity
    '', // confidence
    escapeCsvField(description),
    '', // recommendation
    '', // judgeVerdict — an ERROR check produced no issue to judge
    '', // judgeConfidence
    '', // judgeRationale
  ].join(',');
}

export class CsvFormatter implements OutputFormatter {
  readonly id = 'csv';
  readonly fileExtension = '.csv';

  format(results: ScanResults): string {
    const checkStatusByCheckId = new Map<string, string>();
    for (const check of results.checks) {
      checkStatusByCheckId.set(check.checkId, check.status);
    }

    const lines: string[] = [CSV_HEADERS.join(',')];

    for (const issue of results.issues) {
      lines.push(issueRow(issue, statusForIssue(issue, checkStatusByCheckId)));
    }

    for (const check of results.checks) {
      if (check.status === 'ERROR') {
        lines.push(errorCheckRow(check));
      }
    }

    // RFC 4180 specifies CRLF line endings.
    return lines.join('\r\n') + '\r\n';
  }
}
