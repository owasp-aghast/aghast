/**
 * Unit tests for runtime config loading (src/runtime-config.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from '../src/runtime-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('loadRuntimeConfig: valid config file', async () => {
  const validDir = resolve(__dirname, 'fixtures', 'runtime-config', 'valid-dir');
  const config = await loadRuntimeConfig(validDir);
  assert.equal(config.agentProvider?.name, 'claude-code');
  assert.equal(config.agentProvider?.model, 'claude-opus-4-6');
});

test('loadRuntimeConfig: file absent returns empty object', async () => {
  const absentDir = resolve(__dirname, 'fixtures', 'runtime-config', 'nonexistent-dir');
  const config = await loadRuntimeConfig(absentDir);
  assert.deepEqual(config, {});
});

test('loadRuntimeConfig: malformed JSON throws error', async () => {
  const malformedDir = resolve(__dirname, 'fixtures', 'runtime-config', 'malformed-dir');
  await assert.rejects(
    async () => {
      await loadRuntimeConfig(malformedDir);
    },
    (err: unknown) => {
      const error = err as Error;
      return error.message.includes('Invalid JSON in runtime config file');
    },
  );
});

test('loadRuntimeConfig: explicitPath parameter overrides default', async () => {
  const validPath = resolve(__dirname, 'fixtures', 'runtime-config', 'valid.json');
  const config = await loadRuntimeConfig('/unused', validPath);
  assert.equal(config.agentProvider?.name, 'claude-code');
});

test('loadRuntimeConfig: rejects agentProvider as a non-object', async () => {
  const badTypesPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-types.json');
  await assert.rejects(
    async () => {
      await loadRuntimeConfig('/unused', badTypesPath);
    },
    (err: unknown) => {
      const error = err as Error;
      return error.message.includes('"agentProvider" must be an object');
    },
  );
});

test('loadRuntimeConfig: rejects legacy aiProvider key with rename hint', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmpPath = join(tmpdir(), `legacy-ai-provider-${process.pid}-${Date.now()}.json`);
  await writeFileSync(
    tmpPath,
    JSON.stringify({ aiProvider: { name: 'claude-code', model: 'haiku' } }),
    'utf-8',
  );
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return (
          error.message.includes('"aiProvider" has been renamed to "agentProvider"') &&
          error.message.includes('0.5.0')
        );
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects failOnCheckFailure as a non-boolean', async () => {
  const badTypesDir = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-types-dir');
  await assert.rejects(
    async () => {
      await loadRuntimeConfig(badTypesDir);
    },
    (err: unknown) => {
      const error = err as Error;
      return error.message.includes('"failOnCheckFailure" must be a boolean');
    },
  );
});

test('loadRuntimeConfig: valid logging config', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'valid-logging.json');
  await writeFileSync(tmpPath, JSON.stringify({
    logging: { logFile: '/tmp/scan.log', logType: 'file', level: 'debug' },
  }), 'utf-8');
  try {
    const config = await loadRuntimeConfig('/unused', tmpPath);
    assert.equal(config.logging?.logFile, '/tmp/scan.log');
    assert.equal(config.logging?.logType, 'file');
    assert.equal(config.logging?.level, 'debug');
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects logging as non-object', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-logging.json');
  await writeFileSync(tmpPath, JSON.stringify({ logging: 'not-an-object' }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"logging" must be an object');
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects logging.logFile as non-string', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-logging-file.json');
  await writeFileSync(tmpPath, JSON.stringify({ logging: { logFile: 123 } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"logging.logFile" must be a string');
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects logging.logType as non-string', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-logging-type.json');
  await writeFileSync(tmpPath, JSON.stringify({ logging: { logType: true } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"logging.logType" must be a string');
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects logging.level as non-string', async () => {
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-logging-level.json');
  await writeFileSync(tmpPath, JSON.stringify({ logging: { level: 42 } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"logging.level" must be a string');
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

test('loadRuntimeConfig: rejects budget.perPeriod without window', async () => {
  // F4: perPeriod with only maxCostUsd is silently ignored at runtime — reject.
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-period-no-window.json');
  await writeFile(tmpPath, JSON.stringify({ budget: { perPeriod: { maxCostUsd: 5 } } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"budget.perPeriod.window" is required');
      },
    );
  } finally {
    await unlink(tmpPath);
  }
});

test('loadRuntimeConfig: rejects budget.perPeriod without maxCostUsd', async () => {
  // F4: perPeriod with only window is functionally inert — reject.
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-period-no-cost.json');
  await writeFile(tmpPath, JSON.stringify({ budget: { perPeriod: { window: 'day' } } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"budget.perPeriod.maxCostUsd" is required');
      },
    );
  } finally {
    await unlink(tmpPath);
  }
});

test('loadRuntimeConfig: rejects negative budget values', async () => {
  // F5: negative numbers must be rejected, otherwise checkBudget treats them
  // as "no limit" (silently) and a negative pricing rate yields negative costs.
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-negative-budget.json');
  await writeFile(tmpPath, JSON.stringify({ budget: { perScan: { maxCostUsd: -5 } } }), 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"budget.perScan.maxCostUsd" must be a non-negative number');
      },
    );
  } finally {
    await unlink(tmpPath);
  }
});

test('loadRuntimeConfig: rejects negative pricing rates', async () => {
  // F5: negative pricing.models.<name>.inputPerMillion produces negative costs.
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-negative-pricing.json');
  await writeFile(
    tmpPath,
    JSON.stringify({ pricing: { models: { foo: { inputPerMillion: -1, outputPerMillion: 1 } } } }),
    'utf-8',
  );
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('"pricing.models.foo.inputPerMillion" must be a non-negative number');
      },
    );
  } finally {
    await unlink(tmpPath);
  }
});

test('loadRuntimeConfig: rejects non-object root (e.g., array)', async () => {
  // Create an inline test by passing explicit path to a temp file
  const { writeFile: writeFileSync, unlink: unlinkSync } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'array-root.json');
  await writeFileSync(tmpPath, '[]', 'utf-8');
  try {
    await assert.rejects(
      async () => {
        await loadRuntimeConfig('/unused', tmpPath);
      },
      (err: unknown) => {
        const error = err as Error;
        return error.message.includes('must contain a JSON object');
      },
    );
  } finally {
    await unlinkSync(tmpPath);
  }
});

// Retry config was previously unvalidated, unlike budget: a bad value surfaced
// mid-scan, after AI calls had already been paid for, rather than at load.
test('loadRuntimeConfig: rejects invalid retry settings', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const cases: Array<{ config: unknown; expect: string }> = [
    { config: { retry: [] }, expect: '"retry" must be an object' },
    { config: { retry: { maxAttempts: 0 } }, expect: '"retry.maxAttempts" must be an integer >= 1' },
    { config: { retry: { maxAttempts: 2.5 } }, expect: '"retry.maxAttempts" must be an integer >= 1' },
    { config: { retry: { baseDelayMs: -1 } }, expect: '"retry.baseDelayMs" must be an integer >= 0' },
    { config: { retry: { circuitBreakerThreshold: 0 } }, expect: '"retry.circuitBreakerThreshold" must be an integer >= 1' },
    {
      config: { retry: { baseDelayMs: 5000, maxDelayMs: 1000 } },
      expect: '"retry.maxDelayMs" (1000) must be >= "retry.baseDelayMs" (5000)',
    },
  ];

  for (const { config, expect } of cases) {
    const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'bad-retry.json');
    await writeFile(tmpPath, JSON.stringify(config), 'utf-8');
    try {
      await assert.rejects(
        async () => {
          await loadRuntimeConfig('/unused', tmpPath);
        },
        (err: unknown) => (err as Error).message.includes(expect),
        `expected rejection containing: ${expect}`,
      );
    } finally {
      await unlink(tmpPath);
    }
  }
});

test('loadRuntimeConfig: accepts valid retry settings', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmpPath = resolve(__dirname, 'fixtures', 'runtime-config', 'good-retry.json');
  // maxAttempts: 1 is valid and means "no retry" — it counts the first attempt.
  await writeFile(
    tmpPath,
    JSON.stringify({ retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, circuitBreakerThreshold: 5 } }),
    'utf-8',
  );
  try {
    const cfg = await loadRuntimeConfig('/unused', tmpPath);
    assert.equal(cfg.retry?.maxAttempts, 1);
    assert.equal(cfg.retry?.circuitBreakerThreshold, 5);
  } finally {
    await unlink(tmpPath);
  }
});
