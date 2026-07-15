/**
 * Tests for src/cost-calculator.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCost,
  sumCosts,
  loadDefaultPricing,
  mergePricing,
  formatCost,
  type PricingConfig,
} from '../src/cost-calculator.js';

const TEST_PRICING: PricingConfig = {
  currency: 'USD',
  models: {
    'test-haiku': { inputPerMillion: 1, outputPerMillion: 5 },
    'test-opus': { inputPerMillion: 15, outputPerMillion: 75 },
  },
};

describe('calculateCost', () => {
  it('computes cost from token counts and pricing', () => {
    // 1,000,000 input tokens at $1/M = $1.00; 200,000 output tokens at $5/M = $1.00
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 200_000, totalTokens: 1_200_000 },
      'test-haiku',
      TEST_PRICING,
    );
    assert.equal(cost.inputCost, 1.0);
    assert.equal(cost.outputCost, 1.0);
    assert.equal(cost.totalCost, 2.0);
    assert.equal(cost.currency, 'USD');
  });

  it('handles small token counts with sub-cent precision', () => {
    // 100 input tokens at $1/M = $0.0001
    const cost = calculateCost(
      { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      'test-haiku',
      TEST_PRICING,
    );
    assert.equal(cost.inputCost, 0.0001);
    assert.equal(cost.outputCost, 0);
    assert.equal(cost.totalCost, 0.0001);
  });

  it('returns zeros for an unknown model (does not throw)', () => {
    const cost = calculateCost(
      { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      'unknown-model',
      TEST_PRICING,
    );
    assert.equal(cost.totalCost, 0);
    assert.equal(cost.currency, 'USD');
  });

  it('returns zeros when token usage is undefined', () => {
    const cost = calculateCost(undefined, 'test-haiku', TEST_PRICING);
    assert.equal(cost.totalCost, 0);
  });

  it('uses pricing.currency when provided', () => {
    const eurPricing: PricingConfig = {
      currency: 'EUR',
      models: { foo: { inputPerMillion: 2, outputPerMillion: 4 } },
    };
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      'foo',
      eurPricing,
    );
    assert.equal(cost.currency, 'EUR');
    assert.equal(cost.totalCost, 6);
  });

  it('uses different rates for input vs output (Opus example)', () => {
    // 1M input @ $15/M + 1M output @ $75/M = $90 total
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      'test-opus',
      TEST_PRICING,
    );
    assert.equal(cost.inputCost, 15);
    assert.equal(cost.outputCost, 75);
    assert.equal(cost.totalCost, 90);
  });
});

describe('sumCosts', () => {
  it('sums multiple cost breakdowns', () => {
    const summed = sumCosts([
      { inputCost: 1, outputCost: 2, totalCost: 3, currency: 'USD' },
      { inputCost: 0.5, outputCost: 1.5, totalCost: 2, currency: 'USD' },
    ]);
    assert.equal(summed.inputCost, 1.5);
    assert.equal(summed.outputCost, 3.5);
    assert.equal(summed.totalCost, 5);
  });

  it('returns zeros for empty list', () => {
    const summed = sumCosts([]);
    assert.equal(summed.totalCost, 0);
    assert.equal(summed.currency, 'USD');
  });
});

describe('loadDefaultPricing', () => {
  it('loads built-in config/pricing.json with current Claude models', async () => {
    const pricing = await loadDefaultPricing();
    assert.equal(pricing.currency, 'USD');
    // Current generally available models, plus the limited-availability Mythos 5.
    assert.ok(pricing.models['claude-haiku-4-5'], 'haiku entry exists');
    assert.ok(pricing.models['claude-haiku-4-5-20251001'], 'pinned haiku entry exists');
    assert.ok(pricing.models['claude-sonnet-5'], 'sonnet entry exists');
    assert.ok(pricing.models['claude-opus-4-8'], 'latest opus entry exists');
    assert.ok(pricing.models['claude-fable-5'], 'fable entry exists');
    assert.ok(pricing.models['claude-mythos-5'], 'mythos entry exists');
    assert.equal(typeof pricing.models['claude-haiku-4-5'].inputPerMillion, 'number');
    assert.equal(typeof pricing.models['claude-haiku-4-5'].outputPerMillion, 'number');
  });

  it('prices Opus 4.8 and the opus alias at current published rates', async () => {
    const pricing = await loadDefaultPricing();
    const opus48 = pricing.models['claude-opus-4-8'];
    const opusAlias = pricing.models.opus;

    assert.deepEqual(opus48, {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
    assert.deepEqual(opusAlias, opus48);
  });

  it('cost matches expected for default haiku pricing', async () => {
    const pricing = await loadDefaultPricing();
    const haiku = pricing.models['claude-haiku-4-5'];
    // Spot-check: 100k input + 100k output
    const cost = calculateCost(
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000 },
      'claude-haiku-4-5',
      pricing,
    );
    assert.equal(cost.inputCost, (100_000 / 1_000_000) * haiku.inputPerMillion);
    assert.equal(cost.outputCost, (100_000 / 1_000_000) * haiku.outputPerMillion);
  });
});

describe('mergePricing', () => {
  it('returns base when override is undefined', () => {
    const merged = mergePricing(TEST_PRICING, undefined);
    assert.deepEqual(merged, TEST_PRICING);
  });

  it('overrides existing model entries with override values', () => {
    const merged = mergePricing(TEST_PRICING, {
      models: { 'test-haiku': { inputPerMillion: 2, outputPerMillion: 10 } },
    });
    assert.equal(merged.models['test-haiku'].inputPerMillion, 2);
    assert.equal(merged.models['test-haiku'].outputPerMillion, 10);
    // Untouched model survives
    assert.equal(merged.models['test-opus'].inputPerMillion, 15);
  });

  it('adds new models from override', () => {
    const merged = mergePricing(TEST_PRICING, {
      models: { 'new-model': { inputPerMillion: 100, outputPerMillion: 200 } },
    });
    assert.ok(merged.models['new-model']);
    assert.equal(merged.models['new-model'].inputPerMillion, 100);
  });

  it('uses override currency when provided', () => {
    const merged = mergePricing(TEST_PRICING, { currency: 'EUR' });
    assert.equal(merged.currency, 'EUR');
  });
});

describe('formatCost', () => {
  it('formats cost with 4 decimals and currency', () => {
    assert.equal(formatCost(1.23456789, 'USD'), '1.2346 USD');
  });

  it('defaults to USD currency', () => {
    assert.equal(formatCost(0.5), '0.5000 USD');
  });
});

describe('calculateCost: reported cost', () => {
  it('uses reportedCost verbatim when present, ignoring pricing table', () => {
    const cost = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        reportedCost: { amountUsd: 0.0123, source: 'claude-agent-sdk' },
      },
      'test-haiku',
      TEST_PRICING,
    );
    assert.equal(cost.totalCost, 0.0123);
    assert.equal(cost.source, 'reported');
    assert.equal(cost.reportedBy, 'claude-agent-sdk');
    assert.equal(cost.inputCost, 0);
    assert.equal(cost.outputCost, 0);
  });

  it('uses reportedCost from opencode provider', () => {
    const cost = calculateCost(
      {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reportedCost: { amountUsd: 0.0789, source: 'opencode' },
      },
      'unknown-model',
      TEST_PRICING,
    );
    assert.equal(cost.totalCost, 0.0789);
    assert.equal(cost.source, 'reported');
    assert.equal(cost.reportedBy, 'opencode');
  });
});

describe('calculateCost: cache and reasoning fallback', () => {
  const CACHE_PRICING: PricingConfig = {
    currency: 'USD',
    models: {
      'test-haiku': {
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1.25,
      },
    },
  };

  it('includes cache read and write costs in total when rates are present', () => {
    const cost = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        totalTokens: 1_000_000,
      },
      'test-haiku',
      CACHE_PRICING,
    );
    assert.equal(cost.inputCost, 1.0);
    assert.equal(cost.cacheReadCost, 0.1);
    assert.equal(cost.cacheWriteCost, 1.25);
    assert.equal(cost.totalCost, 1.0 + 0.1 + 1.25);
    assert.equal(cost.source, 'estimated');
  });

  it('counts reasoning tokens at output rate', () => {
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
        totalTokens: 0,
      },
      'test-haiku',
      CACHE_PRICING,
    );
    assert.equal(cost.outputCost, 5.0);
    assert.equal(cost.totalCost, 5.0);
  });

  it('omits cacheReadCost/cacheWriteCost when rates are absent', () => {
    const cost = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        totalTokens: 1_000_000,
      },
      'test-haiku',
      TEST_PRICING, // no cache rates
    );
    assert.equal(cost.cacheReadCost, undefined);
    assert.equal(cost.cacheWriteCost, undefined);
    assert.equal(cost.totalCost, 1.0);
  });
});

describe('calculateCost: unknown model', () => {
  it('returns estimated-unpriced and zero cost for unknown model', () => {
    const cost = calculateCost(
      { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      'some-unknown-model',
      TEST_PRICING,
    );
    assert.equal(cost.totalCost, 0);
    assert.equal(cost.source, 'estimated-unpriced');
    assert.equal(cost.currency, 'USD');
  });
});

describe('sumCosts: source precedence', () => {
  it('reported wins over estimated', () => {
    const summed = sumCosts([
      { inputCost: 1, outputCost: 0, totalCost: 1, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk' },
      { inputCost: 0.5, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.source, 'reported');
    assert.equal(summed.reportedBy, 'claude-agent-sdk');
  });

  it('estimated wins over estimated-unpriced', () => {
    const summed = sumCosts([
      { inputCost: 1, outputCost: 0, totalCost: 1, currency: 'USD', source: 'estimated-unpriced' },
      { inputCost: 0.5, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.source, 'estimated');
  });

  it('estimated wins over legacy', () => {
    const summed = sumCosts([
      { inputCost: 1, outputCost: 0, totalCost: 1, currency: 'USD', source: 'legacy' },
      { inputCost: 0.5, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.source, 'estimated');
  });
});

describe('sumCosts: totalCost with reported-source breakdowns', () => {
  it('totalCost sums correctly when source is reported (inputCost/outputCost are 0)', () => {
    // calculateCost with reportedCost returns inputCost=0, outputCost=0, totalCost=<amount>.
    // sumCosts must accumulate totalCost directly rather than deriving it from inputCost+outputCost.
    const summed = sumCosts([
      { inputCost: 0, outputCost: 0, totalCost: 1.0, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk' },
      { inputCost: 0, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk' },
    ]);
    assert.equal(summed.totalCost, 1.5);
    assert.equal(summed.inputCost, 0);
    assert.equal(summed.outputCost, 0);
  });

  it('totalCost sums correctly in mixed reported+estimated scenario (including cache costs)', () => {
    // The estimated entry has totalCost=0.6 > inputCost+outputCost=0.5 due to cache costs.
    // This verifies that c.totalCost is read directly for estimated entries too,
    // not re-derived as inputCost+outputCost (which would lose cache costs).
    const summed = sumCosts([
      { inputCost: 0, outputCost: 0, totalCost: 1.0, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk' },
      { inputCost: 0.25, outputCost: 0.25, cacheReadCost: 0.1, totalCost: 0.6, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.totalCost, 1.6);
    assert.equal(summed.inputCost, 0.25);
    assert.equal(summed.outputCost, 0.25);
    assert.equal(summed.cacheReadCost, 0.1);
  });
});

describe('calculateCost: coveredBySubscription', () => {
  it('propagates coveredBySubscription from reportedCost to CostBreakdown', () => {
    const cost = calculateCost(
      {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reportedCost: { amountUsd: 0.05, source: 'claude-agent-sdk', coveredBySubscription: true },
      },
      'test-haiku',
      TEST_PRICING,
    );
    assert.equal(cost.totalCost, 0.05);
    assert.equal(cost.source, 'reported');
    assert.equal(cost.coveredBySubscription, true);
  });

  it('coveredBySubscription is absent when reportedCost does not set it', () => {
    const cost = calculateCost(
      {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reportedCost: { amountUsd: 0.05, source: 'claude-agent-sdk' },
      },
      'test-haiku',
      TEST_PRICING,
    );
    assert.equal(cost.coveredBySubscription, undefined);
  });
});

describe('sumCosts: coveredBySubscription AND logic', () => {
  it('is true when all summands are covered', () => {
    const summed = sumCosts([
      { inputCost: 0, outputCost: 0, totalCost: 1.0, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk', coveredBySubscription: true },
      { inputCost: 0, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk', coveredBySubscription: true },
    ]);
    assert.equal(summed.coveredBySubscription, true);
  });

  it('is absent when only some summands are covered', () => {
    const summed = sumCosts([
      { inputCost: 0, outputCost: 0, totalCost: 1.0, currency: 'USD', source: 'reported', reportedBy: 'claude-agent-sdk', coveredBySubscription: true },
      { inputCost: 0.5, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.coveredBySubscription, undefined);
  });

  it('is absent when no summands are covered', () => {
    const summed = sumCosts([
      { inputCost: 1, outputCost: 0, totalCost: 1.0, currency: 'USD', source: 'estimated' },
      { inputCost: 0.5, outputCost: 0, totalCost: 0.5, currency: 'USD', source: 'estimated' },
    ]);
    assert.equal(summed.coveredBySubscription, undefined);
  });
});
