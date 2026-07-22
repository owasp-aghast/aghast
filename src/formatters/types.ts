/**
 * Output formatter interface for scan results.
 * Follows the AgentProvider interface pattern from src/types.ts.
 */

import type { ScanResults } from '../types.js';

export interface OutputFormatter {
  readonly id: string;
  readonly fileExtension: string;

  /**
   * Renders `results` to the formatter's output string.
   *
   * **Escaping contract.** `ScanResults` carries AI-authored free text —
   * `SecurityIssue.description`, `.recommendation`, and `judge.rationale` — that
   * is derived from the LLM's analysis of the *scanned* repository and can
   * therefore contain attacker-crafted content. Any formatter that renders these
   * fields into a surface where such content could break structure or become
   * active MUST neutralise them for that surface before emitting:
   *   - HTML     → `escapeHtml` (entity-encode; see `html-formatter.ts`)
   *   - Markdown → `description`/`.recommendation` are rendered as their own
   *     Markdown block, so they need the block-safe `escapeMarkdownText`
   *     (backslash-escape, newlines preserved). `judge.rationale` is always
   *     rendered inline after a fixed bullet prefix on a single line, so the
   *     narrower `escapeInlineText` (backslash-escape + collapse newlines to
   *     spaces) is sufficient — see `markdown-formatter.ts`.
   *   - CSV      → `escapeCsvField` (formula-injection guard + RFC-4180 quoting)
   *
   * Structured, non-rendered formats (JSON, SARIF) carry the raw text verbatim —
   * their serialisers already prevent structural breakout — so escaping there
   * would corrupt the payload and is intentionally omitted. Do NOT pre-sanitise
   * these fields centrally: the required transform differs per surface, and
   * mangling the shared `ScanResults` would corrupt the structured formats.
   */
  format(results: ScanResults): string;
}
