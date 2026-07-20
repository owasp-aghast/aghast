/**
 * Shared concurrency utilities for the scan runner and judge stage.
 */

/** Handle for signaling abort to mapWithConcurrency workers. */
export interface AbortHandle {
  aborted: boolean;
  reason?: Error;
}

/**
 * Run an async function over items with bounded concurrency.
 * Spawns min(concurrency, items.length) workers that pull from a shared index.
 * Results are written to a pre-allocated array to preserve input order.
 *
 * If abortHandle is provided, workers stop picking up new items once
 * abortHandle.aborted is set to true. In-flight items complete naturally.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  abortHandle?: AbortHandle,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (abortHandle?.aborted) break;
      // Safe without atomics: Node.js is single-threaded, so nextIndex++ is
      // not interleaved — each worker awaits before looping, yielding to the
      // event loop where the next worker reads and increments the same variable.
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  // Use allSettled so in-flight items complete before we propagate errors
  const settled = await Promise.allSettled(workers);
  const firstRejection = settled.find((r) => r.status === 'rejected');
  if (firstRejection && firstRejection.status === 'rejected') {
    throw firstRejection.reason;
  }

  return results;
}
