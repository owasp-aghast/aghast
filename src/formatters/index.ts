/**
 * Formatter registry — resolves output format IDs to formatter instances.
 */

import type { OutputFormatter } from './types.js';
import { JsonFormatter } from './json-formatter.js';
import { SarifFormatter } from './sarif-formatter.js';
import { CsvFormatter } from './csv-formatter.js';
import { HtmlFormatter } from './html-formatter.js';
import { MarkdownFormatter } from './markdown-formatter.js';

export type { OutputFormatter } from './types.js';

const formatters = new Map<string, OutputFormatter>([
  ['json', new JsonFormatter()],
  ['sarif', new SarifFormatter()],
  ['csv', new CsvFormatter()],
  ['html', new HtmlFormatter()],
  ['markdown', new MarkdownFormatter()],
]);

/** Returns the formatter for the given ID, or throws listing available formats. */
export function getFormatter(id: string): OutputFormatter {
  const formatter = formatters.get(id);
  if (!formatter) {
    const available = getAvailableFormats().join(', ');
    throw new Error(`Unknown output format "${id}". Available formats: ${available}`);
  }
  return formatter;
}

/** Returns all registered format IDs. */
export function getAvailableFormats(): string[] {
  return Array.from(formatters.keys());
}
