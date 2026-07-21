#!/usr/bin/env node
/**
 * Unified CLI entry point for aghast.
 * Subcommand router: delegates to `scan` or `new-check`.
 *
 * Usage:
 *   aghast scan <repo-path> [options]
 *   aghast new-check [options]
 *   aghast --help
 *   aghast --version
 */

import 'dotenv/config';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, formatError, formatFatalError } from './error-codes.js';
import { DOCS_HELP_FOOTER } from './docs-url.js';

// Signal to subcommand modules that they're being imported, not run directly
process.env._AGHAST_CLI = '1';

const USAGE = `Usage: aghast <command> [options]

Commands:
  scan           Run security checks against a repository
  new-check      Scaffold a new security check
  build-config   Build or edit a runtime-config.json (interactive or flag-driven)
  stats          Print a cost summary from the scan history

Options:
  --help      Show this help message
  --version   Show version number

Run 'aghast <command> --help' for more information on a command.

${DOCS_HELP_FOOTER}`;

function getVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

function printVersion(): void {
  console.log(getVersion());
}

function printLogo(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const logoPath = resolve(__dirname, '..', 'assets', 'txt', 'logo.txt');
  try {
    const logo = readFileSync(logoPath, 'utf-8');
    console.log(logo);
  } catch {
    // Logo file not found — continue without it
  }
}

async function main(): Promise<void> {
  // Graceful shutdown on POSIX signals
  process.on('SIGINT', () => {
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    process.exit(143);
  });

  const args = process.argv.slice(2);
  const command = args[0];

  // Skip the logo for `stats --json` so machine-readable output is parseable.
  const isStatsJson = command === 'stats' && args.includes('--json');
  if (!isStatsJson) {
    printLogo();
  }

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === '--version' || command === '-V') {
    printVersion();
    process.exit(0);
  }

  const subArgs = args.slice(1);

  switch (command) {
    case 'scan': {
      const { runScan } = await import('./index.js');
      await runScan(subArgs);
      break;
    }
    case 'new-check': {
      const { runNewCheck } = await import('./new-check.js');
      await runNewCheck(subArgs);
      break;
    }
    case 'build-config': {
      const { runBuildConfig } = await import('./build-config.js');
      await runBuildConfig(subArgs);
      break;
    }
    case 'stats': {
      const { runStats } = await import('./stats.js');
      await runStats(subArgs);
      break;
    }
    default:
      console.error(formatError(ERROR_CODES.E1002, `Unknown command: ${command}`));
      console.error('');
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('');
  console.error(formatFatalError(err instanceof Error ? err.message : String(err), getVersion()));
  process.exit(1);
});
