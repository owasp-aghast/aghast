import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPricing, pricingFromCatalog } from '../src/pricing-loader.js';
import { calculateCost, mergePricing } from '../src/cost-calculator.js';

const NOW = Date.parse('2026-10-14T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const CATALOG = {
  anthropic: { models: {
    'claude-sonnet-5-5': { family: 'claude-sonnet', release_date: '2026-09-28', cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } },
    'claude-sonnet-6': { family: 'claude-sonnet', release_date: '2026-10-13', cost: { input: 1.5, output: 8 } },
    'claude-sonnet-future': { family: 'claude-sonnet', release_date: '2027-01-01', cost: { input: 20, output: 100 } },
    'claude-sonnet-beta': { family: 'claude-sonnet', release_date: '2026-10-14', status: 'beta', cost: { input: 10, output: 50 } },
    'claude-haiku-5-5': { family: 'claude-haiku', release_date: '2026-10-07', cost: {
      input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125,
      tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: 'context', size: 100000 } }],
    } },
    invalid: { cost: { input: -1, output: 5 } },
    'invalid-cache': { cost: { input: 1, output: 5, cache_read: '0.1' } },
  } },
  openai: { models: { 'example-model': { cost: { input: 3, output: 12, cache_read: 0 } } } },
};

function fetchCatalog(catalog: unknown = CATALOG): typeof fetch {
  return async (input, init) => {
    assert.equal(input, 'https://models.dev/api.json');
    assert.ok(init?.signal, 'requests have a timeout signal');
    return new Response(JSON.stringify(catalog));
  };
}

async function withCache(test: (cacheFile: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'aghast-pricing-'));
  try { await test(join(directory, 'pricing.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('pricingFromCatalog', () => {
  it('discovers full Claude IDs without importing other providers or guessing aliases', () => {
    const pricing = pricingFromCatalog(CATALOG);
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
    assert.equal(pricing.models.sonnet, undefined);
    assert.equal(pricing.models['anthropic/claude-sonnet-6'], undefined);
    assert.equal(pricing.models['openai/example-model'], undefined);
    assert.equal(pricing.models['example-model'], undefined);
    assert.equal(pricing.models.invalid, undefined);
    assert.equal(pricing.models['invalid-cache'], undefined);
  });

  it('uses the highest context-tier prices for aggregate usage', () => {
    const pricing = pricingFromCatalog(CATALOG);
    assert.deepEqual(pricing.models['claude-haiku-5-5'], {
      inputPerMillion: 0.5, outputPerMillion: 2.5,
      cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625,
    });
  });

  it('rejects empty or malformed catalogs', () => {
    for (const value of [null, [], {}, { anthropic: { models: { bad: { cost: { input: Infinity, output: 5 } } } } }]) {
      assert.throws(() => pricingFromCatalog(value));
    }
  });
});

describe('loadPricing', () => {
  it('fetches live rates, persists them, and reuses fresh cache without network access', async () => withCache(async (cacheFile) => {
    const pricing = await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf-8')).fetchedAt, NOW);
    let calls = 0;
    const cached = await loadPricing({ cacheFile, now: NOW + 1000, fetchFn: async () => { calls++; throw new Error('must not fetch'); } });
    assert.equal(calls, 0);
    assert.deepEqual(cached, pricing);
  }));

  it('refreshes expired cache and uses the new rates', async () => withCache(async (cacheFile) => {
    await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    const updated = { anthropic: { models: { 'claude-sonnet-6': {
      family: 'claude-sonnet', release_date: '2026-10-13', cost: { input: 1, output: 4 },
    } } } };
    const pricing = await loadPricing({ cacheFile, now: NOW + DAY, fetchFn: fetchCatalog(updated) });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1);
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf-8')).fetchedAt, NOW + DAY);
  }));

  it('keeps stale rates when refreshing fails', async () => withCache(async (cacheFile) => {
    await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    const pricing = await loadPricing({ cacheFile, now: NOW + DAY, fetchFn: async () => { throw new Error('offline'); } });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf-8')).fetchedAt, NOW);
  }));

  it('falls back to bundled prices on HTTP errors, invalid JSON, and malformed data', async () => withCache(async (cacheFile) => {
    for (const response of [new Response('', { status: 503 }), new Response('invalid json'), new Response('{}')]) {
      const pricing = await loadPricing({ cacheFile, now: NOW, fetchFn: async () => response });
      assert.equal(pricing.models['claude-haiku-4-5'].inputPerMillion, 1);
      assert.equal(pricing.models['claude-sonnet-6'], undefined);
    }
  }));

  it('recovers a corrupt cache and still uses fresh rates if cache writes fail', async () => withCache(async (cacheFile) => {
    await writeFile(cacheFile, '{');
    let pricing = await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
    // A regular file cannot serve as a cache directory.
    pricing = await loadPricing({ cacheFile: join(cacheFile, 'blocked.json'), now: NOW, fetchFn: fetchCatalog() });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
  }));

  it('offline mode uses cached or bundled prices and never makes requests', async () => withCache(async (cacheFile) => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
    let pricing = await loadPricing({ cacheFile, now: NOW, offline: true, fetchFn });
    assert.equal(pricing.models['claude-sonnet-6'], undefined);
    await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    pricing = await loadPricing({ cacheFile, now: NOW + DAY, offline: true, fetchFn });
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
    assert.equal(calls, 0);
  }));

  it('keeps custom pricing and provider-reported costs ahead of discovered rates', async () => withCache(async (cacheFile) => {
    const discovered = await loadPricing({ cacheFile, now: NOW, fetchFn: fetchCatalog() });
    const pricing = mergePricing(discovered, { models: { sonnet: { inputPerMillion: 9, outputPerMillion: 45 } } });
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
    assert.equal(calculateCost(tokens, 'sonnet', pricing).totalCost, 9);
    assert.equal(calculateCost({ ...tokens, reportedCost: { amountUsd: 0.1, source: 'claude-agent-sdk' } }, 'sonnet', pricing).totalCost, 0.1);
  }));

  it('drops aliases and other providers from old caches and bundled fallbacks', async () => withCache(async (cacheFile) => {
    await writeFile(cacheFile, JSON.stringify({ version: 1, fetchedAt: NOW, pricing: {
      currency: 'USD', models: {
        sonnet: { inputPerMillion: 99, outputPerMillion: 99 },
        'openai/example-model': { inputPerMillion: 3, outputPerMillion: 12 },
        'claude-sonnet-6': { inputPerMillion: 1.5, outputPerMillion: 8 },
      },
    } }));
    const pricing = await loadPricing({ cacheFile, now: NOW, offline: true });
    assert.equal(pricing.models.sonnet, undefined);
    assert.equal(pricing.models.haiku, undefined);
    assert.equal(pricing.models['openai/example-model'], undefined);
    assert.equal(pricing.models['claude-sonnet-6'].inputPerMillion, 1.5);
  }));
});
