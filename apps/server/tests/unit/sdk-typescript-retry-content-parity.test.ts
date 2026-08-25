// W422.B (W671-deepened) — drift guard for packages/sdk-typescript/
// src/retry.ts. Exponential-backoff retry policy reused by the SDK
// HTTP layer.
//
// W671 splits the original 11 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • CRITICAL Default policy pinned per-line: 4 total tries (3
//     retries + 1 initial) + 200ms initial backoff doubling up to
//     10s cap + full jitter + Retry-After honor + retry network/5xx
//     NOT 4xx (except 429). Drift to over-retrying 4xx would blast
//     the server with auth failures.
//   • DEFAULTS constant pinned per-field (maxAttempts:3 +
//     initialDelayMs:200 + maxDelayMs:10_000 with numeric separator).
//     Drift to a higher maxDelay would let stuck flows wait minutes.
//   • RetryConfig 5-field shape — 3 numeric defaults + 2 test-seam
//     overrides (rng + sleep). Test-seam framing pinned: "Test
//     override" comment lets future maintainers know NOT to expose
//     these in production docs.
//   • withRetry loop — for i in [0, maxAttempts] INCLUSIVE (so
//     when maxAttempts=3 the loop runs i=0,1,2,3 = 4 tries total).
//     Drift to exclusive would make maxAttempts:3 mean 3 total
//     tries (off-by-one). Trailing `throw lastErr` after loop is
//     unreachable but TypeScript requires it for type-narrowing.
//   • shouldRetry delegates to the public isRetryable() predicate
//     (one shared retry decision so the loop + the consumer-facing
//     predicate cannot drift). Retries ONLY transient kinds
//     (transport / internal / rate_limited); 4xx and the terminal
//     5xx kinds (DriverError 502 / DriverNotIntegrated 503 /
//     SessionTimeout 504) are NOT retried — parity with Go + Python.
//   • computeDelay 2-path:
//     - RateLimitError with retryAfterSeconds>0 → server-hint
//       (retryAfterSeconds*1000 + small ≤100ms jitter)
//     - else → full-jitter `floor(rng() * min(maxDelay, init *
//       2^attemptIndex))`. Drift to scaling rng() at full
//       computed-delay would multiply jitter into the backoff.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/retry.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W422.B packages/sdk-typescript/src/retry.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module framing pinned (exponential backoff with full jitter + explicit 429 Retry-After + pure function over attempt closure)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ Retry logic — exponential backoff with full jitter, with explicit support\s*\/\/ for 429 Retry-After\. Pure function over an attempt-producing closure;\s*\/\/ reused by the HTTP layer\./,
    );
  });

  it('CRITICAL default policy pinned per-line — 5 bullet points: (1) "Up to 3 retry attempts (4 total tries) on transient failures"; (2) "Initial backoff 200 ms, doubling each attempt, cap 10 s"; (3) "Random jitter in [0, computed delay] (full jitter)" — the "full jitter" wording matters because half-jitter / decorrelated-jitter / equal-jitter are alternative AWS-style policies; (4) "Honour Retry-After when the error is a RateLimitError or 429"; (5) "Retry ONLY transient kinds — transport / internal (5xx) / rate_limited; do NOT retry on 4xx (except 429), nor the terminal 5xx kinds DriverError/DriverNotIntegrated/SessionTimeout". CRITICAL: bullet 5 is the load-bearing policy — it delegates to isRetryable() so the loop and the public predicate cannot drift, and it keeps parity with the Go (IsRetryable) + Python (is_retryable) SDKs which retry ONLY the transient set (NOT blanket-5xx). Drift to retrying 4xx would blast the server with auth failures; drift to blanket-5xx would auto-retry terminal driver/timeout failures.', () => {
    expect(body).toMatch(
      /\/\/ Default policy \(kept in lockstep with the Python \+ Go SDKs —\s*\/\/\s*3 retries, 200 ms initial, 10 s cap\):\s*\/\/\s*- Up to 3 retry attempts \(4 total tries\) on transient failures\s*\/\/\s*- Initial backoff 200 ms, doubling each attempt, cap 10 s\s*\/\/\s*- Random jitter in \[0, computed delay\] \(full jitter\)\s*\/\/\s*- Honour Retry-After when the error is a RateLimitError or 429\s*\/\/\s*- Retry ONLY transient kinds — transport \(network\), internal \(5xx\),\s*\/\/\s*and rate_limited \(429\)\. do NOT retry on 4xx \(except 429\), and do\s*\/\/\s*NOT retry the terminal 5xx kinds DriverError \(502\),\s*\/\/\s*DriverNotIntegratedError \(503\), or SessionTimeoutError \(504\)/,
    );
  });

  it('Imports — RateLimitError (used by computeDelay for the Retry-After path) + isRetryable (shouldRetry delegates to it) from ./errors.js. CRITICAL: shouldRetry now reuses the public isRetryable() predicate so the built-in loop and the consumer-facing predicate cannot drift apart. Drift to re-implementing the retry decision inline would risk that divergence (the bug this fix closed: blanket status>=500 retried terminal DriverError/SessionTimeout).', () => {
    expect(body).toMatch(/import \{ RateLimitError, isRetryable \} from '\.\/errors\.js';/);
  });

  it('RetryConfig interface — 5-field shape with all OPTIONAL. JSDoc defaults pinned (3 / 200 / 10000) so customers can read the values without grep-ing the implementation. test-seam framing pinned on rng + sleep ("Test override") so future maintainers know NOT to surface these in production docs.', () => {
    expect(body).toMatch(
      /export interface RetryConfig \{\s*\/\*\* Max retry attempts \(in addition to the initial try\)\. Default 3\. \*\/\s*maxAttempts\?: number;\s*\/\*\* Initial backoff in ms\. Default 200\. \*\/\s*initialDelayMs\?: number;\s*\/\*\* Backoff cap in ms\. Default 10000\. \*\/\s*maxDelayMs\?: number;\s*\/\*\* Random source for jitter; defaults to Math\.random\. Test override\. \*\/\s*rng\?: \(\) => number;\s*\/\*\* Sleep function; defaults to setTimeout\. Test override\. \*\/\s*sleep\?: \(ms: number\) => Promise<void>;\s*\}/,
    );
  });

  it('CRITICAL DEFAULTS constant — 3-field shape (maxAttempts:3 + initialDelayMs:200 + maxDelayMs:10_000, unified across TS/Python/Go per the audit). The numeric separator `10_000` is pinned (NOT `10000`) — it makes the value scannable at a glance. Drift to a higher maxDelayMs (e.g. 60_000) would let stuck flows wait full minutes between attempts.', () => {
    expect(body).toMatch(
      /const DEFAULTS = \{\s*maxAttempts: 3,\s*initialDelayMs: 200,\s*maxDelayMs: 10_000,\s*\};/,
    );
  });

  it('withRetry signature — async function with explicit generic `<T>`, `attempt: () => Promise<T>` closure parameter + `config: RetryConfig = {}` default-empty + `Promise<T>` return type. Drift to a non-generic return would force callers to type-assert the result; drift to required config would lose the zero-config default.', () => {
    expect(body).toMatch(
      /export async function withRetry<T>\(\s*attempt: \(\) => Promise<T>,\s*config: RetryConfig = \{\},\s*\): Promise<T> \{/,
    );
  });

  it('withRetry config-with-fallbacks — 5 destructure-and-default lines (maxAttempts/initialDelay/maxDelay/rng/sleep) using `?? DEFAULTS.X` for the 3 numerics and `?? Math.random / defaultSleep` for the 2 callables. Drift to `||` instead of `??` would let `maxAttempts: 0` (a valid "don\'t retry" config) fall through to the default-3.', () => {
    expect(body).toMatch(/const maxAttempts = config\.maxAttempts \?\? DEFAULTS\.maxAttempts;/);
    expect(body).toMatch(
      /const initialDelay = config\.initialDelayMs \?\? DEFAULTS\.initialDelayMs;/,
    );
    expect(body).toMatch(/const maxDelay = config\.maxDelayMs \?\? DEFAULTS\.maxDelayMs;/);
    expect(body).toMatch(/const rng = config\.rng \?\? Math\.random;/);
    expect(body).toMatch(/const sleep = config\.sleep \?\? defaultSleep;/);
  });

  it('CRITICAL withRetry loop body — `for (let i = 0; i <= maxAttempts; i++)`. INCLUSIVE upper bound is load-bearing: when maxAttempts=3, the loop runs i=0,1,2,3 = 4 TOTAL tries (1 initial + 3 retries). Drift to `i < maxAttempts` (exclusive) would make maxAttempts:3 mean 3 total tries (off-by-one — customers expect maxAttempts to be the RETRY count, not the total).', () => {
    expect(body).toMatch(/for \(let i = 0; i <= maxAttempts; i\+\+\) \{/);
  });

  it("withRetry try-catch — return-await attempt() in try; capture err in lastErr + check `i === maxAttempts || !shouldRetry(err)` to throw; compute delay + sleep otherwise. The early-throw condition is OR — if EITHER we're out of attempts OR the error class is non-retryable, throw immediately (skip the sleep).", () => {
    expect(body).toMatch(
      /try \{\s*return await attempt\(\);\s*\} catch \(err\) \{\s*lastErr = err;\s*if \(i === maxAttempts \|\| !shouldRetry\(err\)\) \{\s*throw err;\s*\}\s*const wait = computeDelay\(err, i, initialDelay, maxDelay, rng\);\s*await sleep\(wait\);\s*\}/,
    );
  });

  it('withRetry trailing unreachable throw — `// Unreachable — we either return or throw inside the loop.` + `throw lastErr;`. TypeScript requires the throw for type-narrowing (otherwise the function appears to return void at the end). Drift to removing the comment would leave a confusing unreachable statement; drift to removing the throw would make TS infer Promise<T | undefined>.', () => {
    expect(body).toMatch(
      /\/\/ Unreachable — we either return or throw inside the loop\.\s*throw lastErr;/,
    );
  });

  it('CRITICAL shouldRetry delegates to the public isRetryable() — `return isRetryable(err);`. The loop and the consumer-facing predicate share ONE retry decision so they can never drift apart. isRetryable returns true ONLY for transient kinds (transport / internal / rate_limited): a 4xx (validation/auth/etc.) and the terminal 5xx kinds DriverError(502) / DriverNotIntegratedError(503) / SessionTimeoutError(504) are NOT retried — matching the Go (IsRetryable) + Python (is_retryable) SDKs. Drift back to an inline `status >= 500` blanket-retry would re-introduce the bug where idempotent calls auto-retried terminal driver/timeout failures.', () => {
    expect(body).toMatch(
      /export function shouldRetry\(err: unknown\): boolean \{\s*\n(?:\s*\/\/.*\n)*\s*return isRetryable\(err\);\s*\n\}/,
    );
  });

  it('computeDelay signature — 5-parameter signature (err + attemptIndex + initialDelay + maxDelay + rng). Returns number (the delay in ms). Drift to a void return would force the caller to manage the sleep separately; drift to dropping initialDelay/maxDelay parameters would force computeDelay to read DEFAULTS directly (defeating the test-seam pattern).', () => {
    expect(body).toMatch(
      /function computeDelay\(\s*err: unknown,\s*attemptIndex: number,\s*initialDelay: number,\s*maxDelay: number,\s*rng: \(\) => number,\s*\): number \{/,
    );
  });

  it('CRITICAL computeDelay path 1 — RateLimitError with retryAfterSeconds>0 → `Math.min(err.retryAfterSeconds * 1000, maxDelay) + Math.floor(rng() * 100)`. The server hint is CAPPED at maxDelay (cross-SDK parity with Go nextDelay + Python _backoff_delay_ms: `min(retryAfter, maxDelay)`) so a buggy / hostile `Retry-After: 86400` can\'t pin the SDK in a 24h sleep. The "small jitter on top" stays — dropping the ≤100ms jitter would let multiple clients hammering the same rate-limited endpoint all wake up at the EXACT same millisecond (thundering herd). Drift to scaling the jitter to retryAfterSeconds*1000 would over-shoot the server\'s hint.', () => {
    expect(body).toMatch(
      /if \(err instanceof RateLimitError && err\.retryAfterSeconds > 0\) \{[\s\S]*?return Math\.min\(err\.retryAfterSeconds \* 1000, maxDelay\) \+ Math\.floor\(rng\(\) \* 100\);\s*\}/,
    );
  });

  it('CRITICAL computeDelay path 2 — full-jitter exponential: `const exp = Math.min(maxDelay, initialDelay * 2 ** attemptIndex); return Math.floor(rng() * exp);`. The 2 lines combined implement: (1) cap exponential growth at maxDelay, then (2) full-jitter in [0, exp]. Drift to `rng() * (max - initialDelay)` would change to equal-jitter (AWS variant) — different convergence characteristics under load.', () => {
    expect(body).toMatch(
      /const exp = Math\.min\(maxDelay, initialDelay \* 2 \*\* attemptIndex\);\s*return Math\.floor\(rng\(\) \* exp\);/,
    );
  });

  it("defaultSleep — setTimeout-backed Promise<void>. `new Promise((resolve) => setTimeout(resolve, ms))` 1-liner. Drift to using `clearTimeout` cleanup would over-engineer (the SDK doesn't support cancellation here). Drift to a queueMicrotask shim would skip the timer entirely.", () => {
    expect(body).toMatch(
      /function defaultSleep\(ms: number\): Promise<void> \{\s*return new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\);\s*\}/,
    );
  });

  it('Exports inventory — exactly 3 exports: RetryConfig type + withRetry function + shouldRetry function. computeDelay + defaultSleep are INTERNAL (no export keyword). Drift to exporting computeDelay/defaultSleep would broaden the public surface to internal helpers that future refactors might rename.', () => {
    const exportMatches = body.match(/^export /gm) ?? [];
    expect(
      exportMatches.length,
      'expected exactly 3 exports (RetryConfig + withRetry + shouldRetry)',
    ).toBe(3);
    expect(body).toMatch(/export interface RetryConfig/);
    expect(body).toMatch(/export async function withRetry</);
    expect(body).toMatch(/export function shouldRetry\(/);
    // Internal helpers — must NOT be exported.
    expect(body).not.toMatch(/^export (?:async )?function (?:computeDelay|defaultSleep)/m);
  });
});
