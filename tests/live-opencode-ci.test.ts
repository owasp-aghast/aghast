import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integrationResult, mergeResults, regressionResult, verdict } from '../.github/scripts/live-opencode-policy.mjs';

describe('live OpenCode CI policy', () => {
  it('warns for unavailable inference but blocks assertions and unknown errors', () => {
    assert.equal(integrationResult('quota', new Error('OpenCode session failed: Free usage limit reached')).outcome, 'unavailable');
    assert.equal(integrationResult('empty', new Error('OpenCode AI returned no text response')).outcome, 'unavailable');
    assert.equal(integrationResult('network', new Error('fetch failed')).outcome, 'unavailable');
    assert.equal(integrationResult('bug', new TypeError('Cannot read properties of undefined')).outcome, 'error');
    const assertion = new assert.AssertionError({ message: 'OpenCode session failed: quota text appeared in the wrong response' });
    assert.equal(integrationResult('wrong result', assertion).outcome, 'mismatch');
  });

  it('does not erase a completed mismatch with a later unavailable retry', () => {
    const wrong = { name: 'finding', outcome: 'mismatch' };
    const unavailable = { name: 'finding', outcome: 'unavailable' };
    assert.equal(verdict(mergeResults(mergeResults(new Map(), [wrong]), [unavailable])), 'failure');
  });

  it('retains a completed pass if a later retry of another check hits a quota', () => {
    const passed = mergeResults(new Map(), [{ name: 'a', outcome: 'pass' }]);
    assert.equal(verdict(mergeResults(passed, [{ name: 'a', outcome: 'unavailable' }])), 'pass');
  });

  it('allows a later pass to resolve the same assertion, but not another assertion', () => {
    const failed = mergeResults(new Map(), [{ name: 'a', outcome: 'mismatch' }, { name: 'b', outcome: 'unavailable' }]);
    assert.equal(verdict(mergeResults(failed, [{ name: 'b', outcome: 'pass' }])), 'failure');
    assert.equal(verdict(mergeResults(failed, [{ name: 'a', outcome: 'pass' }])), 'warning');
    assert.equal(verdict(mergeResults(failed, [{ name: 'a', outcome: 'pass' }, { name: 'b', outcome: 'pass' }])), 'pass');
  });

  it('never treats absent coverage as a pass', () => {
    assert.equal(verdict(new Map()), 'failure');
    assert.equal(verdict(mergeResults(new Map(), [{ name: 'a', outcome: 'unavailable' }])), 'warning');
  });

  const comparison = {
    codebase: 'fixture', checkId: 'check', actualStatus: 'FAIL',
    statusPass: true, countPass: true, locationResults: [{ type: 'matched' }],
  };

  it('keeps status, count, and location mismatches blocking', () => {
    assert.equal(regressionResult(comparison).outcome, 'pass');
    assert.equal(regressionResult({ ...comparison, statusPass: false }).outcome, 'mismatch');
    assert.equal(regressionResult({ ...comparison, actualStatus: 'FLAG', statusPass: false }).outcome, 'mismatch');
    assert.equal(regressionResult({ ...comparison, countPass: false }).outcome, 'mismatch');
    assert.equal(regressionResult({ ...comparison, locationResults: [{ type: 'missing' }] }).outcome, 'mismatch');
    assert.equal(regressionResult({ ...comparison, locationResults: [{ type: 'unexpected' }] }).outcome, 'mismatch');
  });

  it('warns for incomplete scan statuses but keeps harness failures blocking', () => {
    assert.equal(regressionResult({ ...comparison, actualStatus: 'ERROR' }).outcome, 'unavailable');
    assert.equal(regressionResult({ ...comparison, actualStatus: 'NOT RUN', error: 'Check missing from scan results' }).outcome, 'error');
    assert.equal(regressionResult({ ...comparison, actualStatus: 'ERROR', error: 'Codebase directory not found' }).outcome, 'error');
    assert.equal(regressionResult({ ...comparison, actualStatus: 'ERROR', error: 'Failed to parse scan output' }).outcome, 'error');
    assert.equal(regressionResult({ ...comparison, error: 'Scan timed out after 600s; killed process tree' }).outcome, 'unavailable');
  });

  it('collects actual Node test failures and completes a report even when the process exits nonzero', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aghast-ci-reporter-test-'));
    try {
      const fixture = join(directory, 'fixture.mjs');
      const report = join(directory, 'report.jsonl');
      writeFileSync(fixture, `
        import { describe, it } from 'node:test';
        import assert from 'node:assert/strict';
        describe('synthetic suite', () => {
          it('pass', () => {});
          it('quota', () => { throw new Error('OpenCode session failed: Free usage limit reached'); });
          it('wrong result', () => { assert.equal(1, 2); });
          it('bug', () => { throw new TypeError('broken harness'); });
          it('skip', { skip: true }, () => {});
        });
      `);
      const reporter = new URL('../.github/scripts/opencode-test-reporter.mjs', import.meta.url);
      const env = { ...process.env, AGHAST_LIVE_TEST_REPORT: report };
      delete env.NODE_TEST_CONTEXT;
      // This fixture owns no servers. Let its reporter drain naturally on Node
      // 20, whose forced exit can interrupt the final reporter event.
      const child = spawnSync(process.execPath, ['--test', `--test-reporter=${pathToFileURL(fileURLToPath(reporter)).href}`, fixture], {
        env, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      const records = readFileSync(report, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.at(-1), { complete: true });
      assert.deepEqual(records.slice(0, -1).map(record => [record.name, record.outcome]), [
        ['pass', 'pass'], ['quota', 'unavailable'], ['wrong result', 'mismatch'], ['bug', 'error'], ['skip', 'error'],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the regression retry wrapper against synthetic quota and mismatch sequences', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aghast-ci-wrapper-test-'));
    try {
      const scripts = join(directory, '.github/scripts');
      const checks = join(directory, 'checks-config-public/scripts');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(checks, { recursive: true });
      for (const file of ['live-opencode-ci.mjs', 'live-opencode-policy.mjs']) {
        copyFileSync(new URL(`../.github/scripts/${file}`, import.meta.url), join(scripts, file));
      }
      const require = createRequire(import.meta.url);
      const modules = dirname(dirname(require.resolve('tsx/package.json')));
      symlinkSync(modules, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(checks, 'regression-test.ts'), `
        import { readFileSync, writeFileSync } from 'node:fs';
        export function parseConfig() { return {}; }
        export async function runRegressionTest() {
          const file = process.env.AGHAST_TEST_SCENARIO;
          const outcomes = JSON.parse(readFileSync(file, 'utf8'));
          const actualStatus = outcomes.shift();
          writeFileSync(file, JSON.stringify(outcomes));
          if (actualStatus === 'crash') throw new Error('synthetic harness crash');
          return { results: [{ codebase: 'fixture', checkId: 'check', actualStatus,
            statusPass: actualStatus === 'PASS', countPass: actualStatus === 'PASS', locationResults: [] }] };
        }
      `);
      const scenario = join(directory, 'scenario.json');
      const env = { ...process.env, AGHAST_TEST_SCENARIO: scenario };
      delete env.NODE_TEST_CONTEXT;
      delete env.GITHUB_STEP_SUMMARY;
      for (const [outcomes, status, annotation] of [
        [['ERROR', 'ERROR'], 0, '::warning::'],
        [['FAIL', 'ERROR'], 1, '::error::'],
        [['FAIL', 'PASS'], 0, 'regression: pass'],
        [['ERROR', 'PASS'], 0, 'regression: pass'],
        [['crash', 'crash'], 1, '::error::'],
      ] as const) {
        writeFileSync(scenario, JSON.stringify(outcomes));
        const child = spawnSync(process.execPath, ['--import', 'tsx', join(scripts, 'live-opencode-ci.mjs'), 'regression', '2', 'fixture'], {
          cwd: directory, env, encoding: 'utf8', timeout: 15_000,
        });
        assert.equal(child.status, status, child.stdout + child.stderr);
        assert.ok(child.stdout.includes(annotation), child.stdout + child.stderr);
        if (annotation === 'regression: pass') assert.ok(!child.stdout.includes('::warning::'), child.stdout);
        assert.deepEqual(JSON.parse(readFileSync(scenario, 'utf8')), [], 'Both retry outcomes should be exercised');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
