/**
 * Tests for the unified CLI entry point (src/cli.ts).
 * Verifies subcommand routing, --help, --version, and error handling.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlink, access, readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(__dirname, '..', 'src', 'cli.ts');
const fixtureRepo = resolve(__dirname, 'fixtures', 'git-repo');
const outputFile = resolve(fixtureRepo, 'security_checks_results.json');
const singleCheckConfigDir = resolve(__dirname, 'fixtures', 'cli-configs', 'single-check');

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Windows + Node 24 libuv crash exit code (0xC0000005, nodejs/node#56645)
const LIBUV_CRASH_CODE = 3221226505;
const LIBUV_MAX_RETRIES = 3;

function runCLI(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): Promise<CLIResult> {
  const dotenvDefaults: Record<string, string | undefined> = {
    AGHAST_LOCAL_CLAUDE: undefined,
    AGHAST_MOCK_AI: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    AGHAST_CONFIG_DIR: '',
    AGHAST_GENERIC_PROMPT: undefined,
    AGHAST_AI_MODEL: undefined,
    AGHAST_DEBUG: undefined,
    NO_COLOR: '1',
  };
  const merged = { ...dotenvDefaults, ...env };
  const childEnv = { ...process.env, ...merged };
  for (const [key, val] of Object.entries(merged)) {
    if (val === undefined) {
      delete childEnv[key];
    }
  }
  const execOnce = (): Promise<CLIResult> => new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', cliEntry, ...args],
      {
        env: childEnv,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout,
          stderr,
          exitCode: error ? (child.exitCode ?? 1) : 0,
        });
      },
    );
  });

  // Retry on Windows libuv crash (nodejs/node#56645)
  return (async () => {
    for (let attempt = 1; attempt <= LIBUV_MAX_RETRIES; attempt++) {
      const result = await execOnce();
      if (result.exitCode === LIBUV_CRASH_CODE && attempt < LIBUV_MAX_RETRIES) {
        console.warn(
          `WARNING: libuv crash (0xC0000005) on attempt ${attempt}/${LIBUV_MAX_RETRIES}, retrying... (nodejs/node#56645)`,
        );
        continue;
      }
      return result;
    }
    throw new Error('runCLI: retry loop exited unexpectedly');
  })();
}

async function cleanupOutput(): Promise<void> {
  try {
    await unlink(outputFile);
  } catch {
    // File may not exist
  }
}

// ─── --help and no args ──────────────────────────────────────────────────────

describe('CLI subcommands: help and version', () => {
  it('no args shows usage and exits 0', async () => {
    const { exitCode, stdout } = await runCLI([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast'), 'Should show usage message');
    assert.ok(stdout.includes('scan'), 'Should list scan command');
    assert.ok(stdout.includes('new-check'), 'Should list new-check command');
  });

  it('--help shows usage and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast'), 'Should show usage message');
  });

  it('-h shows usage and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast'), 'Should show usage message');
  });

  it('--version prints version and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(['--version']);
    assert.equal(exitCode, 0);
    assert.match(stdout.trim(), /\d+\.\d+\.\d+$/, 'Should print semver version');
  });

  it('-V prints version and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(['-V']);
    assert.equal(exitCode, 0);
    assert.match(stdout.trim(), /\d+\.\d+\.\d+$/, 'Should print semver version');
  });

  it('prints logo from assets/txt/logo.txt on startup', async () => {
    const logoPath = resolve(__dirname, '..', 'assets', 'txt', 'logo.txt');
    const logoContent = await readFile(logoPath, 'utf-8');
    const { exitCode, stdout } = await runCLI(['--version']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes(logoContent.trim()), 'Should print logo matching assets/txt/logo.txt');
  });
});

// ─── Unknown command ──────────────────────────────────────────────────────────

describe('CLI subcommands: unknown command', () => {
  it('unknown command exits 1 with error code E1002', async () => {
    const { exitCode, stderr } = await runCLI(['foobar']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('[E1002]'), 'Should include error code E1002');
    assert.ok(stderr.includes('Unknown command: foobar'), 'Should show unknown command error');
    assert.ok(stderr.includes('Usage: aghast'), 'Should show usage in error output');
  });
});

// ─── scan subcommand delegation ──────────────────────────────────────────────

describe('CLI subcommands: scan delegation', () => {
  afterEach(cleanupOutput);

  it('scan subcommand delegates to scan runner successfully', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      ['scan', fixtureRepo, '--config-dir', singleCheckConfigDir],
      { AGHAST_MOCK_AI: 'true' },
    );
    assert.equal(exitCode, 0);
    const combined = stdout + stderr;
    assert.ok(combined.includes('AGHAST Scan Complete: NO ISSUES DETECTED'), 'Should complete scan with NO ISSUES DETECTED');
    await access(outputFile);
  });

  it('scan with no args shows scan help and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(
      ['scan'],
      { AGHAST_MOCK_AI: 'true' },
    );
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast scan'), 'Should show scan help');
  });

  it('scan --help shows scan help and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(
      ['scan', '--help'],
      { AGHAST_MOCK_AI: 'true' },
    );
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast scan'), 'Should show scan help');
    const scanOptions = [
      '--help',
      '--config-dir',
      '--output',
      '--output-format',
      '--fail-on-check-failure',
      '--debug',
      '--log-level',
      '--log-file',
      '--log-type',
      '--model',
      '--agent-provider',
      '--generic-prompt',
      '--runtime-config',
      '--diff-ref',
      '--diff-file',
      '--budget-limit-cost',
      '--budget-limit-tokens',
    ];
    for (const option of scanOptions) {
      assert.ok(stdout.includes(option), `Should describe ${option} flag`);
    }
    const environmentVariables = [
      'ANTHROPIC_API_KEY',
      'AGHAST_CONFIG_DIR',
      'AGHAST_AI_MODEL',
      'AGHAST_GENERIC_PROMPT',
      'AGHAST_DEBUG',
      'AGHAST_LOG_LEVEL',
      'AGHAST_LOG_FILE',
      'AGHAST_LOG_TYPE',
      'AGHAST_MOCK_SARIF',
      'AGHAST_OPENANT_DATASET',
      'AGHAST_DIFF_REF',
      'NO_COLOR',
    ];
    for (const variable of environmentVariables) {
      assert.ok(stdout.includes(variable), `Should describe ${variable}`);
    }
  });

  it('scan help works after the repository path', async () => {
    for (const helpFlag of ['--help', '-h']) {
      const { exitCode, stdout, stderr } = await runCLI(
        ['scan', fixtureRepo, helpFlag],
        { AGHAST_MOCK_AI: 'true' },
      );
      assert.equal(exitCode, 0, `${helpFlag} should exit successfully`);
      assert.ok(stdout.includes('Usage: aghast scan'), `${helpFlag} should show scan help`);
      assert.equal(stderr, '', `${helpFlag} should not report an unknown option`);
    }
  });
});

// ─── new-check subcommand delegation ─────────────────────────────────────────

describe('CLI subcommands: new-check delegation', () => {
  it('new-check delegates to new-check handler (not unknown command)', async () => {
    // new-check without --config-dir now exits with a clear error.
    // We verify it delegates (doesn't show "Unknown command").
    const { stderr } = await runCLI(
      ['new-check', '--id', 'test', '--name', 'Test'],
    );
    assert.ok(!stderr.includes('Unknown command'), 'Should delegate to new-check, not show unknown command');
    assert.ok(stderr.includes('[E2001]'), 'Should include error code E2001');
    assert.ok(stderr.includes('--config-dir is required'), 'Should show config-dir required error');
  });

  it('new-check --help shows help and exits 0', async () => {
    const { exitCode, stdout } = await runCLI(['new-check', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: aghast new-check'), 'Should show new-check help');
    assert.ok(stdout.includes('--id'), 'Should describe --id flag');
    assert.ok(stdout.includes('--check-type'), 'Should describe --check-type flag');
  });
});

// ─── Error codes in scan error paths ─────────────────────────────────────────

describe('CLI error codes in scan', () => {
  it('missing --config-dir shows E2001', async () => {
    const { exitCode, stderr } = await runCLI(
      ['scan', fixtureRepo],
      {},
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('[E2001]'), 'Should include error code E2001');
  });

  it('non-existent repo path shows E4001', async () => {
    const { exitCode, stderr } = await runCLI(
      ['scan', '/nonexistent/path/to/repo', '--config-dir', singleCheckConfigDir],
      { AGHAST_MOCK_AI: 'true' },
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('[E4001]'), 'Should include error code E4001');
  });

  it('missing flag argument shows E1001', async () => {
    const { exitCode, stderr } = await runCLI(
      ['scan', fixtureRepo, '--config-dir'],
      { AGHAST_MOCK_AI: 'true' },
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('[E1001]'), 'Should include error code E1001');
  });
});

// ─── Color output ────────────────────────────────────────────────────────────

describe('CLI color output', () => {
  afterEach(cleanupOutput);

  it('NO_COLOR=1 suppresses ANSI escape sequences', async () => {
    const { stdout, stderr } = await runCLI(
      ['scan', fixtureRepo, '--config-dir', singleCheckConfigDir],
      { AGHAST_MOCK_AI: 'true', NO_COLOR: '1' },
    );
    const combined = stdout + stderr;
    assert.ok(!combined.includes('\x1b['), 'Should not contain ANSI escape codes with NO_COLOR=1');
    assert.ok(combined.includes('AGHAST Scan Complete: NO ISSUES DETECTED'), 'Should still contain status text');
  });

  it('FORCE_COLOR=1 enables ANSI escape sequences', async () => {
    const { stdout, stderr } = await runCLI(
      ['scan', fixtureRepo, '--config-dir', singleCheckConfigDir],
      { AGHAST_MOCK_AI: 'true', NO_COLOR: undefined, FORCE_COLOR: '1' },
    );
    const combined = stdout + stderr;
    assert.ok(combined.includes('\x1b['), 'Should contain ANSI escape codes with FORCE_COLOR=1');
  });
});
