import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSemgrep, buildSemgrepArgs } from '../src/semgrep-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, 'fixtures', 'sarif');
const fixtureRepo = resolve(__dirname, 'fixtures', 'git-repo');

describe('buildSemgrepArgs', () => {
  it('builds args with single rule string', () => {
    const args = buildSemgrepArgs(
      { repositoryPath: '/repo', rules: 'rules/sql.yaml' },
      '/tmp/out.sarif',
    );
    assert.deepEqual(args, ['--config', 'rules/sql.yaml', '--sarif', '--output', '/tmp/out.sarif', '.']);
  });

  it('builds args with multiple rules', () => {
    const args = buildSemgrepArgs(
      { repositoryPath: '/repo', rules: ['rules/sql.yaml', 'rules/xss.yaml'] },
      '/tmp/out.sarif',
    );
    assert.deepEqual(args, [
      '--config', 'rules/sql.yaml',
      '--config', 'rules/xss.yaml',
      '--sarif', '--output', '/tmp/out.sarif', '.',
    ]);
  });

  it('builds args with config file', () => {
    const args = buildSemgrepArgs(
      { repositoryPath: '/repo', config: '.semgrep.yml' },
      '/tmp/out.sarif',
    );
    assert.deepEqual(args, ['--config', '.semgrep.yml', '--sarif', '--output', '/tmp/out.sarif', '.']);
  });

  it('config takes precedence over rules', () => {
    const args = buildSemgrepArgs(
      { repositoryPath: '/repo', rules: 'rules/sql.yaml', config: '.semgrep.yml' },
      '/tmp/out.sarif',
    );
    assert.deepEqual(args, ['--config', '.semgrep.yml', '--sarif', '--output', '/tmp/out.sarif', '.']);
  });
});

describe('runSemgrep (mock mode)', () => {
  const origEnv = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origEnv;
    }
  });

  it('returns fixture file content when AGHAST_MOCK_SARIF is set', async () => {
    const fixturePath = resolve(fixtureDir, 'semgrep-results.sarif');
    process.env.AGHAST_MOCK_SARIF = fixturePath;

    const result = await runSemgrep({ repositoryPath: fixtureRepo });
    const parsed = JSON.parse(result);
    assert.equal(parsed.version, '2.1.0');
    assert.equal(parsed.runs[0].results.length, 3);
  });

  it('throws when AGHAST_MOCK_SARIF points to non-existent file', async () => {
    process.env.AGHAST_MOCK_SARIF = '/does/not/exist/results.sarif';

    await assert.rejects(
      () => runSemgrep({ repositoryPath: fixtureRepo }),
      /Failed to read AGHAST_MOCK_SARIF file/,
    );
  });
});
