// W422.B — drift guard for packages/sdk-typescript/src/retry.ts.
// Exponential-backoff retry policy reused by the SDK HTTP layer.
// Drift here either over-retries (4xx blasted in a tight loop) or
// silently swallows 429 Retry-After (rate-limit ceiling violated).
//
//   • Framing pinned: exponential backoff with full jitter +
//     explicit Retry-After (429) handling.
//   • DEFAULTS pinned: maxAttempts:3 + initialDelayMs:250 +
//     maxDelayMs:8000.
//   • shouldRetry exhaustive: RateLimitError true + TransportError
//     true + DriftstackError status>=500 + everything else false.
//   • computeDelay: RateLimitError honor retryAfterSeconds*1000 +
//     small jitter; else floor(rng() * min(maxDelay, init * 2^i)).
//   • defaultSleep: setTimeout-backed Promise.

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

  it('Framing pinned: exponential backoff with full jitter + explicit 429 Retry-After support; pure function over an attempt closure', () => {
    expect(body).toMatch(
      /\/\/ Retry logic — exponential backoff with full jitter, with explicit support\s*\n?\s*\/\/ for 429 Retry-After\. Pure function over an attempt-producing closure;\s*\n?\s*\/\/ reused by the HTTP layer\./,
    );
  });

  it('Default policy pinned: up to 3 retry attempts / 4 total tries on transient failures; initial 250ms doubling cap 8s; full jitter; honour Retry-After on RateLimitError or 429; retry network+5xx; not 4xx except 429', () => {
    expect(body).toMatch(
      /\/\/ Default policy:\s*\n?\s*\/\/\s*- Up to 3 retry attempts \(4 total tries\) on transient failures\s*\n?\s*\/\/\s*- Initial backoff 250 ms, doubling each attempt, cap 8 s\s*\n?\s*\/\/\s*- Random jitter in \[0, computed delay\] \(full jitter\)\s*\n?\s*\/\/\s*- Honour Retry-After when the error is a RateLimitError or 429\s*\n?\s*\/\/\s*- Retry on network errors and 5xx; do NOT retry on 4xx \(except 429\)/,
    );
  });

  it("imports: DriftstackError + RateLimitError + TransportError from './errors.js'", () => {
    expect(body).toMatch(
      /import \{ DriftstackError, RateLimitError, TransportError \} from '\.\/errors\.js';/,
    );
  });

  it('RetryConfig interface: maxAttempts/initialDelayMs/maxDelayMs (number) + rng (Math.random override) + sleep (setTimeout override) — all optional', () => {
    expect(body).toMatch(
      /export interface RetryConfig \{\s*\n?\s*\/\*\* Max retry attempts \(in addition to the initial try\)\. Default 3\. \*\/\s*\n?\s*maxAttempts\?: number;\s*\n?\s*\/\*\* Initial backoff in ms\. Default 250\. \*\/\s*\n?\s*initialDelayMs\?: number;\s*\n?\s*\/\*\* Backoff cap in ms\. Default 8000\. \*\/\s*\n?\s*maxDelayMs\?: number;\s*\n?\s*\/\*\* Random source for jitter; defaults to Math\.random\. Test override\. \*\/\s*\n?\s*rng\?: \(\) => number;\s*\n?\s*\/\*\* Sleep function; defaults to setTimeout\. Test override\. \*\/\s*\n?\s*sleep\?: \(ms: number\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it('DEFAULTS pinned: maxAttempts 3 + initialDelayMs 250 + maxDelayMs 8_000', () => {
    expect(body).toMatch(
      /const DEFAULTS = \{\s*\n?\s*maxAttempts: 3,\s*\n?\s*initialDelayMs: 250,\s*\n?\s*maxDelayMs: 8_000,\s*\n?\s*\};/,
    );
  });

  it('withRetry<T>: signature (attempt, config={}) => Promise<T>; pulls config with DEFAULTS fallbacks; rng=Math.random; sleep=defaultSleep', () => {
    expect(body).toMatch(
      /export async function withRetry<T>\(\s*\n?\s*attempt: \(\) => Promise<T>,\s*\n?\s*config: RetryConfig = \{\},\s*\n?\s*\): Promise<T> \{/,
    );
    expect(body).toMatch(/const maxAttempts = config\.maxAttempts \?\? DEFAULTS\.maxAttempts;/);
    expect(body).toMatch(
      /const initialDelay = config\.initialDelayMs \?\? DEFAULTS\.initialDelayMs;/,
    );
    expect(body).toMatch(/const maxDelay = config\.maxDelayMs \?\? DEFAULTS\.maxDelayMs;/);
    expect(body).toMatch(/const rng = config\.rng \?\? Math\.random;/);
    expect(body).toMatch(/const sleep = config\.sleep \?\? defaultSleep;/);
  });

  it('withRetry loop: for i in [0, maxAttempts] inclusive; throw on last attempt or !shouldRetry; computeDelay then sleep; unreachable trailing throw lastErr', () => {
    expect(body).toMatch(
      /for \(let i = 0; i <= maxAttempts; i\+\+\) \{\s*\n?\s*try \{\s*\n?\s*return await attempt\(\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*lastErr = err;\s*\n?\s*if \(i === maxAttempts \|\| !shouldRetry\(err\)\) \{\s*\n?\s*throw err;\s*\n?\s*\}\s*\n?\s*const wait = computeDelay\(err, i, initialDelay, maxDelay, rng\);\s*\n?\s*await sleep\(wait\);\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*\/\/ Unreachable — we either return or throw inside the loop\.\s*\n?\s*throw lastErr;/,
    );
  });

  it('shouldRetry exhaustive: RateLimitError true + TransportError true + DriftstackError status>=500 + default false (programmer/unrelated)', () => {
    expect(body).toMatch(
      /export function shouldRetry\(err: unknown\): boolean \{\s*\n?\s*if \(err instanceof RateLimitError\) return true;\s*\n?\s*if \(err instanceof TransportError\) return true;\s*\n?\s*if \(err instanceof DriftstackError\) \{\s*\n?\s*\/\/ Retry on 5xx; don't retry on 4xx \(except 429, handled above\)\.\s*\n?\s*return err\.status >= 500;\s*\n?\s*\}\s*\n?\s*\/\/ Anything that isn't a DriftstackError shouldn't be retried — it's a\s*\n?\s*\/\/ programmer error or unrelated thrown value\.\s*\n?\s*return false;\s*\n?\s*\}/,
    );
  });

  it('computeDelay: RateLimitError + retryAfterSeconds>0 -> retryAfterSeconds*1000 + floor(rng()*100); else floor(rng() * min(maxDelay, initialDelay * 2**attemptIndex))', () => {
    expect(body).toMatch(
      /function computeDelay\(\s*\n?\s*err: unknown,\s*\n?\s*attemptIndex: number,\s*\n?\s*initialDelay: number,\s*\n?\s*maxDelay: number,\s*\n?\s*rng: \(\) => number,\s*\n?\s*\): number \{/,
    );
    expect(body).toMatch(
      /if \(err instanceof RateLimitError && err\.retryAfterSeconds > 0\) \{\s*\n?\s*\/\/ Honour the server's hint with a small jitter on top\.\s*\n?\s*return err\.retryAfterSeconds \* 1000 \+ Math\.floor\(rng\(\) \* 100\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const exp = Math\.min\(maxDelay, initialDelay \* 2 \*\* attemptIndex\);\s*\n?\s*return Math\.floor\(rng\(\) \* exp\);/,
    );
  });

  it('defaultSleep: setTimeout-backed Promise<void>', () => {
    expect(body).toMatch(
      /function defaultSleep\(ms: number\): Promise<void> \{\s*\n?\s*return new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
