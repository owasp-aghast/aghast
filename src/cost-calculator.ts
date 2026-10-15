/**
 * Cost calculator: maps token usage to estimated USD cost using per-model pricing.
 *
 * Pricing is refreshed from models.dev with cached and bundled defaults, and may be
 * overridden via the runtime config `pricing` section. Prices change over time
 * and are not authoritative — they are estimates for budgeting/dashboarding.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logWarn } from './logging.js';
import type { TokenUsage } from './types.js';

const TAG = 'pricing';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Per-million-token rates for a single model. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/** Pricing config (default file or runtime override). */
export interface PricingConfig {
  currency?: string;
  models: Record<string, ModelPricing>;
}

/** Computed cost for a single token-usage record. */
export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  totalCost: number;
  currency: string;
  /** How the cost was determined. */
  source: 'reported' | 'estimated' | 'estimated-unpriced' | 'legacy';
  /** When source === 'reported', which provider reported it. */
  reportedBy?: 'claude-agent-sdk' | 'opencode';
  /** true when running with AGHAST_LOCAL_CLAUDE=true — amount is API-equivalent, not billed */
  coveredBySubscription?: boolean;
}

const DEFAULT_CURRENCY = 'USD';

/**
 * Calculate cost for a TokenUsage value.
 *
 * Priority:
 *   1. tokens.reportedCost — provider-reported amount used verbatim (source='reported').
 *   2. Rate-table fallback — model must exist in pricing.models; includes cache and
 *      reasoning tokens. Reasoning is billed at output rate (Decision 5).
 *   3. Rate-table fallback but model unknown → source='estimated-unpriced', cost=$0 + warning.
 *   4. tokens undefined → source='estimated', cost=$0.
 */
export function calculateCost(
  tokens: TokenUsage | undefined,
  model: string,
  pricing: PricingConfig,
): CostBreakdown {
  const currency = pricing.currency ?? DEFAULT_CURRENCY;

  if (tokens?.reportedCost !== undefined) {
    return {
      inputCost: 0,
      outputCost: 0,
      totalCost: tokens.reportedCost.amountUsd,
      currency,
      source: 'reported',
      reportedBy: tokens.reportedCost.source,
      ...(tokens.reportedCost.coveredBySubscription ? { coveredBySubscription: true } : {}),
    };
  }

  if (!tokens) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency, source: 'estimated' };
  }

  if (tokens.perModel && Object.keys(tokens.perModel).length > 0) {
    const costs = Object.entries(tokens.perModel).map(([id, usage]) => calculateCost(usage, id, pricing));
    const result = sumCosts(costs);
    // A partial estimate must still signal that some models have no price.
    if (costs.some((cost) => cost.source === 'estimated-unpriced')) result.source = 'estimated-unpriced';
    return result;
  }

  const rates = pricing.models[model];
  if (!rates) {
    logWarn(TAG, `Model "${model}" not in pricing table; cost reported as $0`);
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency, source: 'estimated-unpriced' };
  }

  // Reasoning tokens billed at output rate (Decision 5).
  const billableOutputTokens = tokens.outputTokens + (tokens.reasoningTokens ?? 0);
  const inputCost = (tokens.inputTokens / 1_000_000) * rates.inputPerMillion;
  const outputCost = (billableOutputTokens / 1_000_000) * rates.outputPerMillion;
  const cacheReadCost =
    rates.cacheReadPerMillion !== undefined && tokens.cacheReadInputTokens !== undefined
      ? (tokens.cacheReadInputTokens / 1_000_000) * rates.cacheReadPerMillion
      : undefined;
  const cacheWriteCost =
    rates.cacheWritePerMillion !== undefined && tokens.cacheCreationInputTokens !== undefined
      ? (tokens.cacheCreationInputTokens / 1_000_000) * rates.cacheWritePerMillion
      : undefined;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + (cacheReadCost ?? 0) + (cacheWriteCost ?? 0),
    currency,
    source: 'estimated',
  };
}

/**
 * Sum a list of CostBreakdowns into one total. Returns zeros if list is empty.
 * Currency is taken from the first non-empty entry (or USD by default).
 */
export function sumCosts(costs: CostBreakdown[]): CostBreakdown {
  if (costs.length === 0) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: DEFAULT_CURRENCY, source: 'estimated' };
  }
  let inputCost = 0;
  let outputCost = 0;
  let cacheReadCost = 0;
  let cacheWriteCost = 0;
  // totalCost must be accumulated directly from each entry rather than derived as
  // inputCost+outputCost at the end. Two reasons:
  //   1. For 'reported' breakdowns, calculateCost returns inputCost=0/outputCost=0
  //      with the full amount in totalCost — deriving from the sub-fields drops it.
  //   2. For 'estimated' breakdowns, totalCost includes cache costs (cacheReadCost,
  //      cacheWriteCost) that are not reflected in inputCost or outputCost.
  let totalCost = 0;
  for (const c of costs) {
    inputCost += c.inputCost;
    outputCost += c.outputCost;
    cacheReadCost += c.cacheReadCost ?? 0;
    cacheWriteCost += c.cacheWriteCost ?? 0;
    totalCost += c.totalCost;
  }
  // Pick the most authoritative source across all summands.
  // Precedence: reported > estimated > estimated-unpriced > legacy.
  const SOURCE_PRIORITY: Record<CostBreakdown['source'], number> = {
    reported: 3,
    estimated: 2,
    'estimated-unpriced': 1,
    legacy: 0,
  };
  const dominant = costs.reduce((best, c) =>
    SOURCE_PRIORITY[c.source] > SOURCE_PRIORITY[best.source] ? c : best,
  );
  // coveredBySubscription is true only when ALL summands are covered.
  const allCovered = costs.every((c) => c.coveredBySubscription === true);
  return {
    inputCost,
    outputCost,
    ...(cacheReadCost > 0 ? { cacheReadCost } : {}),
    ...(cacheWriteCost > 0 ? { cacheWriteCost } : {}),
    totalCost,
    currency: costs[0].currency,
    source: dominant.source,
    reportedBy: dominant.reportedBy,
    ...(allCovered ? { coveredBySubscription: true } : {}),
  };
}

