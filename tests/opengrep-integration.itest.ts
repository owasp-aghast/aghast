/**
 * Real Opengrep integration tests.
 * These tests actually invoke the `opengrep` binary.
 * Skip by setting AGHAST_SKIP_OPENGREP_TESTS=true.
 *
 * Reuses the Semgrep fixture codebase and rules — rule syntax and SARIF output
 * are identical between the two tools.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlink, writeFile } from 'node:fs/promises';
import { runOpengrep } from '../src/opengrep-runner.js';
import { parseSARIF } from '../src/sarif-parser.js';
import { runMultiScan } from '../src/scan-runner.js';
import { MockAgentProvider } from './mocks/mock-agent-provider.js';
import type { SecurityCheck, CheckDetails } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testCodebase = resolve(__dirname, 'fixtures', 'semgrep-target');
const sqlConcatRule = resolve(__dirname, 'fixtures', 'semgrep-rules', 'sql-concat.yaml');
const fixtureRepo = resolve(__dirname, 'fixtures', 'git-repo');
const outputFile = resolve(fixtureRepo, 'security_checks_results.json');
const skip = !!process.env.AGHAST_SKIP_OPENGREP_TESTS;

// Opengrep inherits Semgrep's default ignore list which skips tests/ directories.
// Since the fixture codebase lives under tests/fixtures/, create an empty
// .semgrepignore at the repo root to override those defaults during integration tests.
const repoRoot = resolve(__dirname, '..');
const semgrepIgnorePath = join(repoRoot, '.semgrepignore');

describe('Opengrep integration tests', { skip }, () => {
  before(async () => {
    await writeFile(semgrepIgnorePath, '');
  });

  after(async () => {
    try { await unlink(semgrepIgnorePath); } catch { /* may not exist */ }
  });

  describe('runOpengrep', () => {
    it('executes against test codebase and returns valid SARIF', async () => {
      const origMock = process.env.AGHAST_MOCK_SARIF;
      delete process.env.AGHAST_MOCK_SARIF;

      try {
        const sarifContent = await runOpengrep({
          repositoryPath: testCodebase,
          rules: sqlConcatRule,
        });

        const parsed = JSON.parse(sarifContent);
        assert.equal(parsed.version, '2.1.0');
        assert.ok(parsed.runs, 'SARIF should have runs');
        assert.ok(Array.isArray(parsed.runs[0].results), 'SARIF should have results array');
      } finally {
        if (origMock !== undefined) {
          process.env.AGHAST_MOCK_SARIF = origMock;
        }
      }
    });
  });

  describe('parsed targets', () => {
    it('parsed SARIF contains targets pointing to test codebase files', async () => {
      const origMock = process.env.AGHAST_MOCK_SARIF;
      delete process.env.AGHAST_MOCK_SARIF;

      try {
        const sarifContent = await runOpengrep({
          repositoryPath: testCodebase,
          rules: sqlConcatRule,
        });

        const targets = parseSARIF(sarifContent);
        assert.ok(targets.length >= 1, `Expected at least 1 target, got ${targets.length}`);

        for (const target of targets) {
          assert.ok(target.file, 'Target should have a file path');
          assert.ok(target.startLine > 0, 'Target should have startLine > 0');
          assert.ok(target.endLine >= target.startLine, 'endLine should be >= startLine');
        }
      } finally {
        if (origMock !== undefined) {
          process.env.AGHAST_MOCK_SARIF = origMock;
        }
      }
    });
  });

  describe('full pipeline', () => {
    afterEach(async () => {
      try { await unlink(outputFile); } catch { /* may not exist */ }
    });

    it('config with opengrep check + real opengrep + mock AI → results with targetsAnalyzed > 0', async () => {
      const origMock = process.env.AGHAST_MOCK_SARIF;
      delete process.env.AGHAST_MOCK_SARIF;

      try {
        const provider = new MockAgentProvider({ response: { issues: [] } });

        const check: SecurityCheck = {
          id: 'integ-sqli-opengrep',
          name: 'Integration SQL Check (Opengrep)',
          repositories: [],
          instructionsFile: 'unused.md',
          checkTarget: {
            type: 'targeted',
            discovery: 'opengrep',
            rules: sqlConcatRule,
          },
        };

        const details: CheckDetails = {
          id: 'integ-sqli-opengrep',
          name: 'Integration SQL Check (Opengrep)',
          overview: 'Integration test check.',
          content: '### Integration SQL Check\n\n#### Overview\nTest.\n',
        };

        const results = await runMultiScan({
          repositoryPath: testCodebase,
          checks: [{ check, details }],
          agentProvider: provider,
        });

        assert.equal(results.checks.length, 1);
        assert.ok(
          (results.checks[0].targetsAnalyzed ?? 0) > 0,
          `Expected targetsAnalyzed > 0, got ${results.checks[0].targetsAnalyzed}`,
        );
        assert.equal(results.checks[0].status, 'PASS');
      } finally {
        if (origMock !== undefined) {
          process.env.AGHAST_MOCK_SARIF = origMock;
        }
      }
    });
  });

  describe('error handling', () => {
    it('invalid rule file → error from Opengrep execution', async () => {
      const origMock = process.env.AGHAST_MOCK_SARIF;
      delete process.env.AGHAST_MOCK_SARIF;

      try {
        await assert.rejects(
          () => runOpengrep({
            repositoryPath: testCodebase,
            rules: '/nonexistent/rule.yaml',
          }),
          /Opengrep execution failed/,
        );
      } finally {
        if (origMock !== undefined) {
          process.env.AGHAST_MOCK_SARIF = origMock;
        }
      }
    });
  });
});
