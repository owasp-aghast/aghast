/**
 * Trackable error codes for CLI error paths.
 *
 * Numbering scheme:
 *   E1xxx — CLI parsing (argument/flag/command errors)
 *   E2xxx — Configuration (config dir, checks, runtime config)
 *   E3xxx — Agent provider
 *   E4xxx — Repository/target validation
 *   E5xxx — Semgrep
 *   E6xxx — OpenAnt
 *   E9xxx — Internal/fatal
 */

export interface ErrorCode {
  code: string;
  label: string;
}

function ec(code: string, label: string): ErrorCode {
  return { code, label };
}

export const ERROR_CODES = {
  // E1xxx — CLI parsing
  E1001: ec('E1001', 'Missing required flag argument'),
  E1002: ec('E1002', 'Unknown command'),
  E1003: ec('E1003', 'Required input missing'),

  // E2xxx — Configuration
  E2001: ec('E2001', 'Config directory not specified'),
  E2002: ec('E2002', 'Config directory structure invalid'),
  E2003: ec('E2003', 'No checks found'),
  E2004: ec('E2004', 'Invalid check definition'),
  E2005: ec('E2005', 'Configuration error'),

  // E3xxx — Agent provider
  E3001: ec('E3001', 'API key missing'),
  E3002: ec('E3002', 'Unknown agent provider'),
  // E3003 retains "AI" intentionally: it refers to the file containing the
  // mocked AI/LLM response body, not the agent harness. Same rationale as
  // AGHAST_MOCK_AI / AGHAST_AI_MODEL — the model and its output are AI
  // concerns; only the provider/harness layer was renamed to "agent".
  E3003: ec('E3003', 'Mock AI response file not found'),
  E3004: ec('E3004', 'OpenCode not installed'),

  // E4xxx — Repository/target validation
  E4001: ec('E4001', 'Repository path not found'),

  // E5xxx — Semgrep
  E5001: ec('E5001', 'Semgrep not installed'),

  // E6xxx — OpenAnt
  E6001: ec('E6001', 'OpenAnt not installed'),
  E6002: ec('E6002', 'OpenAnt execution failed'),

  // E7xxx — Budget / cost controls
  E7001: ec('E7001', 'Budget limit exceeded'),

  // E9xxx — Internal
  E9001: ec('E9001', 'Fatal internal error'),
} as const;

/**
 * Format an error message with a trackable error code.
 * Output: "Error [E1001]: <message>"
 */
export function formatError(errorCode: ErrorCode, message: string): string {
  return `Error [${errorCode.code}]: ${message}`;
}

/**
 * Format a fatal error with version and bug report URL.
 */
export function formatFatalError(message: string, version: string): string {
  const title = encodeURIComponent(`[Bug] ${message}`);
  const body = encodeURIComponent(`**Version:** ${version}\n\n**Error:**\n${message}`);
  const url = `https://github.com/owasp-aghast/aghast/issues/new?title=${title}&body=${body}&labels=bug`;
  return [
    `AGHAST Fatal Error [${ERROR_CODES.E9001.code}]: ${message}`,
    `Version: ${version}`,
    '',
    `If this is unexpected, please report it:`,
    `  ${url}`,
  ].join('\n');
}
