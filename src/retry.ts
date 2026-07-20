/**
 * Retry helper with exponential backoff and an optional shared circuit breaker.
 *
 * Spec Appendix E.6 — Retry and Resilience.
 *
 * Default classifier retries on rate-limit (429), 5xx, network/timeout errors;
 * does NOT retry auth errors (401/403) or validation errors. Callers can override
 * via `isRetryable`.
 *
 * The circuit breaker is shared across every `withRetry` invocation that
 * receives the same `CircuitBreaker` instance. Within a single scan that
 * means concurrent target analyses share one breaker; across multiple
 * `runMultiScan` invocations the scope depends on whether the caller hoists
 * the breaker to module scope or constructs a fresh one per scan (currently
 * `runMultiScan` does the latter, so the breaker is per-scan, not per-process).
 * When `consecutiveFailures` reaches the configured threshold, subsequent
 * calls fail-fast with `CircuitOpenError` without invoking the wrapped
 * function. A successful call resets the counter.
 */

import { logDebug } from './logging.js';

const TAG = 'retry';

export interface RetryOptions {
  /** Maximum total attempts (initial + retries). Must be >= 1. */
  maxAttempts: number;
  /** Initial backoff delay in ms (before jitter). */
  baseDelayMs: number;
  /** Cap on the backoff delay in ms (before jitter). */
  maxDelayMs: number;
  /** Optional classifier — return true to retry, false to give up immediately. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional shared circuit breaker. */
  breaker?: CircuitBreaker;
  /** Optional sleep override (for testing). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional jitter source returning [0, 1). Defaults to Math.random. */
  random?: () => number;
  /** Optional label for log lines. */
  label?: string;
}

/**
 * Default retry options used when callers don't supply a value.
 *
 * `maxAttempts: 1` means retry is OFF unless explicitly configured — one
 * attempt, no backoff, the original error rethrown untouched. This keeps a
 * plain `aghast scan` behaving exactly as it did before retry existed.
 * Opt in with `--retry-max-attempts`, `AGHAST_RETRY_MAX_ATTEMPTS`, or
 * `retry.maxAttempts` in runtime config.
 *
 * The backoff values below are the defaults used *once retry is enabled*;
 * they have no effect at `maxAttempts: 1`.
 */
export const DEFAULT_RETRY: Required<Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>> = {
  maxAttempts: 1,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
};

/** Attempts at or below this mean the caller has not opted into retry. */
export const RETRY_DISABLED_ATTEMPTS = 1;

/** True when the resolved options leave retry switched off. */
export function isRetryEnabled(maxAttempts: number): boolean {
  return maxAttempts > RETRY_DISABLED_ATTEMPTS;
}

/**
 * Default retryable-error classifier.
 *
 * Decision order (first match wins):
 *   1. HTTP status / statusCode property — authoritative when present.
 *      4xx (except 429) → not retryable; 429 and 5xx → retryable.
 *   2. errno-style `code` property (ECONNRESET, ETIMEDOUT, etc.) → retryable.
 *   3. Free-text message fallback — only consulted when neither status nor
 *      code matched. Looks for explicit substrings like "rate limit",
 *      "timed out", "socket hang up". We deliberately do NOT pattern-match
 *      bare 5xx digits in messages (too prone to false positives — e.g.
 *      "failed at 500ms timeout" would otherwise be classified retryable).
 *
 * Does NOT retry:
 *   - 401 / 403 (auth)
 *   - 400 / 404 / 422 (client/validation)
 *   - Anything classified as fatal by the agent provider (the scan runner
 *     handles FatalProviderError separately — those never reach this classifier).
 *   - Unknown errors (callers can pass a custom `isRetryable` to widen this).
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // Inspect error properties without coupling to a specific SDK
  const e = err as { name?: string; code?: string; status?: number; statusCode?: number; message?: string };

  // 0. Errors the rest of the system has already decided are terminal. This has
  //    to come first, and it has to be here rather than relying on the caller.
  //
  //    `claude-code-provider` raises FatalProviderError for quota exhaustion
  //    ("you've hit your limit" / 429) and for 401s, with the explicit reasoning
  //    that retrying cannot help — a subscription limit resets on a schedule,
  //    not in seconds. Those messages contain "rate limit", so the message
  //    fallback below would otherwise classify them as retryable and we would
  //    spend the remaining attempts re-hitting an exhausted quota.
  //
  //    BudgetExceededError is the same shape of decision: the scan has spent
  //    what it was allowed to spend, and retrying is precisely wrong.
  //
  //    Matched by name rather than instanceof so this holds for errors that
  //    crossed a serialization boundary and lost their prototype.
  if (e.name === 'FatalProviderError' || e.name === 'BudgetExceededError') return false;

  // 0b. aghast's own timeout guard. Classified explicitly rather than falling
  //     through to the message fallback below, so the decision is deliberate and
  //     testable rather than a side effect of the word "timeout" appearing in
  //     the text. Retryable: a hung stream often succeeds on a fresh call.
  if (e.name === 'AgentTimeoutError') return true;

  // 1. Status code (authoritative). If present, this short-circuits message inspection.
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false; // includes 401/403/422/etc
  }

  // 2. errno-style code (authoritative when present).
  const code = e.code;
  if (typeof code === 'string') {
    const retryableCodes = new Set([
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ENETUNREACH',
      'EPIPE',
      'ENOTFOUND',
    ]);
    if (retryableCodes.has(code)) return true;
  }

  // 3. Message-substring fallback. Only reached when neither status nor code
  // matched. Keep this list narrow — bare numeric ranges like "5xx" or `\d{3}`
  // are too easy to match incidentally (e.g. ports, byte counts). The `\b429\b`
  // pattern is the one numeric exception: providers that surface rate-limit
  // errors as plain text (e.g. "HTTP 429: too many requests") still need to
  // retry, and 429 with word-boundaries is unambiguous enough.
  const msg = (e.message ?? '').toLowerCase();
  if (msg.includes('rate limit') || /\b429\b/.test(msg)) return true;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;

  // Default: don't retry unknown errors. Better to surface unexpected failures than
  // to mask them by silently retrying — caller can pass a custom classifier if needed.
  return false;
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  /** Maximum consecutive total failures before tripping. Must be >= 1. */
  threshold: number;
}

