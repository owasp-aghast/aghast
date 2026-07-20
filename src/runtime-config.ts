/**
 * Runtime configuration loader.
 * Loads runtime-config.json from the config directory to override agent provider and reporting settings.
 * Spec Section 8.1 & Appendix C.10.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeConfig } from './types.js';

/**
 * Load runtime configuration from file.
 * @param configDir - Directory containing runtime-config.json. Optional when explicitPath is given.
 * @param explicitPath - Explicit path to the runtime config file (from --runtime-config CLI flag).
 * @returns Parsed RuntimeConfig object, or empty object if file absent
 * @throws Error if file exists but contains invalid JSON, or if neither argument resolves a path
 */
export async function loadRuntimeConfig(configDir?: string, explicitPath?: string): Promise<RuntimeConfig> {
  if (!explicitPath && !configDir) {
    throw new Error('loadRuntimeConfig: one of configDir or explicitPath is required');
  }
  const pathToLoad = explicitPath ?? resolve(configDir!, 'runtime-config.json');
  let content: string;
  try {
    content = await readFile(pathToLoad, 'utf-8');
  } catch (err: unknown) {
    // File absent: silently return defaults
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  // File exists but may have invalid JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in runtime config file: ${pathToLoad}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Runtime config file "${pathToLoad}" must contain a JSON object`);
  }

  // Validate field types
  const obj = parsed as Record<string, unknown>;
  if (obj.aiProvider !== undefined) {
    throw new Error(
      `Runtime config "${pathToLoad}": "aiProvider" has been renamed to "agentProvider" in 0.5.0. ` +
        `Update your runtime-config.json to use the new key.`,
    );
  }
  if (obj.agentProvider !== undefined) {
    if (typeof obj.agentProvider !== 'object' || obj.agentProvider === null || Array.isArray(obj.agentProvider)) {
      throw new Error(`Runtime config "${pathToLoad}": "agentProvider" must be an object`);
    }
    const ap = obj.agentProvider as Record<string, unknown>;
    if (ap.name !== undefined && typeof ap.name !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "agentProvider.name" must be a string`);
    }
    if (ap.model !== undefined && typeof ap.model !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "agentProvider.model" must be a string`);
    }
  }
  if (obj.reporting !== undefined) {
    if (typeof obj.reporting !== 'object' || obj.reporting === null || Array.isArray(obj.reporting)) {
      throw new Error(`Runtime config "${pathToLoad}": "reporting" must be an object`);
    }
    const rpt = obj.reporting as Record<string, unknown>;
    if (rpt.outputDirectory !== undefined && typeof rpt.outputDirectory !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "reporting.outputDirectory" must be a string`);
    }
    if (rpt.outputFormat !== undefined && typeof rpt.outputFormat !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "reporting.outputFormat" must be a string`);
    }
    if (rpt.includeIndividualIssueFiles !== undefined && typeof rpt.includeIndividualIssueFiles !== 'boolean') {
      throw new Error(`Runtime config "${pathToLoad}": "reporting.includeIndividualIssueFiles" must be a boolean`);
    }
    if (rpt.individualIssueFormat !== undefined) {
      if (typeof rpt.individualIssueFormat !== 'string') {
        throw new Error(`Runtime config "${pathToLoad}": "reporting.individualIssueFormat" must be a string`);
      }
      if (rpt.individualIssueFormat !== 'markdown' && rpt.individualIssueFormat !== 'json' && rpt.individualIssueFormat !== 'html') {
        throw new Error(`Runtime config "${pathToLoad}": "reporting.individualIssueFormat" must be one of "markdown", "json", "html"`);
      }
    }
  }
  if (obj.genericPrompt !== undefined && typeof obj.genericPrompt !== 'string') {
    throw new Error(`Runtime config "${pathToLoad}": "genericPrompt" must be a string`);
  }
  if (obj.failOnCheckFailure !== undefined && typeof obj.failOnCheckFailure !== 'boolean') {
    throw new Error(`Runtime config "${pathToLoad}": "failOnCheckFailure" must be a boolean`);
  }
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== 'object' || obj.budget === null || Array.isArray(obj.budget)) {
      throw new Error(`Runtime config "${pathToLoad}": "budget" must be an object`);
    }
    const budget = obj.budget as Record<string, unknown>;
    if (budget.perScan !== undefined) {
      if (typeof budget.perScan !== 'object' || budget.perScan === null || Array.isArray(budget.perScan)) {
        throw new Error(`Runtime config "${pathToLoad}": "budget.perScan" must be an object`);
      }
      const ps = budget.perScan as Record<string, unknown>;
      if (ps.maxTokens !== undefined) {
        if (typeof ps.maxTokens !== 'number' || !Number.isFinite(ps.maxTokens) || ps.maxTokens < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "budget.perScan.maxTokens" must be a non-negative number`);
        }
      }
      if (ps.maxCostUsd !== undefined) {
        if (typeof ps.maxCostUsd !== 'number' || !Number.isFinite(ps.maxCostUsd) || ps.maxCostUsd < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "budget.perScan.maxCostUsd" must be a non-negative number`);
        }
      }
    }
    if (budget.perPeriod !== undefined) {
      if (typeof budget.perPeriod !== 'object' || budget.perPeriod === null || Array.isArray(budget.perPeriod)) {
        throw new Error(`Runtime config "${pathToLoad}": "budget.perPeriod" must be an object`);
      }
      const pp = budget.perPeriod as Record<string, unknown>;
      if (pp.window !== undefined && pp.window !== 'day' && pp.window !== 'week' && pp.window !== 'month') {
        throw new Error(`Runtime config "${pathToLoad}": "budget.perPeriod.window" must be "day", "week", or "month"`);
      }
      if (pp.maxCostUsd !== undefined) {
        if (typeof pp.maxCostUsd !== 'number' || !Number.isFinite(pp.maxCostUsd) || pp.maxCostUsd < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "budget.perPeriod.maxCostUsd" must be a non-negative number`);
        }
      }
      // perPeriod requires both window and maxCostUsd to be functional. Reject
      // partial config so misconfiguration is loud, not silently dropped at
      // runtime. (The dual-undefined case is naturally caught by either
      // single-field check below — they fire in source order, the window check
      // wins. No separate guard needed.)
      if (pp.window === undefined) {
        throw new Error(`Runtime config "${pathToLoad}": "budget.perPeriod.window" is required when "budget.perPeriod" is set (must be "day", "week", or "month")`);
      }
      if (pp.maxCostUsd === undefined) {
        throw new Error(`Runtime config "${pathToLoad}": "budget.perPeriod.maxCostUsd" is required when "budget.perPeriod" is set`);
      }
    }
    if (budget.thresholds !== undefined) {
      if (typeof budget.thresholds !== 'object' || budget.thresholds === null || Array.isArray(budget.thresholds)) {
        throw new Error(`Runtime config "${pathToLoad}": "budget.thresholds" must be an object`);
      }
      const th = budget.thresholds as Record<string, unknown>;
      if (th.warnAt !== undefined) {
        if (typeof th.warnAt !== 'number' || !Number.isFinite(th.warnAt) || th.warnAt < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "budget.thresholds.warnAt" must be a non-negative number`);
        }
      }
      if (th.abortAt !== undefined) {
        if (typeof th.abortAt !== 'number' || !Number.isFinite(th.abortAt) || th.abortAt < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "budget.thresholds.abortAt" must be a non-negative number`);
        }
      }
    }
  }
  if (obj.retry !== undefined) {
    if (typeof obj.retry !== 'object' || obj.retry === null || Array.isArray(obj.retry)) {
      throw new Error(`Runtime config "${pathToLoad}": "retry" must be an object`);
    }
    const retry = obj.retry as Record<string, unknown>;
    // Validated at load rather than at first use: an invalid retry setting
    // otherwise surfaces mid-scan, after AI calls have already been paid for.
    const positiveInt = (key: string, min: number): void => {
      const value = retry[key];
      if (value === undefined) return;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
        throw new Error(
          `Runtime config "${pathToLoad}": "retry.${key}" must be an integer >= ${min}`,
        );
      }
    };
    // maxAttempts counts the first attempt, so 1 is valid and means no retry.
    positiveInt('maxAttempts', 1);
    positiveInt('baseDelayMs', 0);
    positiveInt('maxDelayMs', 0);
    positiveInt('circuitBreakerThreshold', 1);

    const base = retry.baseDelayMs;
    const max = retry.maxDelayMs;
    if (typeof base === 'number' && typeof max === 'number' && max < base) {
      throw new Error(
        `Runtime config "${pathToLoad}": "retry.maxDelayMs" (${max}) must be >= "retry.baseDelayMs" (${base})`,
      );
    }
  }
  if (obj.pricing !== undefined) {
    if (typeof obj.pricing !== 'object' || obj.pricing === null || Array.isArray(obj.pricing)) {
      throw new Error(`Runtime config "${pathToLoad}": "pricing" must be an object`);
    }
    const pricing = obj.pricing as Record<string, unknown>;
    if (pricing.currency !== undefined && typeof pricing.currency !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "pricing.currency" must be a string`);
    }
    if (pricing.models !== undefined) {
      if (typeof pricing.models !== 'object' || pricing.models === null || Array.isArray(pricing.models)) {
        throw new Error(`Runtime config "${pathToLoad}": "pricing.models" must be an object`);
      }
      for (const [modelName, def] of Object.entries(pricing.models as Record<string, unknown>)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) {
          throw new Error(`Runtime config "${pathToLoad}": "pricing.models.${modelName}" must be an object`);
        }
        const d = def as Record<string, unknown>;
        if (typeof d.inputPerMillion !== 'number' || typeof d.outputPerMillion !== 'number') {
          throw new Error(`Runtime config "${pathToLoad}": "pricing.models.${modelName}" must have numeric "inputPerMillion" and "outputPerMillion"`);
        }
        if (!Number.isFinite(d.inputPerMillion) || d.inputPerMillion < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "pricing.models.${modelName}.inputPerMillion" must be a non-negative number`);
        }
        if (!Number.isFinite(d.outputPerMillion) || d.outputPerMillion < 0) {
          throw new Error(`Runtime config "${pathToLoad}": "pricing.models.${modelName}.outputPerMillion" must be a non-negative number`);
        }
      }
    }
  }
  if (obj.logging !== undefined) {
    if (typeof obj.logging !== 'object' || obj.logging === null || Array.isArray(obj.logging)) {
      throw new Error(`Runtime config "${pathToLoad}": "logging" must be an object`);
    }
    const log = obj.logging as Record<string, unknown>;
    if (log.logFile !== undefined && typeof log.logFile !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "logging.logFile" must be a string`);
    }
    if (log.logType !== undefined && typeof log.logType !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "logging.logType" must be a string`);
    }
    if (log.level !== undefined && typeof log.level !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "logging.level" must be a string`);
    }
  }

  if (obj.judge !== undefined) {
    if (typeof obj.judge !== 'object' || obj.judge === null || Array.isArray(obj.judge)) {
      throw new Error(`Runtime config "${pathToLoad}": "judge" must be an object`);
    }
    const j = obj.judge as Record<string, unknown>;
    if (j.provider !== undefined && typeof j.provider !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "judge.provider" must be a string`);
    }
    if (j.model !== undefined && typeof j.model !== 'string') {
      throw new Error(`Runtime config "${pathToLoad}": "judge.model" must be a string`);
    }
    if (j.concurrency !== undefined) {
      if (typeof j.concurrency !== 'number' || !Number.isInteger(j.concurrency) || j.concurrency <= 0) {
        throw new Error(`Runtime config "${pathToLoad}": "judge.concurrency" must be a positive integer`);
      }
    }
    if (j.dropFalsePositives !== undefined && typeof j.dropFalsePositives !== 'boolean') {
      throw new Error(`Runtime config "${pathToLoad}": "judge.dropFalsePositives" must be a boolean`);
    }
    if (j.minConfidence !== undefined) {
      if (typeof j.minConfidence !== 'number' || j.minConfidence < 0 || j.minConfidence > 1) {
        throw new Error(`Runtime config "${pathToLoad}": "judge.minConfidence" must be a number between 0 and 1`);
      }
    }
  }

  return parsed as RuntimeConfig;
}
