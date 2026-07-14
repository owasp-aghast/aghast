import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpengrep } from '../src/opengrep-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, 'fixtures', 'sarif');
const fixtureRepo = resolve(__dirname, 'fixtures', 'git-repo');

describe('runOpengrep (mock mode)', () => {
  const origEnv = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origEnv;
    }
  });

  it('returns fixture file content when AGHAST_MOCK_SARIF is set', async () => {
    // Opengrep emits the same SARIF 2.1.0 format as Semgrep, so the semgrep
    // fixture is reused.
    const fixturePath = resolve(fixtureDir, 'semgrep-results.sarif');
    process.env.AGHAST_MOCK_SARIF = fixturePath;

    const result = await runOpengrep({ repositoryPath: fixtureRepo });
    const parsed = JSON.parse(result);
    assert.equal(parsed.version, '2.1.0');
    assert.equal(parsed.runs[0].results.length, 3);
  });

  it('throws when AGHAST_MOCK_SARIF points to non-existent file', async () => {
    process.env.AGHAST_MOCK_SARIF = '/does/not/exist/results.sarif';

    await assert.rejects(
      () => runOpengrep({ repositoryPath: fixtureRepo }),
      /Failed to read AGHAST_MOCK_SARIF file/,
    );
  });
});
