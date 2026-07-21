/**
 * Canonical documentation location, surfaced in CLI --help output so users who
 * install aghast via npm can discover the docs for configuration, check types
 * and examples. Single source of truth — do not duplicate these literals.
 */
export const DOCS_BASE = 'https://github.com/owasp-aghast/aghast/tree/main/docs';

/**
 * Build a help footer that links to a specific documentation page (e.g.
 * `scanning.md`), or to the docs index when no page is given. The page names
 * are asserted to exist on disk by tests/docs-links.test.ts, so a renamed or
 * removed page fails CI rather than shipping a dead link.
 */
export function docsFooter(page?: string): string {
  const url = page ? `${DOCS_BASE}/${page}` : DOCS_BASE;
  return `Documentation:\n  ${url}`;
}
