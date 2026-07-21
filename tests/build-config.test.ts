/**
 * Tests for the build-config CLI utility.
 *
 * Spawns the actual CLI process to verify:
 * - Non-interactive create new (flags only)
 * - Edit existing — preserves untouched fields, updates given ones
 * - --clear removes a field
 * - Validation rejects unknown provider, format, log level
 * - --runtime-config explicit path
 * - Bootstrap config-dir if missing
 * - Required: one of --config-dir / --runtime-config / AGHAST_CONFIG_DIR
 * - Help output
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(__dirname, '..', 'src', 'cli.ts');

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCLI(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<CLIResult> {
  return new Promise((resolvePromise) => {
    // Empty strings (rather than `delete`) so dotenv in the child won't refill from .env.
    // ANTHROPIC_API_KEY/AGHAST_LOCAL_CLAUDE are blanked, and AGHAST_MOCK_LOCAL_LOGIN='false'
    // forces the local-login probe to report "not logged in", so listModels() rejects fast
    // on the claude-code provider's credential check instead of spawning a Claude CLI
    // subprocess to probe `accountInfo()` (slow on Windows/WSL).
    const baseEnv = {
      ...process.env,
      NO_COLOR: '1',
      AGHAST_CONFIG_DIR: '',
      ANTHROPIC_API_KEY: '',
      AGHAST_LOCAL_CLAUDE: '',
      AGHAST_MOCK_LOCAL_LOGIN: 'false',
    };
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) {
        delete baseEnv[k];
      } else {
        baseEnv[k] = v;
      }
    }
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', cliEntry, 'build-config', ...args],
      { env: baseEnv, timeout: 30_000 },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout,
          stderr,
          exitCode: error ? (child.exitCode ?? 1) : 0,
        });
      },
    );
  });
}

describe('build-config CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aghast-build-config-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('--help exits 0 and shows usage', async () => {
    const { exitCode, stdout } = await runCLI(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('build-config'), 'help should mention build-config');
    assert.ok(stdout.includes('--non-interactive'), 'help should describe --non-interactive');
    assert.ok(stdout.includes('--clear'), 'help should describe --clear');
  });

  it('errors when neither --config-dir nor --runtime-config is given', async () => {
    // Set to empty string (falsy) — dotenv won't override an existing value.
    const { exitCode, stderr } = await runCLI(['--non-interactive'], {
      AGHAST_CONFIG_DIR: '',
    });
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('E2001'), `stderr should include E2001, got: ${stderr}`);
  });

  it('non-interactive creates a new config file with given flags', async () => {
    const { exitCode } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--provider', 'claude-code',
      '--output-format', 'sarif',
      '--log-level', 'debug',
      '--fail-on-check-failure', 'true',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(join(tempDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(written.agentProvider.name, 'claude-code');
    assert.equal(written.reporting.outputFormat, 'sarif');
    assert.equal(written.logging.level, 'debug');
    assert.equal(written.failOnCheckFailure, true);
  });

  it('preserves untouched fields when editing existing config', async () => {
    const target = join(tempDir, 'runtime-config.json');
    await writeFile(target, JSON.stringify({
      agentProvider: { name: 'claude-code', model: 'sonnet' },
      reporting: { outputFormat: 'json', outputDirectory: '/tmp/out' },
      failOnCheckFailure: false,
    }), 'utf-8');

    const { exitCode } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--output-format', 'sarif',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(target, 'utf-8'));
    assert.equal(written.agentProvider.model, 'sonnet', 'model preserved');
    assert.equal(written.reporting.outputDirectory, '/tmp/out', 'outputDirectory preserved');
    assert.equal(written.reporting.outputFormat, 'sarif', 'format updated');
    assert.equal(written.failOnCheckFailure, false, 'bool preserved');
  });

  it('--clear removes a field from existing config', async () => {
    const target = join(tempDir, 'runtime-config.json');
    await writeFile(target, JSON.stringify({
      agentProvider: { name: 'claude-code', model: 'sonnet' },
      reporting: { outputDirectory: '/tmp/out', outputFormat: 'json' },
    }), 'utf-8');

    const { exitCode } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--clear', 'model',
      '--clear', 'outputDirectory',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(target, 'utf-8'));
    assert.equal(written.agentProvider.name, 'claude-code');
    assert.equal(written.agentProvider.model, undefined, 'model cleared');
    assert.equal(written.reporting.outputDirectory, undefined, 'outputDirectory cleared');
    assert.equal(written.reporting.outputFormat, 'json', 'format preserved');
  });

  it('rejects unknown provider', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--provider', 'gpt-please',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('E3002'), `expected E3002, got: ${stderr}`);
  });

  it('rejects unknown output format', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--output-format', 'xml',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('E2005'), `expected E2005, got: ${stderr}`);
  });

  it('rejects unknown log level', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--log-level', 'shouty',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('Invalid log level'));
  });

  it('rejects unknown --clear field', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--clear', 'nonsense',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('Unknown --clear field'));
  });

  it('rejects non-boolean --fail-on-check-failure', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--fail-on-check-failure', 'maybe',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('Invalid --fail-on-check-failure'));
  });

  it('--runtime-config writes to explicit path (not config-dir)', async () => {
    const explicit = join(tempDir, 'nested', 'custom.json');
    const { exitCode } = await runCLI([
      '--runtime-config', explicit,
      '--non-interactive',
      '--output-format', 'sarif',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(explicit, 'utf-8'));
    assert.equal(written.reporting.outputFormat, 'sarif');
  });

  it('bootstraps config-dir if missing', async () => {
    const newDir = join(tempDir, 'fresh-checks');
    const { exitCode } = await runCLI([
      '--config-dir', newDir,
      '--non-interactive',
      '--output-format', 'json',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(join(newDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(written.reporting.outputFormat, 'json');
  });

  it('non-interactive with no flags and no existing config writes empty config', async () => {
    const { exitCode } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
    ]);
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(join(tempDir, 'runtime-config.json'), 'utf-8'));
    assert.deepEqual(written, {});
  });

  it('rejects --provider with a value that starts with --', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--provider',
      '--non-interactive',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('E1001'));
  });

  it('rejects unknown options (typo protection)', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--outpt-format', 'sarif', // typo for --output-format
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('Unknown option') && stderr.includes('--outpt-format'),
      `expected unknown-option error, got: ${stderr}`);
  });

  it('rejects conflicting --clear and --<field>', async () => {
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--clear', 'model',
      '--model', 'sonnet',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes('Conflicting flags'),
      `expected conflicting-flags error, got: ${stderr}`);
  });

  it('--clear provider while keeping model in existing config (F12)', async () => {
    // Edge case: clearing provider leaves model set. Whether validation can verify the
    // model depends on auth — if SDK call fails (no API key, no local Claude session),
    // validation is skipped via warning. Either way the config is written correctly.
    const target = join(tempDir, 'runtime-config.json');
    await writeFile(target, JSON.stringify({
      agentProvider: { name: 'claude-code', model: 'sonnet' },
    }), 'utf-8');

    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--clear', 'provider',
    ], { ANTHROPIC_API_KEY: '', AGHAST_LOCAL_CLAUDE: '' });
    assert.equal(exitCode, 0);
    // With no auth, validation is skipped via warning rather than silently passing.
    assert.ok(stderr.includes('skipped model validation'),
      `expected warning that model validation was skipped, got stderr: ${stderr}`);
    const written = JSON.parse(await readFile(target, 'utf-8'));
    assert.equal(written.agentProvider?.name, undefined, 'provider cleared');
    assert.equal(written.agentProvider?.model, 'sonnet', 'model preserved');
  });

  it('--model without --provider preserves the value (validation against default provider) (F14)', async () => {
    // When --model is set without --provider, the validation block falls back to the
    // default provider to fetch its model list. As above, if auth isn't available the
    // validation is skipped via warning — what we're testing here is that the model
    // value lands in the written config either way.
    const { exitCode, stderr } = await runCLI([
      '--config-dir', tempDir,
      '--non-interactive',
      '--model', 'sonnet',
    ], { ANTHROPIC_API_KEY: '', AGHAST_LOCAL_CLAUDE: '' });
    assert.equal(exitCode, 0);
    assert.ok(stderr.includes('skipped model validation'),
      `expected warning that model validation was skipped, got stderr: ${stderr}`);
    const written = JSON.parse(await readFile(join(tempDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(written.agentProvider?.model, 'sonnet');
  });

  it('AGHAST_CONFIG_DIR env var resolves the target path when no flag is given (F15)', async () => {
    // Affirmative test: env-var fallback writes the file in the right place.
    const { exitCode } = await runCLI([
      '--non-interactive',
      '--output-format', 'json',
    ], { AGHAST_CONFIG_DIR: tempDir });
    assert.equal(exitCode, 0);
    const written = JSON.parse(await readFile(join(tempDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(written.reporting?.outputFormat, 'json');
  });
});
