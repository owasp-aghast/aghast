/**
 * Unit tests for src/retry.ts (withRetry, CircuitBreaker, defaultIsRetryable, computeBackoff).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withRetry,
  CircuitBreaker,
  CircuitOpenError,
  defaultIsRetryable,
  computeBackoff,
} from '../src/retry.js';
import { FatalProviderError } from '../src/types.js';
import { BudgetExceededError } from '../src/budget.js';

// ─── withRetry ────────────────────────────────────────────────────────────────

test('withRetry: succeeds on first attempt', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    sleep: async () => { /* no-op */ },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: fails N times then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('rate limit exceeded') as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    return 42;
  }, {
    maxAttempts: 5,
    baseDelayMs: 1,
    maxDelayMs: 10,
    sleep: async () => { /* no-op */ },
  });
  assert.equal(result, 42);
  assert.equal(calls, 3);
});

test('withRetry: throws after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const err = new Error('rate limit') as Error & { status?: number };
      err.status = 429;
      throw err;
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      sleep: async () => { /* no-op */ },
    }),
    /rate limit/,
  );
  assert.equal(calls, 3);
});

test('withRetry: does NOT retry on non-retryable errors (401)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const err = new Error('unauthorized') as Error & { status?: number };
      err.status = 401;
      throw err;
    }, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
      sleep: async () => { /* no-op */ },
    }),
    /unauthorized/,
  );
  assert.equal(calls, 1, 'auth errors should not be retried');
});

test('withRetry: custom isRetryable overrides default', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 2) throw new Error('always retry me');
    return 'done';
  }, {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 10,
    isRetryable: () => true,
    sleep: async () => { /* no-op */ },
  });
  assert.equal(result, 'done');
  assert.equal(calls, 2);
});

test('withRetry: backoff delays grow between attempts', async () => {
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const err = new Error('timeout');
      throw err;
    }, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      sleep,
      // Deterministic jitter: always returns 1.0 (no jitter cap), so delays are exactly base*2^(n-1).
      random: () => 1 - Number.EPSILON,
    }),
  );
  // 3 retries -> 3 sleeps. Expected approximate delays: 100, 200, 400.
  assert.equal(delays.length, 3);
  assert.ok(delays[0] >= 50 && delays[0] <= 100);
  assert.ok(delays[1] >= 100 && delays[1] <= 200);
  assert.ok(delays[2] >= 200 && delays[2] <= 400);
  assert.ok(delays[1] > delays[0], `delay ${delays[1]} should be > ${delays[0]}`);
  assert.ok(delays[2] > delays[1], `delay ${delays[2]} should be > ${delays[1]}`);
  assert.equal(calls, 4);
});

test('withRetry: maxAttempts < 1 throws', async () => {
  await assert.rejects(
    withRetry(async () => 'never', {
      maxAttempts: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => { /* no-op */ },
    }),
    /maxAttempts must be >= 1/,
  );
});

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

test('CircuitBreaker: trips after threshold consecutive failures', async () => {
  const breaker = new CircuitBreaker({ threshold: 2 });
  // First call: fails all retries → recordFailure() bumps to 1
  await assert.rejects(
    withRetry(async () => {
      const err = new Error('rate limit') as Error & { status?: number };
      err.status = 429;
      throw err;
    }, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep: async () => { /* no-op */ },
    }),
    /rate limit/,
  );
  assert.equal(breaker.getConsecutiveFailures(), 1);
  assert.equal(breaker.isOpen(), false);

  // Second call: same → bumps to 2, breaker opens
  await assert.rejects(
    withRetry(async () => {
      const err = new Error('rate limit') as Error & { status?: number };
      err.status = 429;
      throw err;
    }, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep: async () => { /* no-op */ },
    }),
    /rate limit/,
  );
  assert.equal(breaker.isOpen(), true);

  // Third call: fail-fast with CircuitOpenError, fn never invoked
  let invoked = false;
  await assert.rejects(
    withRetry(async () => { invoked = true; return 'should not run'; }, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep: async () => { /* no-op */ },
    }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  assert.equal(invoked, false);
});

