import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeResults, regressionResult, verdict } from './live-opencode-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, attemptsText, codebase] = process.argv.slice(2);
const attempts = Number(attemptsText);
if (!['integration', 'regression', 'regression-attempt'].includes(mode) || !Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
  throw new Error('Usage: live-opencode-ci.mjs integration|regression ATTEMPTS [CODEBASE]');
}
if (mode !== 'integration' && !codebase) throw new Error('Regression mode requires a codebase');

// Run the external checks repository's exported comparison API, avoiding log
// scraping and keeping all expected-status/count/location assertions intact.
if (mode === 'regression-attempt') {
  const configDir = join(root, 'checks-config-public');
  const { parseConfig, runRegressionTest } = await import(pathToFileURL(join(configDir, 'scripts/regression-test.ts')).href);
  const config = parseConfig(['node', 'regression-test', '--codebase', codebase, '--agent-provider', 'opencode', '--model', process.env.REGRESSION_TEST_MODEL ?? 'opencode/big-pickle'], configDir);
  const { results } = await runRegressionTest(config);
  appendFileSync(process.env.AGHAST_LIVE_TEST_REPORT, `${JSON.stringify({ results: results.map(regressionResult), complete: true })}\n`);
  process.exit(0);
}

function run(args, report, timeoutMs) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, AGHAST_LIVE_TEST_REPORT: report },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolveRun({ error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut }); });
  });
}

const directory = mkdtempSync(join(tmpdir(), 'aghast-live-ci-'));
let accumulated = new Map();
try {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`\nLive OpenCode ${mode}: attempt ${attempt}/${attempts}`);
    const report = join(directory, `${attempt}.jsonl`);
    const args = mode === 'integration'
      ? ['--import', 'tsx', '--test', '--test-force-exit', `--test-reporter=${pathToFileURL(join(root, '.github/scripts/opencode-test-reporter.mjs')).href}`, join(root, 'tests/opencode-integration.itest.ts')]
      : ['--import', 'tsx', fileURLToPath(import.meta.url), 'regression-attempt', '1', codebase];
    const execution = await run(args, report, mode === 'integration' ? 150_000 : 240_000);
    let records = [];
    try {
      records = readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch { /* Missing or malformed reports are handled below, never silently green. */ }
    const complete = records.at(-1)?.complete === true;
    const current = mode === 'integration' ? records.filter(record => record.name) : records.at(-1)?.results ?? [];
    if (execution.timedOut) {
      current.push({ name: 'incomplete run', outcome: 'unavailable', message: 'Live inference attempt timed out' });
    } else if (execution.error || execution.signal || !complete || !current.length || (mode === 'integration' && current.length !== 5)
      || (execution.code !== 0 && current.every(result => result.outcome === 'pass'))) {
      current.push({ name: 'test harness', outcome: 'error', message: execution.error?.message ?? 'Missing, incomplete, or invalid test report' });
    } else {
      // A completed retry resolves a previous timeout/harness failure, but each
      // individual assertion still has to pass to resolve its own mismatch.
      accumulated.delete('incomplete run');
      accumulated.delete('test harness');
    }
    accumulated = mergeResults(accumulated, current);
    if (complete && current.length && current.every(result => result.outcome === 'pass') && verdict(accumulated) === 'pass') break;
  }
  const outcome = verdict(accumulated);
  const details = [...accumulated.values()].map(result => `- ${result.outcome}: ${result.name}${result.message ? ` — ${result.message}` : ''}`).join('\n');
  console.log(`\nLive OpenCode ${mode}: ${outcome}\n${details}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live OpenCode ${mode}: ${outcome}\n\n${details}\n`);
  if (outcome === 'warning') console.log('::warning::Live OpenCode inference was unavailable after retries; completed assertions passed, but live coverage is incomplete. See the step summary.');
  if (outcome === 'failure') console.log('::error::Live OpenCode returned incorrect results or the test harness failed after retries. See the step summary.');
  process.exitCode = outcome === 'failure' ? 1 : 0;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