/**
 * Thrown when aghast's own per-call guard fires because a provider call did not
 * return in time. Distinct from a provider-reported network timeout.
 *
 * Named rather than message-matched so the retry decision is deliberate: before
 * this existed, the classification depended on the word "timeout" appearing in
 * a free-text message, which is exactly the incidental matching the classifier
 * warns against elsewhere.
 *
 * It IS retryable — a hung stream frequently succeeds on a fresh call — but the
 * cost is visible: with `maxAttempts: n` a genuinely wedged provider takes up to
 * n × the timeout to give up. That trade is documented in
 * docs/configuration.md so anyone enabling retry knows what they are buying.
 */
export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

/** Thrown by `withRetry` when the breaker is open (failing fast). */
export class CircuitOpenError extends Error {
  constructor(consecutiveFailures: number, threshold: number) {
    super(
      `Circuit breaker open: ${consecutiveFailures} consecutive failures reached threshold ${threshold}. Failing fast — wrapped function will not be invoked.`,
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Process-level circuit breaker. Shared across all `withRetry` calls that
 * receive the same instance. Counts only TOTAL failures (after all retries
 * for a single call exhausted), not individual attempts.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  readonly threshold: number;

  constructor(options: CircuitBreakerOptions) {
    if (options.threshold < 1) {
      throw new Error(`CircuitBreaker threshold must be >= 1 (got ${options.threshold})`);
    }
    this.threshold = options.threshold;
  }

  /** True when the breaker is open (further calls should fail-fast). */
  isOpen(): boolean {
    return this.consecutiveFailures >= this.threshold;
  }

  /** Increment the failure counter. */
  recordFailure(): void {
    this.consecutiveFailures++;
  }

  /** Reset the failure counter. Called on any successful `withRetry` call. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Force-reset the counter (useful for tests or manual recovery). */
  reset(): void {
    this.consecutiveFailures = 0;
  }

  /** Current consecutive-failure count (for diagnostics/tests). */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

/** Compute the next backoff delay given an attempt number (1-based). */
export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  // Exponential growth: base * 2^(attempt-1), capped at maxDelayMs
  const exp = baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(maxDelayMs, exp);
  // Jitter factor in [0.5, 1.0)
  const jitter = 0.5 + random() * 0.5;
  return Math.floor(capped * jitter);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with retry on transient errors. Returns its result on success;
 * throws on the final failure (or `CircuitOpenError` if the breaker is open).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    isRetryable = defaultIsRetryable,
    breaker,
    sleep = defaultSleep,
    random = Math.random,
    label,
  } = options;

  if (maxAttempts < 1) {
    throw new Error(`withRetry: maxAttempts must be >= 1 (got ${maxAttempts})`);
  }

  if (breaker?.isOpen()) {
    throw new CircuitOpenError(breaker.getConsecutiveFailures(), breaker.threshold);
  }

  const prefix = label ? `[${label}] ` : '';

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-check breaker on each iteration so a concurrent caller tripping the
    // breaker mid-sleep aborts subsequent retries instead of pushing further
    // load onto a known-broken downstream. We do NOT count this fail-fast as
    // a fresh failure (the breaker already counted the failures that opened it).
    if (attempt > 1 && breaker?.isOpen()) {
      logDebug(
        TAG,
        `${prefix}Breaker opened during retry sleep; aborting further attempts.`,
      );
      throw new CircuitOpenError(breaker.getConsecutiveFailures(), breaker.threshold);
    }
    try {
      const result = await fn();
      breaker?.recordSuccess();
      return result;
    } catch (err) {
      lastError = err;
      const retryable = isRetryable(err);
      const isLast = attempt === maxAttempts;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!retryable || isLast) {
        if (!retryable) {
          logDebug(TAG, `${prefix}Non-retryable error on attempt ${attempt}: ${errMsg}`);
        } else {
          logDebug(TAG, `${prefix}Exhausted ${maxAttempts} attempts; final error: ${errMsg}`);
        }
        // Total failure for this call — increment breaker (if any) and rethrow.
        breaker?.recordFailure();
        throw err;
      }
      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs, random);
      logDebug(
        TAG,
        `${prefix}Attempt ${attempt}/${maxAttempts} failed (${errMsg}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws — but TypeScript doesn't know that.
  /* istanbul ignore next */
  throw lastError;
}