test('CircuitBreaker: success resets the counter', async () => {
  const breaker = new CircuitBreaker({ threshold: 3 });
  await assert.rejects(
    withRetry(async () => {
      const err = new Error('rate limit') as Error & { status?: number };
      err.status = 429;
      throw err;
    }, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep: async () => { /* no-op */ },
    }),
    /rate limit/,
  );
  assert.equal(breaker.getConsecutiveFailures(), 1);

  const result = await withRetry(async () => 'success', {
    maxAttempts: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    breaker,
    sleep: async () => { /* no-op */ },
  });
  assert.equal(result, 'success');
  assert.equal(breaker.getConsecutiveFailures(), 0);
});

test('CircuitBreaker: threshold < 1 rejected', () => {
  assert.throws(() => new CircuitBreaker({ threshold: 0 }), /threshold must be >= 1/);
});

test('CircuitBreaker: reset clears counter', () => {
  const breaker = new CircuitBreaker({ threshold: 2 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), true);
  breaker.reset();
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.getConsecutiveFailures(), 0);
});

test('CircuitBreaker: pre-tripped breaker fail-fasts before invoking fn', async () => {
  const breaker = new CircuitBreaker({ threshold: 2 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), true);

  let invoked = false;
  await assert.rejects(
    withRetry(async () => { invoked = true; return 'should not run'; }, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep: async () => { /* no-op */ },
    }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  assert.equal(invoked, false, 'fn must not be invoked when breaker is open at entry');
});

test('withRetry: aborts mid-loop when concurrent caller trips the breaker during sleep', async () => {
  const breaker = new CircuitBreaker({ threshold: 1 });
  let calls = 0;
  // Use a sleep override that trips the breaker while we're "sleeping",
  // simulating a concurrent withRetry call that recorded a fatal failure.
  const sleep = async () => {
    breaker.recordFailure(); // trips the breaker (threshold=1)
  };
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const err = new Error('rate limit') as Error & { status?: number };
      err.status = 429;
      throw err;
    }, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      breaker,
      sleep,
    }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  // First attempt runs, fails, sleeps (during which breaker trips), second iteration
  // detects the open breaker and throws CircuitOpenError without invoking fn again.
  assert.equal(calls, 1, 'fn should only run once before the breaker aborts the retry loop');
  // The fail-fast path must NOT increment the breaker further — only the in-loop
  // catch records failures. The sleep override recorded one failure (which tripped
  // the breaker); the abort path should not double-count.
  assert.equal(
    breaker.getConsecutiveFailures(),
    1,
    'CircuitOpenError abort path must not record an additional failure',
  );
});

// ─── defaultIsRetryable ───────────────────────────────────────────────────────

test('defaultIsRetryable: 429 is retryable', () => {
  assert.equal(defaultIsRetryable({ status: 429 }), true);
});

test('defaultIsRetryable: 500-599 are retryable', () => {
  assert.equal(defaultIsRetryable({ status: 500 }), true);
  assert.equal(defaultIsRetryable({ status: 503 }), true);
  assert.equal(defaultIsRetryable({ status: 599 }), true);
});

test('defaultIsRetryable: 401/403 are NOT retryable', () => {
  assert.equal(defaultIsRetryable({ status: 401 }), false);
  assert.equal(defaultIsRetryable({ status: 403 }), false);
});

test('defaultIsRetryable: 400/404/422 are NOT retryable', () => {
  assert.equal(defaultIsRetryable({ status: 400 }), false);
  assert.equal(defaultIsRetryable({ status: 404 }), false);
  assert.equal(defaultIsRetryable({ status: 422 }), false);
});

