/**
 * `aghast stats` subcommand: prints a cost summary table from the scan history.
 *
 * The history file is written to by `aghast scan` (see scan-history.ts). Stats
 * are aggregated by repository and by model. Output is plain text suitable for
 * a terminal; users wanting to feed stats into Grafana / spreadsheets can read
 * the underlying `~/.aghast/history.json` directly.
 */

import 'dotenv/config';
import { ERROR_CODES, formatError } from './error-codes.js';
import { queryScanHistory, type ScanRecord, type HistoryFilters } from './scan-history.js';
import { formatCostSourceLabel } from './cost-calculator.js';
import { DOCS_HELP_FOOTER } from './docs-url.js';

const STATS_HELP = `Usage: aghast stats [options]

Print a cost summary from the scan history (~/.aghast/history.json).

Options:
  --repo <substring>     Filter to scans whose repository path or URL contains
                         the substring. Matches loosely — "alpha" matches both
                         "/repos/alpha" and "/repos/alpha2".
  --model <substring>    Filter to scans that used a model containing the
                         substring (loose match).
  --since <iso-time>     Only include scans started at or after this timestamp
  --until <iso-time>     Only include scans started at or before this timestamp
  --json                 Output raw JSON instead of a formatted table
  --history-file <path>  Override the history file path (default: ~/.aghast/history.json)
  --help                 Show this help message

Examples:
  aghast stats
  aghast stats --repo my-org/my-repo --since 2026-01-01
  aghast stats --model claude-sonnet --json

${DOCS_HELP_FOOTER}`;

interface StatsArgs {
  repo?: string;
  model?: string;
  since?: string;
  until?: string;
  json: boolean;
  historyFile?: string;
}

function parseStatsArgs(args: string[]): StatsArgs {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(STATS_HELP);
    process.exit(0);
  }
  let repo: string | undefined;
  let model: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let json = false;
  let historyFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--repo':
        repo = args[i + 1];
        if (!repo) {
          console.error(formatError(ERROR_CODES.E1001, '--repo requires a value'));
          process.exit(1);
        }
        i++;
        break;
      case '--model':
        model = args[i + 1];
        if (!model) {
          console.error(formatError(ERROR_CODES.E1001, '--model requires a value'));
          process.exit(1);
        }
        i++;
        break;
      case '--since':
        since = args[i + 1];
        if (!since) {
          console.error(formatError(ERROR_CODES.E1001, '--since requires a timestamp'));
          process.exit(1);
        }
        i++;
        break;
      case '--until':
        until = args[i + 1];
        if (!until) {
          console.error(formatError(ERROR_CODES.E1001, '--until requires a timestamp'));
          process.exit(1);
        }
        i++;
        break;
      case '--json':
        json = true;
        break;
      case '--history-file':
        historyFile = args[i + 1];
        if (!historyFile) {
          console.error(formatError(ERROR_CODES.E1001, '--history-file requires a path'));
          process.exit(1);
        }
        i++;
        break;
      default:
        // Unknown flags are tolerated (forward-compat) but logged to stderr
        if (args[i].startsWith('--')) {
          console.error(`Warning: unknown stats option ${args[i]}`);
        }
    }
  }
  return { repo, model, since, until, json, historyFile };
}

/**
 * Resolve the cost source for a history record. Records written before the
 * cost-accuracy fix (lacking costSource) are tagged 'legacy'.
 */
function recordCostSource(r: ScanRecord): ScanRecord['costSource'] {
  return r.costSource ?? 'legacy';
}

interface AggregateRow {
  key: string;
  scans: number;
  totalCost: number;
  totalTokens: number;
  currency: string;
}

function aggregateBy(
  records: ScanRecord[],
  selector: (r: ScanRecord) => string[],
): AggregateRow[] {
  const map = new Map<string, AggregateRow>();
  for (const r of records) {
    const tokens = r.tokenUsage?.totalTokens ?? 0;
    for (const key of selector(r)) {
      const existing = map.get(key);
      if (existing) {
        existing.scans += 1;
        existing.totalCost += r.totalCost;
        existing.totalTokens += tokens;
      } else {
        map.set(key, {
          key,
          scans: 1,
          totalCost: r.totalCost,
          totalTokens: tokens,
          currency: r.currency,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
}

function formatTable(rows: AggregateRow[], keyHeader: string): string {
  if (rows.length === 0) return '  (no records)';
  const headers = [keyHeader, 'Scans', 'Tokens', 'Cost'];
  const data = rows.map((r) => [
    r.key,
    String(r.scans),
    r.totalTokens.toLocaleString(),
    `${r.totalCost.toFixed(4)} ${r.currency}`,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const fmtRow = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmtRow(headers), sep, ...data.map(fmtRow)].join('\n');
}

function formatRecentRow(r: ScanRecord): string {
  const source = recordCostSource(r);
  const sourceLabel = formatCostSourceLabel(source, r.costReportedBy, r.costCoveredBySubscription);
  const equiv = r.costCoveredBySubscription ? ' equivalent' : '';
  return `  [${r.startedAt}] ${r.repositoryUrl ?? r.repository}  models=${r.models.join(',')}  tokens=${(r.tokenUsage?.totalTokens ?? 0).toLocaleString()}  cost=${r.totalCost.toFixed(4)}${equiv} ${r.currency}  ${sourceLabel}`;
}

export async function runStats(args: string[]): Promise<void> {
  const parsed = parseStatsArgs(args);

  const filters: HistoryFilters = {};
  if (parsed.repo) filters.repository = parsed.repo;
  if (parsed.model) filters.model = parsed.model;
  if (parsed.since) filters.since = parsed.since;
  if (parsed.until) filters.until = parsed.until;

  const records = await queryScanHistory(filters, { historyFile: parsed.historyFile });

  if (parsed.json) {
    const enriched = records.map((r) => ({
      ...r,
      costSource: recordCostSource(r),
      // Pre-feature records have no costCoveredBySubscription field; default to false
      // (they were not subscription runs, so the value is correct for old records too).
      costCoveredBySubscription: r.costCoveredBySubscription ?? false,
    }));
    console.log(JSON.stringify({ records: enriched }, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log('No scan history found.');
    console.log('  Run `aghast scan ...` to record scans, then re-run `aghast stats`.');
    return;
  }

  const totalCost = records.reduce((sum, r) => sum + r.totalCost, 0);
  const totalTokens = records.reduce((sum, r) => sum + (r.tokenUsage?.totalTokens ?? 0), 0);
  const currency = records[0].currency;

  console.log('=== AGHAST Scan Statistics ===');
  console.log(`  Scans:           ${records.length}`);
  console.log(`  Total tokens:    ${totalTokens.toLocaleString()}`);
  console.log(`  Total est. cost: ${totalCost.toFixed(4)} ${currency}`);
  console.log('');
  console.log('By repository:');
  console.log(formatTable(
    aggregateBy(records, (r) => [r.repositoryUrl ?? r.repository]),
    'Repository',
  ));
  console.log('');
  console.log('By model:');
  console.log(formatTable(
    aggregateBy(records, (r) => (r.models.length > 0 ? r.models : ['(none)'])),
    'Model',
  ));
  console.log('');
  console.log('Recent scans (newest first):');
  for (const r of records.slice(0, 10)) {
    console.log(formatRecentRow(r));
  }
}
