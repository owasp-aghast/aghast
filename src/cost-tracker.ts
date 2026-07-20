/**
 * Shared cost-tracking utilities for the scan runner and judge stage.
 */

import { calculateCost, type PricingConfig, type CostBreakdown } from './cost-calculator.js';
import { checkBudget, BudgetExceededError, type BudgetLimits } from './budget.js';
import { logProgress } from './logging.js';
import type { TokenUsage } from './types.js';
import type { ScanRecord } from './scan-history.js';

const TAG = 'scan';

/**
 * Tracks accumulated tokens/cost across a scan so the budget can be evaluated
 * before each AI call. Mutated in place by AI invocations.
 */
export interface ScanCostTracker {
  pricing?: PricingConfig;
  budgetLimits?: BudgetLimits;
  scanHistory?: ScanRecord[];
  totalTokens: number;
  totalCostUsd: number;
  /** Cost source from the last recorded AI call. Used for banner labelling. */
  lastCostSource?: CostBreakdown['source'];
  lastCostReportedBy?: CostBreakdown['reportedBy'];
  lastCostCoveredBySubscription?: boolean;
  /** Set true after the first warn so we don't log it repeatedly. */
  warned: boolean;
  /** Most recent budget action returned to the runner. */
  lastAction: 'continue' | 'warn' | 'abort';
  /** Reason from the most recent non-continue check. */
  lastReason?: string;
}

export function createCostTracker(options: {
  pricing?: PricingConfig;
  budgetLimits?: BudgetLimits;
  scanHistory?: ScanRecord[];
}): ScanCostTracker {
  return {
    pricing: options.pricing,
    budgetLimits: options.budgetLimits,
    scanHistory: options.scanHistory,
    totalTokens: 0,
    totalCostUsd: 0,
    warned: false,
    lastAction: 'continue',
  };
}

/**
 * Record an AI call's token usage against the tracker. Called after each
 * successful executeCheck().
 */
export function recordUsage(
  tracker: ScanCostTracker,
  usage: TokenUsage | undefined,
  model: string,
): void {
  if (!usage || !tracker.pricing) return;
  const cost = calculateCost(usage, model, tracker.pricing);
  tracker.totalTokens += usage.totalTokens;
  tracker.totalCostUsd += cost.totalCost;
  tracker.lastCostSource = cost.source;
  tracker.lastCostReportedBy = cost.reportedBy;
  tracker.lastCostCoveredBySubscription = cost.coveredBySubscription;
}

/**
 * Check the budget before an AI call. Logs a warning the first time the warn
 * threshold is crossed; throws BudgetExceededError when the abort threshold is
 * crossed.
 */
export function preflightBudget(tracker: ScanCostTracker): void {
  if (!tracker.budgetLimits) return;
  const status = checkBudget(
    {
      currentScanCostUsd: tracker.totalCostUsd,
      currentScanTokens: tracker.totalTokens,
      history: tracker.scanHistory,
    },
    tracker.budgetLimits,
  );
  tracker.lastAction = status.action;
  tracker.lastReason = status.reason;
  if (status.action === 'abort') {
    throw new BudgetExceededError(status.reason ?? 'Budget limit exceeded');
  }
  if (status.action === 'warn' && !tracker.warned) {
    tracker.warned = true;
    logProgress(TAG, `Budget warning: ${status.reason ?? 'approaching limit'}`);
  }
}
