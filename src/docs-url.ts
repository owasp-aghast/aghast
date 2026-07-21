/**
 * Canonical documentation URL, surfaced in CLI --help output so users who
 * install aghast via npm can discover the docs for configuration, check types
 * and examples. Single source of truth — do not duplicate this literal.
 */
export const DOCS_URL = 'https://github.com/owasp-aghast/aghast/tree/main/docs';

/** Ready-to-append help footer pointing at the documentation. */
export const DOCS_HELP_FOOTER = `Documentation:\n  ${DOCS_URL}`;