test('defaultIsRetryable: ECONNRESET / ETIMEDOUT retryable', () => {
  assert.equal(defaultIsRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(defaultIsRetryable({ code: 'ETIMEDOUT' }), true);
  assert.equal(defaultIsRetryable({ code: 'EAI_AGAIN' }), true);
  assert.equal(defaultIsRetryable({ code: 'ENOTFOUND' }), true);
});

test('defaultIsRetryable: timeout messages retryable', () => {
  assert.equal(defaultIsRetryable(new Error('Agent provider timed out after 300s')), true);
  assert.equal(defaultIsRetryable(new Error('socket hang up')), true);
});

test('defaultIsRetryable: 429 in message text (no status field) is retryable', () => {
  // Providers that surface rate-limit errors as plain text without setting
  // err.status / err.statusCode still need to be retryable.
  assert.equal(defaultIsRetryable(new Error('HTTP 429: too many requests')), true);
  // Word-boundary guard: "4290" or "429th" should not match.
  assert.equal(defaultIsRetryable(new Error('saw 4290ms latency on the wire')), false);
});

test('defaultIsRetryable: bare 500-style numbers in message do NOT trigger retry', () => {
  // Without "rate limit" / "timed out" / errno-code / status field, a numeric
  // mention like "got status 500 from upstream" must NOT be classified retryable.
  // (Real 5xx errors should set err.status; the message-text path is intentionally narrow.)
  assert.equal(defaultIsRetryable(new Error('got status 500 from upstream')), false);
});

test('defaultIsRetryable: unknown errors NOT retryable by default', () => {
  assert.equal(defaultIsRetryable(new Error('something weird happened')), false);
  assert.equal(defaultIsRetryable(null), false);
  assert.equal(defaultIsRetryable(undefined), false);
});

// ─── computeBackoff ───────────────────────────────────────────────────────────

test('computeBackoff: caps at maxDelayMs', () => {
  // attempt 10 -> 1000 * 2^9 = 512000, but capped at 5000
  const d = computeBackoff(10, 1000, 5000, () => 1 - Number.EPSILON);
  assert.ok(d <= 5000, `expected <= 5000, got ${d}`);
  assert.ok(d >= 2500, `expected >= 2500 (jitter floor), got ${d}`);
});

test('computeBackoff: jitter in [0.5, 1.0)', () => {
  const lo = computeBackoff(1, 1000, 100000, () => 0);
  const hi = computeBackoff(1, 1000, 100000, () => 1 - Number.EPSILON);
  assert.equal(lo, 500);
  assert.ok(hi <= 1000);
  assert.ok(hi >= 999);
});

// ─── Errors the system has already decided are terminal ──────────────────────
//
// These matter because their *messages* look retryable. `claude-code-provider`
// raises FatalProviderError for quota exhaustion with text like
// "you've hit your limit", and the message fallback in defaultIsRetryable
// matches "rate limit". Without an explicit guard the classifier would retry an
// exhausted quota until it ran out of attempts.

test('defaultIsRetryable: FatalProviderError is never retried, despite a rate-limit message', () => {
  const err = new FatalProviderError('Agent provider rate limit reached: you\'ve hit your limit');
  // Premise: the message alone would otherwise be classified retryable.
  assert.equal(defaultIsRetryable(new Error(err.message)), true);
  // Guard: the fatal classification wins.
  assert.equal(defaultIsRetryable(err), false);
});

test('defaultIsRetryable: BudgetExceededError is never retried', () => {
  const err = new BudgetExceededError('Budget limit exceeded: timed out waiting for spend');
  assert.equal(defaultIsRetryable(new Error(err.message)), true);
  assert.equal(defaultIsRetryable(err), false);
});

test('defaultIsRetryable: fatal errors are matched by name across a realm boundary', () => {
  // Errors that crossed a serialization boundary lose their prototype, so
  // instanceof would not hold. Name-matching still does.
  const plain = Object.assign(new Error('rate limit exceeded'), { name: 'FatalProviderError' });
  assert.equal(defaultIsRetryable(plain), false);
});

test('withRetry: a fatal error is surfaced on the first attempt without retrying', async () => {
  let calls = 0;
  const sleep = async (): Promise<void> => { throw new Error('sleep should not be called'); };
  await assert.rejects(
    () => withRetry(
      async () => {
        calls++;
        throw new FatalProviderError('Agent provider authentication failed (401)');
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep },
    ),
    /authentication failed/,
  );
  assert.equal(calls, 1, 'fatal errors must not consume retry attempts');
});
