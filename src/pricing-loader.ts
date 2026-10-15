/** Automatically refreshed fallback estimates. Provider-reported costs remain authoritative. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDefaultPricing, mergePricing, type ModelPricing, type PricingConfig } from './cost-calculator.js';
import { logDebug, logWarn } from './logging.js';

const PRICING_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const TAG = 'pricing';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function rate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function modelRates(value: unknown): ModelPricing | undefined {
  const cost = object(value);
  if (!cost || !rate(cost.input) || !rate(cost.output)) return undefined;
  if (cost.cache_read !== undefined && !rate(cost.cache_read)) return undefined;
  if (cost.cache_write !== undefined && !rate(cost.cache_write)) return undefined;
  const rates: ModelPricing = {
    inputPerMillion: cost.input,
    outputPerMillion: cost.output,
    ...(rate(cost.cache_read) ? { cacheReadPerMillion: cost.cache_read } : {}),
    ...(rate(cost.cache_write) ? { cacheWritePerMillion: cost.cache_write } : {}),
  };
  // Usage is aggregated across requests: use the highest published context rates
  // rather than trying to infer individual prompt lengths from a scan's totals.
  if (Array.isArray(cost.tiers)) {
    for (const value of cost.tiers) {
      const tier = object(value);
      if (object(tier?.tier)?.type !== 'context') continue;
      const tierRates = modelRates({ ...tier, tiers: undefined });
      if (!tierRates) continue;
      rates.inputPerMillion = Math.max(rates.inputPerMillion, tierRates.inputPerMillion);
      rates.outputPerMillion = Math.max(rates.outputPerMillion, tierRates.outputPerMillion);
      if (tierRates.cacheReadPerMillion !== undefined) {
        rates.cacheReadPerMillion = Math.max(rates.cacheReadPerMillion ?? 0, tierRates.cacheReadPerMillion);
      }
      if (tierRates.cacheWritePerMillion !== undefined) {
        rates.cacheWritePerMillion = Math.max(rates.cacheWritePerMillion ?? 0, tierRates.cacheWritePerMillion);
      }
    }
  }
  return rates;
}

/** Import full Claude model IDs only; the SDK supplies the IDs actually used. */
export function pricingFromCatalog(value: unknown): PricingConfig {
  const providerModels = object(object(object(value)?.anthropic)?.models);
  if (!providerModels) throw new Error('Pricing catalog contains no Anthropic models');
  const models: Record<string, ModelPricing> = Object.create(null);
  for (const [id, model] of Object.entries(providerModels)) {
    const rates = modelRates(object(model)?.cost);
    if (id.startsWith('claude-') && rates) models[id] = rates;
  }
  if (Object.keys(models).length === 0) throw new Error('Pricing catalog contains no valid rates');
  return { currency: 'USD', models };
}

function cachedPricing(value: unknown): { fetchedAt: number; pricing: PricingConfig } | undefined {
  const cache = object(value);
  const pricing = object(cache?.pricing);
  const models = object(pricing?.models);
  if (cache?.version !== 1 || !rate(cache.fetchedAt) || pricing?.currency !== 'USD' || !models) return undefined;
  const valid: Record<string, ModelPricing> = Object.create(null);
  for (const [id, value] of Object.entries(models)) {
    const entry = object(value);
    const rates = modelRates({
      input: entry?.inputPerMillion, output: entry?.outputPerMillion,
      cache_read: entry?.cacheReadPerMillion, cache_write: entry?.cacheWritePerMillion,
    });
    if (id.startsWith('claude-') && rates) valid[id] = rates;
  }
  return Object.keys(valid).length ? { fetchedAt: cache.fetchedAt, pricing: { currency: 'USD', models: valid } } : undefined;
}

/** Daily refresh, with stale cache and bundled snapshot fallbacks. Never blocks a scan on discovery failure. */
export async function loadPricing(options: {
  offline?: boolean;
  cacheFile?: string;
  fetchFn?: typeof fetch;
  now?: number;
} = {}): Promise<PricingConfig> {
  const bundled = await loadDefaultPricing();
  // Bundled aliases also assume a particular version. Keep only full model IDs.
  for (const id of Object.keys(bundled.models)) {
    if (!id.startsWith('claude-')) delete bundled.models[id];
  }
  const cacheFile = resolve(options.cacheFile ?? process.env.AGHAST_PRICING_CACHE_FILE ?? resolve(homedir(), '.aghast', 'pricing-cache.json'));
  const now = options.now ?? Date.now();
  let cached: ReturnType<typeof cachedPricing>;
  try {
    cached = cachedPricing(JSON.parse(await readFile(cacheFile, 'utf-8')));
  } catch { /* Missing, unreadable, or corrupt cache: refresh normally. */ }

  let discovered = cached?.pricing;
  const offline = options.offline ?? (process.env.AGHAST_PRICING_OFFLINE === 'true');
  if (!offline && (!cached || now < cached.fetchedAt || now - cached.fetchedAt >= CACHE_TTL_MS)) {
    try {
      const response = await (options.fetchFn ?? fetch)(PRICING_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      discovered = pricingFromCatalog(await response.json());
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, fetchedAt: now, pricing: discovered }), 'utf-8');
        await rename(temporary, cacheFile);
      } catch (err) {
        logDebug(TAG, `Could not cache pricing: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      logWarn(TAG, `Could not refresh models.dev pricing (${err instanceof Error ? err.message : String(err)}); using ${cached ? 'cached' : 'bundled'} estimates.`);
    }
  }
  return discovered ? mergePricing(bundled, discovered) : bundled;
}