/**
 * Load the built-in pricing.json shipped with aghast.
 *
 * Behaviour:
 *   - File missing (ENOENT): return empty pricing silently. This is expected
 *     when running from a build that doesn't ship the file.
 *   - File present but unreadable / invalid JSON / wrong shape: log a warning
 *     and return empty pricing so the scan can still run. The empty pricing
 *     means cost is reported as 0 — distinct from a corrupt pricing file
 *     producing meaningless costs.
 */
export async function loadDefaultPricing(): Promise<PricingConfig> {
  // src/cost-calculator.ts -> ../config/pricing.json
  const pricingPath = resolve(__dirname, '..', 'config', 'pricing.json');
  let content: string;
  try {
    content = await readFile(pricingPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(
        TAG,
        `Could not read pricing file at ${pricingPath} (${err instanceof Error ? err.message : String(err)}); cost estimates will be 0.`,
      );
    }
    return { currency: DEFAULT_CURRENCY, models: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logWarn(
      TAG,
      `Pricing file at ${pricingPath} contains invalid JSON (${err instanceof Error ? err.message : String(err)}); cost estimates will be 0.`,
    );
    return { currency: DEFAULT_CURRENCY, models: {} };
  }

  // JSON parsed, but the shape may still be wrong (e.g., null, an array, or a
  // bare string). Normalize defensively and report shape errors with a
  // distinct message so the user knows it's not a JSON-syntax problem.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarn(
      TAG,
      `Pricing file at ${pricingPath} did not contain a JSON object; cost estimates will be 0.`,
    );
    return { currency: DEFAULT_CURRENCY, models: {} };
  }
  try {
    return normalizePricing(parsed as Record<string, unknown>);
  } catch (err) {
    logWarn(
      TAG,
      `Pricing file at ${pricingPath} could not be parsed as a pricing config (${err instanceof Error ? err.message : String(err)}); cost estimates will be 0.`,
    );
    return { currency: DEFAULT_CURRENCY, models: {} };
  }
}

/**
 * Normalize a raw object into a PricingConfig, dropping unknown keys.
 * Tolerant of extra fields (e.g. `_comment`).
 */
function normalizePricing(raw: Record<string, unknown>): PricingConfig {
  const currency = typeof raw.currency === 'string' ? raw.currency : DEFAULT_CURRENCY;
  const models: Record<string, ModelPricing> = {};
  const rawModels = raw.models;
  if (rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
    for (const [name, def] of Object.entries(rawModels as Record<string, unknown>)) {
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        const d = def as Record<string, unknown>;
        if (typeof d.inputPerMillion === 'number' && typeof d.outputPerMillion === 'number') {
          models[name] = {
            inputPerMillion: d.inputPerMillion,
            outputPerMillion: d.outputPerMillion,
            ...(typeof d.cacheReadPerMillion === 'number' ? { cacheReadPerMillion: d.cacheReadPerMillion } : {}),
            ...(typeof d.cacheWritePerMillion === 'number' ? { cacheWritePerMillion: d.cacheWritePerMillion } : {}),
          };
        }
      }
    }
  }
  return { currency, models };
}

/**
 * Merge a runtime-config override into a base pricing config.
 * Per-model entries from the override replace those in the base. Unspecified
 * models are inherited from the base.
 */
export function mergePricing(base: PricingConfig, override?: Partial<PricingConfig>): PricingConfig {
  if (!override) return base;
  return {
    currency: override.currency ?? base.currency ?? DEFAULT_CURRENCY,
    models: { ...base.models, ...(override.models ?? {}) },
  };
}

/**
 * Format a cost as a fixed-precision string with currency suffix.
 * Used for CLI summaries.
 */
export function formatCost(cost: number, currency: string = DEFAULT_CURRENCY): string {
  // 4 decimal places preserves sub-cent precision for individual checks.
  return `${cost.toFixed(4)} ${currency}`;
}

/**
 * Map a CostBreakdown source (and optional reportedBy) to a human-readable
 * label for banner / stats / JSON output.
 */
export function formatCostSourceLabel(
  source: CostBreakdown['source'] | undefined,
  reportedBy?: CostBreakdown['reportedBy'],
  coveredBySubscription?: boolean,
): string {
  if (source === 'reported') {
    if (coveredBySubscription) return '(covered by subscription — claude-agent-sdk)';
    if (reportedBy === 'opencode') return '(reported by opencode — see docs/cost-tracking.md)';
    return '(reported by claude-agent-sdk)';
  }
  if (source === 'estimated-unpriced') return '(estimated — model not in pricing table)';
  if (source === 'legacy') return '(legacy estimate)';
  return '(estimated from pricing rates)';
}
