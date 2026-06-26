import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  DriftstackError,
  errorFromProblem,
  isRetryable,
  TransportError,
} from '../../src/errors.js';
import { shouldRetry, withRetry } from '../../src/retry.js';

describe('shouldRetry', () => {
  it('retries TransportError', () => {
    expect(shouldRetry(new TransportError('boom'))).toBe(true);
  });

  it('retries RateLimitError', () => {
    const e = errorFromProblem({ type: PROBLEM_TYPES.RateLimited, title: 'x', status: 429 }, null);
    expect(shouldRetry(e)).toBe(true);
  });

  it('retries 5xx', () => {
    const e = errorFromProblem({ type: PROBLEM_TYPES.Internal, title: 'x', status: 500 }, null);
    expect(shouldRetry(e)).toBe(true);
  });

  it('does NOT retry 4xx (other than 429)', () => {
    const e = errorFromProblem({ type: PROBLEM_TYPES.NotFound, title: 'x', status: 404 }, null);
    expect(shouldRetry(e)).toBe(false);
    const v = errorFromProblem(
      { type: PROBLEM_TYPES.ValidationFailed, title: 'x', status: 400 },
      null,
    );
    expect(shouldRetry(v)).toBe(false);
  });

  it('does NOT retry the terminal 5xx kinds (502 DriverError / 503 DriverNotIntegrated / 504 SessionTimeout)', () => {
    // Regression: shouldRetry once blanket-retried any DriftstackError
    // with status >= 500, which contradicted the public isRetryable()
    // (driver_error / driver_not_integrated / session_timeout are NOT
    // retryable) and diverged from the Go + Python SDKs. shouldRetry now
    // delegates to isRetryable, so these terminal 5xx errors are NOT
    // auto-retried.
    const driver = errorFromProblem(
      { type: PROBLEM_TYPES.DriverError, title: 'x', status: 502 },
      null,
    );
    expect(shouldRetry(driver)).toBe(false);

    const notIntegrated = errorFromProblem(
      { type: PROBLEM_TYPES.DriverNotIntegrated, title: 'x', status: 503 },
      null,
    );
    expect(shouldRetry(notIntegrated)).toBe(false);

    const timeout = errorFromProblem(
      { type: PROBLEM_TYPES.SessionTimeout, title: 'x', status: 504 },
      null,
    );
    expect(shouldRetry(timeout)).toBe(false);
  });

  it('agrees with the public isRetryable() predicate (shouldRetry === isRetryable, no drift)', () => {
    for (const uri of Object.values(PROBLEM_TYPES)) {
      const e = errorFromProblem({ type: uri, title: 'x', status: 400 }, null);
      expect(shouldRetry(e)).toBe(isRetryable(e));
    }
    expect(shouldRetry(new TransportError('boom'))).toBe(isRetryable(new TransportError('boom')));
  });

  it('does NOT retry non-DriftstackError values', () => {
    expect(shouldRetry(new Error('oops'))).toBe(false);
    expect(shouldRetry('string err')).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const got = await withRetry(fn);
    expect(got).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on TransportError up to maxAttempts, then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('down'));
    const sleeps: number[] = [];
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        rng: () => 0.5,
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(sleeps).toHaveLength(3);
  });

  it('honours RateLimitError.retryAfterSeconds', async () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.RateLimited,
        title: 'x',
        status: 429,
        retry_after_seconds: 2,
      },
      null,
    );
    const fn = vi.fn().mockRejectedValueOnce(e).mockResolvedValueOnce('ok');
    const sleeps: number[] = [];
    const got = await withRetry(fn, {
      maxAttempts: 1,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      rng: () => 0,
    });
    expect(got).toBe('ok');
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]).toBeLessThan(2200);
  });

  it('caps RateLimitError.retryAfterSeconds at maxDelayMs (parity with Go/Python — no 24h sleep)', async () => {
    // Server (or a buggy proxy) asks for a 1-hour wait; the SDK must clamp
    // it to maxDelay so it never sleeps pathologically long.
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.RateLimited,
        title: 'x',
        status: 429,
        retry_after_seconds: 3600,
      },
      null,
    );
    const fn = vi.fn().mockRejectedValueOnce(e).mockResolvedValueOnce('ok');
    const sleeps: number[] = [];
    const got = await withRetry(fn, {
      maxAttempts: 1,
      maxDelayMs: 10_000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      rng: () => 0,
    });
    expect(got).toBe('ok');
    // Clamped to maxDelay (10s) + 0 jitter (rng=0), NOT 3_600_000ms.
    expect(sleeps[0]).toBe(10_000);
  });

  it('does not retry on non-retryable errors', async () => {
    const e = new DriftstackError({
      kind: 'not_found',
      status: 404,
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
    });
    const fn = vi.fn().mockRejectedValue(e);
    await expect(withRetry(fn, { maxAttempts: 5 })).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exponential backoff doubles each attempt (full jitter capped)', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('down'));
    const sleeps: number[] = [];
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        rng: () => 1.0, // max jitter
      }),
    ).rejects.toBeInstanceOf(TransportError);
    // delays: ~100, ~200, ~400 (full jitter at rng=1.0 → upper bound)
    expect(sleeps[0]).toBeGreaterThanOrEqual(99);
    expect(sleeps[0]).toBeLessThanOrEqual(101);
    expect(sleeps[1]).toBeGreaterThanOrEqual(199);
    expect(sleeps[1]).toBeLessThanOrEqual(201);
    expect(sleeps[2]).toBeGreaterThanOrEqual(399);
    expect(sleeps[2]).toBeLessThanOrEqual(401);
  });
});
