/**
 * Tests for the new-check CLI utility.
 *
 * Spawns the actual CLI process with flags to verify:
 * - Check folder creation (<id>.json + <id>.md)
 * - Registry entry appending (checks-config.json)
 * - Optional field handling (severity, confidence, FLAG condition)
 * - aghast- prefix enforcement
 * - Duplicate ID rejection
 * - Existing folder rejection
 * - Semgrep rule/test scaffolding inside check folder
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(__dirname, '..', 'src', 'new-check.ts');

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runNewCheck(args: string[]): Promise<CLIResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entryPoint, ...args],
      {
        env: { ...process.env },
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
}

/**
 * Runs the new-check CLI interactively, feeding lines to stdin one at a time
 * as prompts appear on stdout. `stdinLines` are written in order whenever
 * the process is waiting for input.
 */
function runNewCheckInteractive(args: string[], stdinLines: string[]): Promise<CLIResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', entryPoint, ...args],
      { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let lineIndex = 0;

    function tryWriteNextLine(): void {
      if (lineIndex < stdinLines.length && child.stdin.writable) {
        child.stdin.write(stdinLines[lineIndex] + '\n');
        lineIndex++;
      } else if (lineIndex >= stdinLines.length && child.stdin.writable) {
        child.stdin.end();
      }
    }

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Each prompt ends with `: ` — feed the next line when we see one
      if (data.toString().includes(': ')) {
        tryWriteNextLine();
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill();
      resolvePromise({ stdout, stderr: stderr + '\n(killed: timeout)', exitCode: 1 });
    }, 30_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

// Each test gets its own temp directory
let tempDir: string;
let configDir: string;
let checksDir: string;
let registryPath: string;

async function setupTempDir(): Promise<void> {
  tempDir = resolve(__dirname, '..', '.tmp-test-' + randomUUID().slice(0, 8));
  configDir = tempDir;
  checksDir = resolve(tempDir, 'checks');
  registryPath = resolve(configDir, 'checks-config.json');

  await mkdir(checksDir, { recursive: true });
  await writeFile(registryPath, JSON.stringify({ checks: [] }, null, 2), 'utf-8');
}

async function cleanupTempDir(): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function allFlags(overrides: Record<string, string> = {}): string[] {
  const defaults: Record<string, string> = {
    '--id': 'aghast-test',
    '--name': 'Test Check',
    '--check-overview': 'Tests things',
    '--check-items': 'Item 1,Item 2',
    '--pass-condition': 'All tests pass',
    '--fail-condition': 'Tests fail',
    '--check-type': 'repository',
    '--config-dir': configDir,
  };

  const merged = { ...defaults, ...overrides };
  const args: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    args.push(key, value);
  }
  return args;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('new-check utility', () => {
  beforeEach(async () => {
    await setupTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  it('generates check folder with <id>.json and <id>.md', async () => {
    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify <id>.json (Layer 2)
    const checkJsonPath = resolve(checksDir, 'aghast-test', 'aghast-test.json');
    const checkDef = JSON.parse(await readFile(checkJsonPath, 'utf-8'));

    assert.equal(checkDef.id, 'aghast-test');
    assert.equal(checkDef.name, 'Test Check');
    assert.equal(checkDef.instructionsFile, 'aghast-test.md');

    // Verify <id>.md
    const mdPath = resolve(checksDir, 'aghast-test', 'aghast-test.md');
    const mdContent = await readFile(mdPath, 'utf-8');

    assert.ok(mdContent.includes('### Test Check'), 'Missing check name heading');
    assert.ok(mdContent.includes('#### Overview'), 'Missing Overview section');
    assert.ok(mdContent.includes('Tests things'), 'Missing overview content');
    assert.ok(mdContent.includes('#### What to Check'), 'Missing What to Check section');
    assert.ok(mdContent.includes('1. Item 1'), 'Missing first check item');
    assert.ok(mdContent.includes('2. Item 2'), 'Missing second check item');
    assert.ok(mdContent.includes('#### Result'), 'Missing Result section');
    assert.ok(mdContent.includes('**PASS**: All tests pass'), 'Missing PASS condition');
    assert.ok(mdContent.includes('**FAIL**: Tests fail'), 'Missing FAIL condition');

    // Verify registry entry (Layer 1)
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks.length, 1);
    const entry = registry.checks[0];
    assert.equal(entry.id, 'aghast-test');
    assert.deepEqual(entry.repositories, []);
    assert.equal(entry.enabled, true);
  });

  it('auto-prepends aghast- prefix when missing', async () => {
    const result = await runNewCheck(allFlags({ '--id': 'xss-check' }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Check folder should be created with prefix
    const checkJsonPath = resolve(checksDir, 'aghast-xss-check', 'aghast-xss-check.json');
    const checkDef = JSON.parse(await readFile(checkJsonPath, 'utf-8'));
    assert.equal(checkDef.id, 'aghast-xss-check');

    // Registry entry should have prefixed id
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks[0].id, 'aghast-xss-check');
  });

  it('does not double-prepend prefix when already present', async () => {
    const result = await runNewCheck(allFlags({ '--id': 'aghast-test' }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks[0].id, 'aghast-test', 'should not be aghast-aghast-test');
  });

  it('includes severity and confidence in check.json when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--severity': 'high',
      '--confidence': 'medium',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.severity, 'high');
    assert.equal(checkDef.confidence, 'medium');
  });

  it('uses default severity and confidence when not provided', async () => {
    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.severity, 'high', 'severity should default to high');
    assert.equal(checkDef.confidence, 'medium', 'confidence should default to medium');
  });

  it('includes FLAG condition in markdown when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--flag-condition': 'Complex logic requires human review',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const mdContent = await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.md'), 'utf-8');
    assert.ok(mdContent.includes('**FLAG**: Complex logic requires human review'), 'Missing FLAG condition');
    // Verify ordering: PASS, FAIL, FLAG
    const passIdx = mdContent.indexOf('**PASS**');
    const failIdx = mdContent.indexOf('**FAIL**');
    const flagIdx = mdContent.indexOf('**FLAG**');
    assert.ok(passIdx < failIdx, 'PASS should come before FAIL');
    assert.ok(failIdx < flagIdx, 'FAIL should come before FLAG');
  });

  it('omits FLAG condition line when not provided', async () => {
    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const mdContent = await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.md'), 'utf-8');
    assert.ok(!mdContent.includes('**FLAG**'), 'FLAG line should not be present');
  });

  it('creates missing check files without duplicating an existing registry entry', async () => {
    // Seed registry with an existing check whose folder is missing
    const existingRegistry = {
      checks: [{
        id: 'aghast-test',
        repositories: ['https://github.com/example/repo'],
        enabled: false,
      }],
    };
    await writeFile(registryPath, JSON.stringify(existingRegistry, null, 2), 'utf-8');

    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('already exists in checks-config.json'),
      `Expected existing-registry warning, got: ${result.stderr}`,
    );

    const checkJsonPath = resolve(checksDir, 'aghast-test', 'aghast-test.json');
    const checkDef = JSON.parse(await readFile(checkJsonPath, 'utf-8'));
    assert.equal(checkDef.id, 'aghast-test');

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.deepEqual(registry, existingRegistry, 'Existing registry entry should remain unchanged');
  });

  it('rejects when check folder already exists', async () => {
    // Create the folder first
    await mkdir(resolve(checksDir, 'aghast-test'), { recursive: true });

    const result = await runNewCheck(allFlags());

    assert.notEqual(result.exitCode, 0, 'Should have failed for existing folder');
    assert.ok(
      result.stderr.includes('already exists'),
      `Expected folder-exists error, got: ${result.stderr}`,
    );
  });

  it('parses repositories from comma-separated flag', async () => {
    const result = await runNewCheck(allFlags({
      '--repositories': 'https://github.com/org/repo1,https://github.com/org/repo2',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    const entry = registry.checks[0];
    assert.deepEqual(entry.repositories, [
      'https://github.com/org/repo1',
      'https://github.com/org/repo2',
    ]);
  });

  it('rejects invalid severity value', async () => {
    const result = await runNewCheck(allFlags({ '--severity': 'extreme' }));

    assert.notEqual(result.exitCode, 0, 'Should have failed for invalid severity');
    assert.ok(
      result.stderr.includes('Invalid severity'),
      `Expected severity error, got: ${result.stderr}`,
    );
  });

  it('rejects invalid confidence value', async () => {
    const result = await runNewCheck(allFlags({ '--confidence': 'maybe' }));

    assert.notEqual(result.exitCode, 0, 'Should have failed for invalid confidence');
    assert.ok(
      result.stderr.includes('Invalid confidence'),
      `Expected confidence error, got: ${result.stderr}`,
    );
  });

  it('appends to existing registry without clobbering', async () => {
    // Seed registry with an existing check
    const existingRegistry = {
      checks: [{ id: 'aghast-existing', repositories: [], enabled: true }],
    };
    await writeFile(registryPath, JSON.stringify(existingRegistry, null, 2), 'utf-8');

    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks.length, 2, 'Should have 2 checks');
    assert.equal(registry.checks[0].id, 'aghast-existing');
    assert.equal(registry.checks[1].id, 'aghast-test');
  });

  // ─── Multi-target (Semgrep) tests ─────────────────────────────────────────

  it('creates checkTarget in check.json for targeted/semgrep type with explicit rules', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'rules/sql.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.deepEqual(checkDef.checkTarget, {
      type: 'targeted',
      discovery: 'semgrep',
      rules: 'rules/sql.yaml',
    });
  });

  it('creates checkTarget with array for multiple semgrep rules', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'rules/a.yaml,rules/b.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.deepEqual(checkDef.checkTarget, {
      type: 'targeted',
      discovery: 'semgrep',
      rules: ['rules/a.yaml', 'rules/b.yaml'],
    });
  });

  it('includes maxTargets in checkTarget when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'r.yaml',
      '--max-targets': '10',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.deepEqual(checkDef.checkTarget, {
      type: 'targeted',
      discovery: 'semgrep',
      rules: 'r.yaml',
      maxTargets: 10,
    });
  });

  it('generates <id>.yaml inside check folder when type is targeted/semgrep and no rules provided', async () => {
    const flags = allFlags({ '--check-type': 'targeted', '--discovery': 'semgrep', '--language': 'python' });

    const result = await runNewCheck(flags);

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify rule.yaml was created inside check folder
    const ruleFile = resolve(checksDir, 'aghast-test', 'aghast-test.yaml');
    const ruleContent = await readFile(ruleFile, 'utf-8');
    assert.ok(ruleContent.includes('id: aghast-test'), 'Rule template should contain check ID');
    assert.ok(ruleContent.includes('pattern:'), 'Rule template should contain pattern');
    assert.ok(ruleContent.includes('severity: WARNING'), 'Rule template should contain severity');
    assert.ok(ruleContent.includes('languages: [python]'), 'Rule template should use selected language');

    // Verify check.json points to rule.yaml
    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'semgrep');
    assert.equal(checkDef.checkTarget.rules, 'aghast-test.yaml');

    // Verify stdout mentions the created template
    assert.ok(
      result.stdout.includes('aghast-test.yaml'),
      `Should mention aghast-test.yaml creation, got: ${result.stdout}`,
    );
  });

  it('does not include checkTarget for default repository type', async () => {
    const result = await runNewCheck(allFlags());

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget, undefined, 'checkTarget should not be present for repository type');
  });

  it('does not include checkTarget for explicit repository type', async () => {
    const result = await runNewCheck(allFlags({ '--check-type': 'repository' }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget, undefined, 'checkTarget should not be present for repository type');
  });

  it('rejects invalid check type', async () => {
    const result = await runNewCheck(allFlags({ '--check-type': 'invalid' }));

    assert.notEqual(result.exitCode, 0, 'Should have failed for invalid check type');
    assert.ok(
      result.stderr.includes('Invalid check type'),
      `Expected check type error, got: ${result.stderr}`,
    );
  });

  it('rejects invalid maxTargets', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'r.yaml',
      '--max-targets': 'abc',
    }));

    assert.notEqual(result.exitCode, 0, 'Should have failed for invalid maxTargets');
    assert.ok(
      result.stderr.includes('Invalid maxTargets'),
      `Expected maxTargets error, got: ${result.stderr}`,
    );
  });

  // ─── Semgrep test file scaffolding ────────────────────────────────────────

  it('creates Python test file inside check folder', async () => {
    const flags = allFlags({ '--check-type': 'targeted', '--discovery': 'semgrep', '--language': 'python' });
    const result = await runNewCheck(flags);

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify test file was created inside check folder
    const testFile = resolve(checksDir, 'aghast-test', 'tests', 'aghast-test.py');
    const testContent = await readFile(testFile, 'utf-8');
    assert.ok(testContent.includes('# ruleid: aghast-test'), 'Test file should contain ruleid marker');
    assert.ok(testContent.includes('# ok: aghast-test'), 'Test file should contain ok marker');

    // Verify stdout mentions the test file
    assert.ok(
      result.stdout.includes('aghast-test.py'),
      `Should mention test file creation, got: ${result.stdout}`,
    );
  });

  it('creates JavaScript test file inside check folder', async () => {
    const flags = allFlags({ '--check-type': 'targeted', '--discovery': 'semgrep', '--language': 'js' });
    const result = await runNewCheck(flags);

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify test file was created with JS comment syntax
    const testFile = resolve(checksDir, 'aghast-test', 'tests', 'aghast-test.js');
    const testContent = await readFile(testFile, 'utf-8');
    assert.ok(testContent.includes('// ruleid: aghast-test'), 'Test file should contain JS-style ruleid marker');
    assert.ok(testContent.includes('// ok: aghast-test'), 'Test file should contain JS-style ok marker');

    // Verify the rule template uses javascript language
    const ruleFile = resolve(checksDir, 'aghast-test', 'aghast-test.yaml');
    const ruleContent = await readFile(ruleFile, 'utf-8');
    assert.ok(ruleContent.includes('languages: [javascript]'), 'Rule should use javascript language');
  });

  it('rejects invalid language value', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--language': 'ruby',
    }));

    assert.notEqual(result.exitCode, 0, 'Should have failed for invalid language');
    assert.ok(
      result.stderr.includes('Invalid language'),
      `Expected language error, got: ${result.stderr}`,
    );
  });

  it('does not create <id>.yaml/test files when --semgrep-rules is provided', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'rules/existing.yaml',
      '--language': 'python',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // No rule.yaml should exist inside check folder
    const checkFolder = resolve(checksDir, 'aghast-test');
    try {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(checkFolder);
      assert.ok(!files.includes('aghast-test.yaml'), 'No aghast-test.yaml should be created when --semgrep-rules is provided');
    } catch {
      // Folder doesn't exist — unexpected but ok
    }
  });

  it('accepts language aliases (py for python)', async () => {
    const flags = allFlags({ '--check-type': 'targeted', '--discovery': 'semgrep', '--language': 'py' });
    const result = await runNewCheck(flags);

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify rule uses python (canonical semgrep name)
    const ruleFile = resolve(checksDir, 'aghast-test', 'aghast-test.yaml');
    const ruleContent = await readFile(ruleFile, 'utf-8');
    assert.ok(ruleContent.includes('languages: [python]'), 'py alias should resolve to python');

    // Verify test file has .py extension
    const testFile = resolve(checksDir, 'aghast-test', 'tests', 'aghast-test.py');
    const testContent = await readFile(testFile, 'utf-8');
    assert.ok(testContent.includes('# ruleid: aghast-test'), 'Test file should use Python comment syntax');
  });

  // ─── Opengrep discovery (parallel to semgrep) ────────────────────────────

  it('creates checkTarget in check.json for targeted/opengrep type with explicit rules', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'opengrep',
      '--semgrep-rules': 'rules/sql.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.deepEqual(checkDef.checkTarget, {
      type: 'targeted',
      discovery: 'opengrep',
      rules: 'rules/sql.yaml',
    });
  });

  it('generates <id>.yaml inside check folder when type is targeted/opengrep and no rules provided', async () => {
    const flags = allFlags({ '--check-type': 'targeted', '--discovery': 'opengrep', '--language': 'python' });

    const result = await runNewCheck(flags);

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Rule template is generated with identical format — opengrep and semgrep share rule syntax.
    const ruleFile = resolve(checksDir, 'aghast-test', 'aghast-test.yaml');
    const ruleContent = await readFile(ruleFile, 'utf-8');
    assert.ok(ruleContent.includes('id: aghast-test'));
    assert.ok(ruleContent.includes('languages: [python]'));

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'opengrep');
    assert.equal(checkDef.checkTarget.rules, 'aghast-test.yaml');
  });

  it('static/opengrep creates checkTarget with no instructionsFile', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'static',
      '--discovery': 'opengrep',
      '--semgrep-rules': 'rules/detect.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'static');
    assert.equal(checkDef.checkTarget.discovery, 'opengrep');
    assert.equal(checkDef.checkTarget.rules, 'rules/detect.yaml');
    assert.equal(checkDef.instructionsFile, undefined);
  });

  it('rejects when both --semgrep-rules and --opengrep-rules are passed', async () => {
    const result = await runNewCheck([
      '--config-dir', configDir,
      '--id', 'aghast-test',
      '--name', 'Test',
      '--check-type', 'targeted',
      '--discovery', 'opengrep',
      '--semgrep-rules', 'rules/a.yaml',
      '--opengrep-rules', 'rules/b.yaml',
    ]);

    assert.notEqual(result.exitCode, 0, 'Expected non-zero exit when both rules flags are passed');
    assert.ok(
      result.stderr.includes('--semgrep-rules and --opengrep-rules'),
      `Expected stderr to mention the conflict, got: ${result.stderr}`,
    );
  });

  // ─── Interactive retry tests ──────────────────────────────────────────────

  it('retries up to 3 times for required fields before exiting', async () => {
    // Supply no flags — the first prompt is Check ID, send 3 empty lines
    const result = await runNewCheckInteractive(
      ['--config-dir', configDir],
      ['', '', ''],
    );

    assert.notEqual(result.exitCode, 0, 'Should exit with error after 3 empty attempts');
    assert.ok(
      result.stderr.includes('no valid input after 3 attempts'),
      `Expected final retry error, got: ${result.stderr}`,
    );
  });

  it('shows remaining attempts on each empty input for required fields', async () => {
    const result = await runNewCheckInteractive(
      ['--config-dir', configDir],
      ['', '', ''],
    );

    assert.ok(
      result.stderr.includes('2 attempts remaining'),
      `Expected '2 attempts remaining', got: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes('1 attempt remaining'),
      `Expected '1 attempt remaining', got: ${result.stderr}`,
    );
  });

  it('accepts a value after initial empty attempts for required fields', async () => {
    // First prompt: Check ID — give 2 empty then valid value
    // Then answer all remaining required prompts
    const result = await runNewCheckInteractive(
      ['--config-dir', configDir],
      [
        '',                     // Check ID — empty (attempt 1)
        '',                     // Check ID — empty (attempt 2)
        'aghast-retry-test',    // Check ID — valid (attempt 3)
        'Retry Test Check',     // Check name
        'repository',            // Check type (explicit repository)
        '',                     // Severity (default: high)
        '',                     // Confidence (default: medium)
        '',                     // Model (optional, skip)
        '',                     // Repositories (optional, skip)
        '',                     // Priority (optional, skip)
        '',                     // Add repository match criteria? (y/N — skip)
        'Overview text',        // Check overview
        'Item A,Item B',        // Check items
        'All good',             // PASS condition
        'Something bad',        // FAIL condition
        '',                     // FLAG condition (optional, skip)
      ],
    );

    assert.equal(result.exitCode, 0, `CLI should succeed after retries: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('1 attempt remaining'),
      `Should have shown retry warnings: ${result.stderr}`,
    );

    // Verify the check was actually created
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks.length, 1);
    assert.equal(registry.checks[0].id, 'aghast-retry-test');
  });

  // ─── Static checks (formerly semgrep-only) ──────────────────────────────

  it('static type creates correct checkTarget with no instructionsFile', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'static',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'rules/detect.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'static');
    assert.equal(checkDef.checkTarget.discovery, 'semgrep');
    assert.equal(checkDef.checkTarget.rules, 'rules/detect.yaml');
    assert.equal(checkDef.instructionsFile, undefined, 'static should not have instructionsFile');
  });

  it('static does not generate .md file', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'static',
      '--discovery': 'semgrep',
      '--semgrep-rules': 'rules/detect.yaml',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // No .md should exist
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'static should not generate .md file');
    assert.ok(files.includes('aghast-test.json'), 'Should still have .json');
  });

  it('static with generated rule template creates .yaml + test file', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'static',
      '--discovery': 'semgrep',
      '--language': 'python',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    // Verify rule.yaml was created
    const ruleFile = resolve(checksDir, 'aghast-test', 'aghast-test.yaml');
    const ruleContent = await readFile(ruleFile, 'utf-8');
    assert.ok(ruleContent.includes('id: aghast-test'), 'Rule template should contain check ID');
    assert.ok(ruleContent.includes('languages: [python]'));

    // Verify test file was created
    const testFile = resolve(checksDir, 'aghast-test', 'tests', 'aghast-test.py');
    const testContent = await readFile(testFile, 'utf-8');
    assert.ok(testContent.includes('# ruleid: aghast-test'));

    // Verify no .md file
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'static should not generate .md file');

    // Verify check.json has correct structure
    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'static');
    assert.equal(checkDef.checkTarget.discovery, 'semgrep');
    assert.equal(checkDef.checkTarget.rules, 'aghast-test.yaml');
    assert.equal(checkDef.instructionsFile, undefined);
  });

  // ─── Targeted sarif checks (requires instructions like other targeted checks) ─

  it('targeted sarif creates correct checkTarget with instructionsFile', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'sarif',
      '--sarif-file': './sast-results.sarif',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'sarif');
    assert.equal(checkDef.instructionsFile, 'aghast-test.md', 'sarif discovery requires instructionsFile');
    assert.equal(checkDef.checkTarget.rules, undefined, 'sarif should not have rules');
  });

  it('targeted sarif generates .md file', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'sarif',
      '--sarif-file': './sast-results.sarif',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(files.includes('aghast-test.md'), 'sarif should generate .md file');
    assert.ok(files.includes('aghast-test.json'), 'Should still have .json');
  });

  it('targeted sarif with false-positive-validation skips instructionsFile and .md', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'sarif',
      '--sarif-file': './sast-results.sarif',
      '--analysis-mode': 'false-positive-validation',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.analysisMode, 'false-positive-validation');
    assert.equal(checkDef.instructionsFile, undefined, 'built-in mode does not need instructionsFile');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'built-in mode should not generate .md file');
  });

  // ─── Targeted openant checks with built-in analysis mode ─

  it('targeted openant with general-vuln-discovery creates checkTarget without instructionsFile', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'openant',
      '--analysis-mode': 'general-vuln-discovery',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'openant');
    assert.equal(checkDef.checkTarget.analysisMode, 'general-vuln-discovery');
    assert.equal(checkDef.instructionsFile, undefined, 'built-in analysis mode does not need instructionsFile');
    assert.equal(checkDef.checkTarget.rules, undefined, 'openant should not have rules');
  });

  it('targeted openant with general-vuln-discovery does not generate .md file', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'openant',
      '--analysis-mode': 'general-vuln-discovery',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'built-in analysis mode should not generate .md file');
    assert.ok(files.includes('aghast-test.json'), 'Should still have .json');
  });

  it('targeted openant with custom mode generates instructionsFile and .md', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'openant',
      '--analysis-mode': 'custom',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.instructionsFile, 'aghast-test.md', 'custom mode requires instructionsFile');
    assert.equal(checkDef.checkTarget.analysisMode, undefined, 'custom mode should not set analysisMode');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(files.includes('aghast-test.md'), 'custom mode should generate .md file');
  });

  it('targeted openant includes maxTargets in checkTarget when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'openant',
      '--max-targets': '25',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'openant');
    assert.equal(checkDef.checkTarget.maxTargets, 25);
  });

  // ─── Targeted glob checks (Spec E.2.1) ─

  it('targeted glob creates correct checkTarget with instructionsFile', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'glob',
      '--glob': 'src/routes/**/*.ts',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'glob');
    assert.equal(checkDef.checkTarget.glob, 'src/routes/**/*.ts');
    assert.equal(checkDef.instructionsFile, 'aghast-test.md', 'glob discovery requires instructionsFile by default');
    assert.equal(checkDef.checkTarget.rules, undefined, 'glob should not have rules');
    assert.equal(checkDef.checkTarget.sarifFile, undefined, 'glob should not have sarifFile');
  });

  it('targeted glob generates .md file', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'glob',
      '--glob': 'src/**/*.ts',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(files.includes('aghast-test.md'), 'glob should generate .md file');
    assert.ok(files.includes('aghast-test.json'), 'Should still have .json');
    assert.ok(!files.includes('aghast-test.yaml'), 'glob should not generate Semgrep yaml');
  });

  it('targeted glob with general-vuln-discovery skips instructionsFile and .md', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'glob',
      '--glob': 'src/**/*.ts',
      '--analysis-mode': 'general-vuln-discovery',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.analysisMode, 'general-vuln-discovery');
    assert.equal(checkDef.instructionsFile, undefined, 'built-in mode does not need instructionsFile');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'built-in mode should not generate .md file');
  });

  it('targeted glob rejects false-positive-validation analysis mode', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'glob',
      '--glob': 'src/**/*.ts',
      '--analysis-mode': 'false-positive-validation',
    }));

    assert.notEqual(result.exitCode, 0, 'Should reject false-positive-validation for glob discovery');
    assert.ok(
      result.stderr.includes('Invalid analysis mode'),
      `Expected analysis mode error, got: ${result.stderr}`,
    );
  });

  it('targeted glob includes maxTargets in checkTarget when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'glob',
      '--glob': 'src/**/*.ts',
      '--max-targets': '40',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.discovery, 'glob');
    assert.equal(checkDef.checkTarget.maxTargets, 40);
  });

  // ─── Targeted script checks (issue #350) ─

  it('targeted script (node/json-array) creates checkTarget and generates starter script', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'json-array',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.type, 'targeted');
    assert.equal(checkDef.checkTarget.discovery, 'script');
    assert.equal(checkDef.checkTarget.scriptType, 'node');
    assert.equal(checkDef.checkTarget.outputFormat, 'json-array');
    assert.equal(checkDef.checkTarget.script, 'aghast-test.js', 'script defaults to <id>.js');
    assert.equal(checkDef.instructionsFile, 'aghast-test.md', 'script discovery requires instructionsFile by default');
    assert.equal(checkDef.checkTarget.rules, undefined, 'script should not have rules');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(files.includes('aghast-test.js'), 'should generate starter script');
    assert.ok(files.includes('aghast-test.md'), 'should generate instructions .md');
    assert.ok(!files.includes('aghast-test.yaml'), 'script should not generate Semgrep yaml');

    // The generated node script runs and emits an empty json-array.
    const scriptOut = await new Promise<string>((res) => {
      execFile(process.execPath, [resolve(checksDir, 'aghast-test', 'aghast-test.js')], (_e, stdout) => res(stdout));
    });
    assert.equal(scriptOut.trim(), '[]', 'starter json-array script should print []');
  });

  it('targeted script (node/lines) starter script emits repo-relative paths, one per line', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'lines',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const scriptPath = resolve(checksDir, 'aghast-test', 'aghast-test.js');
    const scriptOut = await new Promise<string>((res) => {
      execFile(process.execPath, [scriptPath], (_e, stdout) => res(stdout));
    });
    assert.equal(scriptOut.trim(), '', 'starter lines script should print nothing for the empty starter file list');

    const content = await readFile(scriptPath, 'utf-8');
    assert.match(content, /files\.join\('\\n'\)/, 'lines template should join the file list with newlines');
  });

  it('targeted script (node/json-object) starter script emits an empty targets object', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'json-object',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const scriptPath = resolve(checksDir, 'aghast-test', 'aghast-test.js');
    const scriptOut = await new Promise<string>((res) => {
      execFile(process.execPath, [scriptPath], (_e, stdout) => res(stdout));
    });
    assert.equal(scriptOut.trim(), '{"targets":[]}', 'starter json-object script should print { targets: [] }');
  });

  // bash scriptType can't be executed on Windows CI runners (E7106), so these
  // assert the generated file *content* directly instead of running it —
  // mirroring how the Semgrep-rule template tests check file contents
  // without invoking Semgrep.

  it('targeted script (bash/lines) generates a starter script with the lines output contract', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'bash',
      '--output-format': 'lines',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.script, 'aghast-test.sh', 'bash script defaults to <id>.sh');

    const content = await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.sh'), 'utf-8');
    assert.match(content, /^#!\/usr\/bin\/env bash/, 'bash script should have a bash shebang');
    assert.match(content, /set -euo pipefail/, 'bash script should fail fast on errors');
    assert.match(content, /one repo-relative file path per line/, 'lines template should describe the lines contract');
  });

  it('targeted script (bash/json-array) generates a starter script that echoes an empty array', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'bash',
      '--output-format': 'json-array',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const content = await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.sh'), 'utf-8');
    assert.match(content, /echo '\[\]'/, 'json-array bash template should echo an empty array');
  });

  it('targeted script (bash/json-object) generates a starter script that echoes an empty targets object', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'bash',
      '--output-format': 'json-object',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const content = await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.sh'), 'utf-8');
    assert.match(content, /echo '\{ "targets": \[\] \}'/, 'json-object bash template should echo an empty targets object');
  });

  it('warns when scaffolding a bash script check on Windows, since it will fail at scan time (E7106)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only warning; not applicable on this platform');
      return;
    }
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'bash',
      '--output-format': 'json-array',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('bash') && result.stderr.includes('Windows') && result.stderr.includes('E7106'),
      `Expected a bash-on-Windows warning referencing E7106, got: ${result.stderr}`,
    );
  });

  it('targeted script with general-vuln-discovery skips instructionsFile and .md', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'json-array',
      '--analysis-mode': 'general-vuln-discovery',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.analysisMode, 'general-vuln-discovery');
    assert.equal(checkDef.instructionsFile, undefined, 'built-in mode does not need instructionsFile');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.md'), 'built-in mode should not generate .md file');
    assert.ok(files.includes('aghast-test.js'), 'should still generate starter script');
  });

  it('targeted script with explicit --script does not generate a starter script', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'lines',
      '--script': 'find-targets.js',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.script, 'find-targets.js', 'should use the supplied script path');

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(checksDir, 'aghast-test'));
    assert.ok(!files.includes('aghast-test.js'), 'should not generate a template when --script is supplied');
  });

  it('targeted script includes cwd and timeoutMs when provided', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'json-object',
      '--cwd': 'server',
      '--timeout-ms': '60000',
    }));

    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const checkDef = JSON.parse(await readFile(resolve(checksDir, 'aghast-test', 'aghast-test.json'), 'utf-8'));
    assert.equal(checkDef.checkTarget.outputFormat, 'json-object');
    assert.equal(checkDef.checkTarget.cwd, 'server');
    assert.equal(checkDef.checkTarget.timeoutMs, 60000);
  });

  it('targeted script rejects false-positive-validation analysis mode', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'json-array',
      '--analysis-mode': 'false-positive-validation',
    }));

    assert.notEqual(result.exitCode, 0, 'Should reject false-positive-validation for script discovery');
    assert.ok(
      result.stderr.includes('Invalid analysis mode'),
      `Expected analysis mode error, got: ${result.stderr}`,
    );
  });

  it('targeted script rejects an invalid output format', async () => {
    const result = await runNewCheck(allFlags({
      '--check-type': 'targeted',
      '--discovery': 'script',
      '--script-type': 'node',
      '--output-format': 'yaml',
    }));

    assert.notEqual(result.exitCode, 0, 'Should reject an unknown output format');
    assert.ok(
      result.stderr.includes('Invalid outputFormat'),
      `Expected outputFormat error, got: ${result.stderr}`,
    );
  });

  // ─── priority / matchCriteria (registry-level, issue #350) ─

  it('writes priority into the registry entry', async () => {
    const result = await runNewCheck(allFlags({ '--priority': '5' }));
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    const entry = registry.checks.find((c: { id: string }) => c.id === 'aghast-test');
    assert.equal(entry.priority, 5);
  });

  it('rejects a negative priority', async () => {
    const result = await runNewCheck(allFlags({ '--priority': '-1' }));
    assert.notEqual(result.exitCode, 0, 'Should reject a negative priority');
    assert.ok(result.stderr.includes('Invalid priority'), `Expected priority error, got: ${result.stderr}`);
  });

  it('rejects a non-integer priority', async () => {
    const result = await runNewCheck(allFlags({ '--priority': 'abc' }));
    assert.notEqual(result.exitCode, 0, 'Should reject a non-integer priority');
    assert.ok(result.stderr.includes('Invalid priority'), `Expected priority error, got: ${result.stderr}`);
  });

  it('writes matchCriteria with only the provided sub-fields', async () => {
    const result = await runNewCheck(allFlags({
      '--match-file-types': '.ts,.tsx',
      '--match-tags': 'backend,api',
    }));
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    const entry = registry.checks.find((c: { id: string }) => c.id === 'aghast-test');
    assert.deepEqual(entry.matchCriteria.hasFileTypes, ['.ts', '.tsx']);
    assert.deepEqual(entry.matchCriteria.tags, ['backend', 'api']);
    assert.equal(entry.matchCriteria.hasPaths, undefined, 'absent sub-fields are omitted');
    assert.equal(entry.matchCriteria.hasFiles, undefined, 'absent sub-fields are omitted');
  });

  it('rejects a blank/comma-only --match-file-types value instead of scaffolding an empty matchCriteria array', async () => {
    const result = await runNewCheck(allFlags({
      '--match-file-types': ' , ',
    }));
    assert.notEqual(result.exitCode, 0, 'Should reject a match-file-types value with no usable entries after parsing');
    assert.ok(
      result.stderr.includes('--match-file-types') && result.stderr.includes('no usable values'),
      `Expected a match-file-types parsing error, got: ${result.stderr}`,
    );

    // The registry must be left untouched — no bad entry written that would
    // later crash loadCheckRegistry for the entire config directory.
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    assert.equal(registry.checks.length, 0, 'no registry entry should be written when validation fails');
  });

  it('rejects a comma-only --match-paths / --match-tags value the same way', async () => {
    const result = await runNewCheck(allFlags({
      '--match-paths': ',,',
      '--match-tags': ' ',
    }));
    assert.notEqual(result.exitCode, 0, 'Should reject match-paths/match-tags values with no usable entries');
    assert.ok(result.stderr.includes('--match-paths'), `Expected a match-paths error, got: ${result.stderr}`);
    assert.ok(result.stderr.includes('--match-tags'), `Expected a match-tags error, got: ${result.stderr}`);
  });

  it('preserves brace-expansion glob patterns in --match-paths instead of splitting on the internal comma', async () => {
    const result = await runNewCheck(allFlags({
      '--match-paths': 'src/**/*.{ts,tsx},docs/**/*.md',
    }));
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    const entry = registry.checks.find((c: { id: string }) => c.id === 'aghast-test');
    assert.deepEqual(
      entry.matchCriteria.hasPaths,
      ['src/**/*.{ts,tsx}', 'docs/**/*.md'],
      'the brace-expansion pattern should survive as one entry, not be torn apart at the internal comma',
    );
  });

  it('omits matchCriteria and priority when not provided', async () => {
    const result = await runNewCheck(allFlags());
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    const entry = registry.checks.find((c: { id: string }) => c.id === 'aghast-test');
    assert.equal(entry.matchCriteria, undefined, 'no matchCriteria key when unset');
    assert.equal(entry.priority, undefined, 'no priority key when unset');
  });
});
