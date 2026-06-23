// Retry logic — exponential backoff with full jitter, with explicit support
// for 429 Retry-After. Pure function over an attempt-producing closure;
// reused by the HTTP layer.
//
// Default policy (kept in lockstep with the Python + Go SDKs —
// 3 retries, 200 ms initial, 10 s cap):
//   - Up to 3 retry attempts (4 total tries) on transient failures
//   - Initial backoff 200 ms, doubling each attempt, cap 10 s
//   - Random jitter in [0, computed delay] (full jitter)
//   - Honour Retry-After when the error is a RateLimitError or 429
//   - Retry on network errors and 5xx; do NOT retry on 4xx (except 429)
//
// NOTE: retry-SAFETY (whether a request may be auto-retried at all) lives
// in the HTTP layer, not here — this loop is request-agnostic. The HTTP
// layer only runs it for idempotent methods (GET/HEAD/PUT/DELETE) or for
// POST/PATCH that carry an Idempotency-Key, so a transient 5xx can never
// double-submit a non-idempotent create. See `http.ts`.

import { DriftstackError, RateLimitError, TransportError } from './errors.js';

export interface RetryConfig {
  /** Max retry attempts (in addition to the initial try). Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 200. */
  initialDelayMs?: number;
  /** Backoff cap in ms. Default 10000. */
  maxDelayMs?: number;
  /** Random source for jitter; defaults to Math.random. Test override. */
  rng?: () => number;
  /** Sleep function; defaults to setTimeout. Test override. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
};

export async function withRetry<T>(
  attempt: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? DEFAULTS.maxAttempts;
  const initialDelay = config.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxDelay = config.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const rng = config.rng ?? Math.random;
  const sleep = config.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let i = 0; i <= maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i === maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      const wait = computeDelay(err, i, initialDelay, maxDelay, rng);
      await sleep(wait);
    }
  }
  // Unreachable — we either return or throw inside the loop.
  throw lastErr;
}

export function shouldRetry(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof TransportError) return true;
  if (err instanceof DriftstackError) {
    // Retry on 5xx; don't retry on 4xx (except 429, handled above).
    return err.status >= 500;
  }
  // Anything that isn't a DriftstackError shouldn't be retried — it's a
  // programmer error or unrelated thrown value.
  return false;
}

function computeDelay(
  err: unknown,
  attemptIndex: number,
  initialDelay: number,
  maxDelay: number,
  rng: () => number,
): number {
  if (err instanceof RateLimitError && err.retryAfterSeconds > 0) {
    // Honour the server's hint with a small jitter on top.
    return err.retryAfterSeconds * 1000 + Math.floor(rng() * 100);
  }
  const exp = Math.min(maxDelay, initialDelay * 2 ** attemptIndex);
  return Math.floor(rng() * exp);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
