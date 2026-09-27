"use strict";

// Retry with exponential backoff + jitter. `sleep` and `jitter` are injectable
// so tests can run the full backoff schedule instantly and deterministically.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, opts = {}) {
  const tries = Math.max(1, opts.tries ?? 3);
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? Math.random;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const onRetry = opts.onRetry;

  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !shouldRetry(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      // Full jitter: spread retries so all four platforms don't stampede together.
      const delay = Math.round(backoff * (0.5 + 0.5 * jitter()));
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// fetch() with a hard timeout. Node's fetch has no default one, and a hung
// request is exactly how the poll loop wedges without the process dying.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...options, signal });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      const e = new Error(`timeout after ${timeoutMs}ms: ${url}`);
      e.code = "ETIMEDOUT";
      throw e;
    }
    throw err;
  }
}

module.exports = { withRetry, fetchWithTimeout, defaultSleep };
