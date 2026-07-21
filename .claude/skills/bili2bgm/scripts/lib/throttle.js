// Sequential rate limiting: every request is separated by base + U(0, 0.6·base)
// (spec.md §2). The jitter is mandatory — an evenly spaced request sequence is
// itself a fingerprint.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** base + U(0, 0.6·base), rounded to whole milliseconds */
export function jitter(baseMs) {
  return Math.round(baseMs + Math.random() * 0.6 * baseMs);
}

/**
 * Single-flight throttle: serializes calls into one queue and keeps at least
 * jitter(baseMs) between consecutive runs. The first call does not wait.
 */
export function createThrottle(baseMs, { log } = {}) {
  let chain = Promise.resolve();
  let first = true;

  return function throttled(fn) {
    const run = chain.then(async () => {
      if (first) {
        first = false;
      } else {
        const wait = jitter(baseMs);
        if (log) log(`  … sleep ${wait}ms`);
        await sleep(wait);
      }
      return fn();
    });
    // A single failure must not break the queue, but it still reaches the caller.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
