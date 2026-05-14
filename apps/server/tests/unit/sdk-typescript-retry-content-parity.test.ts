// W422.B (W671-deepened) — drift guard for packages/sdk-typescript/
// src/retry.ts. Exponential-backoff retry policy reused by the SDK
// HTTP layer.
//
// W671 splits the original 11 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • CRITICAL Default policy pinned per-line: 4 total tries (3
//     retries + 1 initial) + 250ms initial backoff doubling up to
//     8s cap + full jitter + Retry-After honor + retry network/5xx
//     NOT 4xx (except 429). Drift to over-retrying 4xx would blast
//     the server with auth failures.
//   • DEFAULTS constant pinned per-field (maxAttempts:3 +
//     initialDelayMs:250 + maxDelayMs:8_000 with numeric separator).
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
//   • shouldRetry exhaustive 4-branch — RateLimitError true +
//     TransportError true + DriftstackError status>=500 true +
//     default false. Drift to retrying non-DriftstackError throws
//     would hide programmer errors behind 4 retry loops.
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
      /\/\/ Retry logic — exponential backoff with full jitter, with explicit support\s*\n?\s*\/\/ for 429 Retry-After\. Pure function over an attempt-producing closure;\s*\n?\s*\/\/ reused by the HTTP layer\./,
    );
  });

  it('CRITICAL default policy pinned per-line — 5 bullet points: (1) "Up to 3 retry attempts (4 total tries) on transient failures"; (2) "Initial backoff 250 ms, doubling each attempt, cap 8 s"; (3) "Random jitter in [0, computed delay] (full jitter)" — the "full jitter" wording matters because half-jitter / decorrelated-jitter / equal-jitter are alternative AWS-style policies; (4) "Honour Retry-After when the error is a RateLimitError or 429"; (5) "Retry on network errors and 5xx; do NOT retry on 4xx (except 429)". CRITICAL: bullet 5 is the load-bearing policy — drift to retrying 4xx would blast the server with auth failures.', () => {
    expect(body).toMatch(
      /\/\/ Default policy:\s*\n?\s*\/\/\s*- Up to 3 retry attempts \(4 total tries\) on transient failures\s*\n?\s*\/\/\s*- Initial backoff 250 ms, doubling each attempt, cap 8 s\s*\n?\s*\/\/\s*- Random jitter in \[0, computed delay\] \(full jitter\)\s*\n?\s*\/\/\s*- Honour Retry-After when the error is a RateLimitError or 429\s*\n?\s*\/\/\s*- Retry on network errors and 5xx; do NOT retry on 4xx \(except 429\)/,
    );
  });

  it('Imports — 3-error import (DriftstackError + RateLimitError + TransportError) from ./errors.js. CRITICAL: 3 error-class imports are load-bearing for the shouldRetry instanceof checks. Drift to dropping any would silently turn that error class into a non-retried error.', () => {
    expect(body).toMatch(
      /import \{ DriftstackError, RateLimitError, TransportError \} from '\.\/errors\.js';/,
    );
  });

  it('RetryConfig interface — 5-field shape with all OPTIONAL. JSDoc defaults pinned (3 / 250 / 8000) so customers can read the values without grep-ing the implementation. test-seam framing pinned on rng + sleep ("Test override") so future maintainers know NOT to surface these in production docs.', () => {
    expect(body).toMatch(
      /export interface RetryConfig \{\s*\n?\s*\/\*\* Max retry attempts \(in addition to the initial try\)\. Default 3\. \*\/\s*\n?\s*maxAttempts\?: number;\s*\n?\s*\/\*\* Initial backoff in ms\. Default 250\. \*\/\s*\n?\s*initialDelayMs\?: number;\s*\n?\s*\/\*\* Backoff cap in ms\. Default 8000\. \*\/\s*\n?\s*maxDelayMs\?: number;\s*\n?\s*\/\*\* Random source for jitter; defaults to Math\.random\. Test override\. \*\/\s*\n?\s*rng\?: \(\) => number;\s*\n?\s*\/\*\* Sleep function; defaults to setTimeout\. Test override\. \*\/\s*\n?\s*sleep\?: \(ms: number\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it('CRITICAL DEFAULTS constant — 3-field shape (maxAttempts:3 + initialDelayMs:250 + maxDelayMs:8_000). The numeric separator `8_000` is pinned (NOT `8000`) — it makes the value scannable at a glance. Drift to a higher maxDelayMs (e.g. 60_000) would let stuck flows wait full minutes between attempts.', () => {
    expect(body).toMatch(
      /const DEFAULTS = \{\s*\n?\s*maxAttempts: 3,\s*\n?\s*initialDelayMs: 250,\s*\n?\s*maxDelayMs: 8_000,\s*\n?\s*\};/,
    );
  });

  it('withRetry signature — async function with explicit generic `<T>`, `attempt: () => Promise<T>` closure parameter + `config: RetryConfig = {}` default-empty + `Promise<T>` return type. Drift to a non-generic return would force callers to type-assert the result; drift to required config would lose the zero-config default.', () => {
    expect(body).toMatch(
      /export async function withRetry<T>\(\s*\n?\s*attempt: \(\) => Promise<T>,\s*\n?\s*config: RetryConfig = \{\},\s*\n?\s*\): Promise<T> \{/,
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
      /try \{\s*\n?\s*return await attempt\(\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*lastErr = err;\s*\n?\s*if \(i === maxAttempts \|\| !shouldRetry\(err\)\) \{\s*\n?\s*throw err;\s*\n?\s*\}\s*\n?\s*const wait = computeDelay\(err, i, initialDelay, maxDelay, rng\);\s*\n?\s*await sleep\(wait\);\s*\n?\s*\}/,
    );
  });

  it('withRetry trailing unreachable throw — `// Unreachable — we either return or throw inside the loop.` + `throw lastErr;`. TypeScript requires the throw for type-narrowing (otherwise the function appears to return void at the end). Drift to removing the comment would leave a confusing unreachable statement; drift to removing the throw would make TS infer Promise<T | undefined>.', () => {
    expect(body).toMatch(
      /\/\/ Unreachable — we either return or throw inside the loop\.\s*\n?\s*throw lastErr;/,
    );
  });

  it('CRITICAL shouldRetry exhaustive 4-branch decision: (1) RateLimitError → true; (2) TransportError → true; (3) DriftstackError → status>=500 (5xx only, NOT 4xx — except 429 which already caught in branch 1); (4) default → false (programmer error or unrelated thrown value). Drift to making branch 4 true would retry ANY thrown value, hiding programmer errors. Drift to status>=400 in branch 3 would retry 4xx (auth failures, validation errors).', () => {
    expect(body).toMatch(
      /export function shouldRetry\(err: unknown\): boolean \{\s*\n?\s*if \(err instanceof RateLimitError\) return true;\s*\n?\s*if \(err instanceof TransportError\) return true;\s*\n?\s*if \(err instanceof DriftstackError\) \{\s*\n?\s*\/\/ Retry on 5xx; don't retry on 4xx \(except 429, handled above\)\.\s*\n?\s*return err\.status >= 500;\s*\n?\s*\}\s*\n?\s*\/\/ Anything that isn't a DriftstackError shouldn't be retried — it's a\s*\n?\s*\/\/ programmer error or unrelated thrown value\.\s*\n?\s*return false;\s*\n?\s*\}/,
    );
  });

  it('computeDelay signature — 5-parameter signature (err + attemptIndex + initialDelay + maxDelay + rng). Returns number (the delay in ms). Drift to a void return would force the caller to manage the sleep separately; drift to dropping initialDelay/maxDelay parameters would force computeDelay to read DEFAULTS directly (defeating the test-seam pattern).', () => {
    expect(body).toMatch(
      /function computeDelay\(\s*\n?\s*err: unknown,\s*\n?\s*attemptIndex: number,\s*\n?\s*initialDelay: number,\s*\n?\s*maxDelay: number,\s*\n?\s*rng: \(\) => number,\s*\n?\s*\): number \{/,
    );
  });

  it('CRITICAL computeDelay path 1 — RateLimitError with retryAfterSeconds>0 → `err.retryAfterSeconds * 1000 + Math.floor(rng() * 100)`. The "small jitter on top" framing pinned. Drift to dropping the ≤100ms jitter would let multiple clients hammering the same rate-limited endpoint all wake up at the EXACT same millisecond (thundering herd). Drift to scaling the jitter to retryAfterSeconds*1000 would over-shoot the server\'s hint.', () => {
    expect(body).toMatch(
      /if \(err instanceof RateLimitError && err\.retryAfterSeconds > 0\) \{\s*\n?\s*\/\/ Honour the server's hint with a small jitter on top\.\s*\n?\s*return err\.retryAfterSeconds \* 1000 \+ Math\.floor\(rng\(\) \* 100\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL computeDelay path 2 — full-jitter exponential: `const exp = Math.min(maxDelay, initialDelay * 2 ** attemptIndex); return Math.floor(rng() * exp);`. The 2 lines combined implement: (1) cap exponential growth at maxDelay, then (2) full-jitter in [0, exp]. Drift to `rng() * (max - initialDelay)` would change to equal-jitter (AWS variant) — different convergence characteristics under load.', () => {
    expect(body).toMatch(
      /const exp = Math\.min\(maxDelay, initialDelay \* 2 \*\* attemptIndex\);\s*\n?\s*return Math\.floor\(rng\(\) \* exp\);/,
    );
  });

  it("defaultSleep — setTimeout-backed Promise<void>. `new Promise((resolve) => setTimeout(resolve, ms))` 1-liner. Drift to using `clearTimeout` cleanup would over-engineer (the SDK doesn't support cancellation here). Drift to a queueMicrotask shim would skip the timer entirely.", () => {
    expect(body).toMatch(
      /function defaultSleep\(ms: number\): Promise<void> \{\s*\n?\s*return new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\);\s*\n?\s*\}/,
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
