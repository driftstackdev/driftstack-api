// W588.B — drift guard for packages/sdk-go/retry.go.
// Exponential-backoff retry with full jitter. Drift here either
// breaks Retry-After honouring or loses the ctx-aborts-between-
// attempts invariant.
//
//   • RetryConfig: MaxRetries + InitialDelay + MaxDelay +
//     BackoffMultiplier (default 2.0) + Disabled flag.
//   • DefaultRetry(): 3 retries, 200ms–10s window.
//   • withRetry: TransportError + RateLimitError retried; everything
//     else propagates; ctx cancellation aborts between attempts.
//   • isRetryable: errors.As on TransportError + RateLimitError.
//   • retryAfterFromErr: pulls RateLimitError.RetryAfterSeconds.
//   • nextDelay: Retry-After wins (capped at MaxDelay); otherwise
//     rand.Int63n full jitter capped at MaxDelay.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/retry.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W588.B packages/sdk-go/retry.go content parity', () => {
  const body = read(LIB);

  it('RetryConfig struct: MaxRetries + InitialDelay + MaxDelay + BackoffMultiplier + Disabled fields with framing comments pinned', () => {
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ RetryConfig tunes the exponential-backoff retry loop\./);
    expect(body).toMatch(/^type RetryConfig struct \{$/m);
    expect(body).toMatch(/\/\/ MaxRetries is the number of additional attempts after the first/);
    expect(body).toMatch(/\/\/ failure\. 3 means up to 4 total tries\./);
    expect(body).toMatch(/^\s*MaxRetries int$/m);
    expect(body).toMatch(/\/\/ InitialDelay is the base for the exponential backoff\./);
    expect(body).toMatch(/\/\/ sleep is uniformly random in \[0, InitialDelay \* 2\^attempt\],/);
    expect(body).toMatch(/\/\/ capped at MaxDelay\./);
    expect(body).toMatch(/^\s*InitialDelay time\.Duration$/m);
    expect(body).toMatch(/\/\/ MaxDelay caps any single sleep — prevents pathological cases/);
    expect(body).toMatch(/\/\/ from compounding past a sensible ceiling\./);
    expect(body).toMatch(/^\s*MaxDelay time\.Duration$/m);
    expect(body).toMatch(/\/\/ BackoffMultiplier is the exponential-backoff base\. Default 2\.0\./);
    expect(body).toMatch(/^\s*BackoffMultiplier float64$/m);
    expect(body).toMatch(/\/\/ Disabled turns the retry loop off entirely\./);
    expect(body).toMatch(/^\s*Disabled bool$/m);
  });

  it('DefaultRetry: 3 retries, 200ms initial, 10s max, 2.0 multiplier — matches TS+Python SDK defaults', () => {
    expect(body).toMatch(/Matches the TS \+ Python SDKs: 3 retries, 200ms-10s window\./);
    expect(body).toMatch(
      /^func DefaultRetry\(\) RetryConfig \{\s*\n\s*return RetryConfig\{\s*\n\s*MaxRetries:\s+3,\s*\n\s*InitialDelay:\s+200 \* time\.Millisecond,\s*\n\s*MaxDelay:\s+10 \* time\.Second,\s*\n\s*BackoffMultiplier: 2\.0,\s*\n\s*\}\s*\n\}/m,
    );
  });

  it('withRetry loop: Disabled fast path + per-attempt fn() call + non-retryable propagates + attempt counter + ctx.Done() abort between attempts + bm fallback when <=0', () => {
    expect(body).toMatch(/\/\/ withRetry runs fn with retries per cfg\. Retries TransportError \+/);
    expect(body).toMatch(/\/\/ RateLimitError; every other typed Driftstack error propagates/);
    expect(body).toMatch(
      /\/\/ immediately\. Honours Retry-After when the error is a RateLimitError\./,
    );
    expect(body).toMatch(/\/\/ ctx cancellation aborts the retry loop between attempts —/);
    expect(body).toMatch(/\/\/ long-running attempts are cancelled by the inner fn\./);
    expect(body).toMatch(
      /^func withRetry\(ctx context\.Context, cfg RetryConfig, fn func\(\) error\) error \{\s*\n\s*if cfg\.Disabled \{\s*\n\s*return fn\(\)\s*\n\s*\}/m,
    );
    expect(body).toMatch(
      /bm := cfg\.BackoffMultiplier\s*\n\s*if bm <= 0 \{\s*\n\s*bm = 2\.0\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /for attempt := 0; ; attempt\+\+ \{\s*\n\s*err := fn\(\)\s*\n\s*if err == nil \{\s*\n\s*return nil\s*\n\s*\}\s*\n\s*if !isRetryable\(err\) \{\s*\n\s*return err\s*\n\s*\}\s*\n\s*if attempt >= cfg\.MaxRetries \{\s*\n\s*return err\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /sleep := nextDelay\(cfg, bm, attempt, retryAfterFromErr\(err\)\)\s*\n\s*select \{\s*\n\s*case <-ctx\.Done\(\):\s*\n\s*return ctx\.Err\(\)\s*\n\s*case <-time\.After\(sleep\):\s*\n\s*\}/,
    );
  });

  it('isRetryable + retryAfterFromErr + nextDelay: errors.As TransportError/RateLimitError + Retry-After (seconds*time.Second) capped + full-jitter rand.Int63n int64(cap)', () => {
    expect(body).toMatch(/\/\/ isRetryable returns true for transient errors that the loop should/);
    expect(body).toMatch(
      /^func isRetryable\(err error\) bool \{\s*\n\s*var t \*TransportError\s*\n\s*if errors\.As\(err, &t\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*var r \*RateLimitError\s*\n\s*return errors\.As\(err, &r\)\s*\n\}/m,
    );
    expect(body).toMatch(
      /^func retryAfterFromErr\(err error\) time\.Duration \{\s*\n\s*var r \*RateLimitError\s*\n\s*if errors\.As\(err, &r\) && r\.RetryAfterSeconds > 0 \{\s*\n\s*return time\.Duration\(r\.RetryAfterSeconds\) \* time\.Second\s*\n\s*\}\s*\n\s*return 0\s*\n\}/m,
    );
    expect(body).toMatch(
      /^func nextDelay\(cfg RetryConfig, bm float64, attempt int, retryAfter time\.Duration\) time\.Duration \{$/m,
    );
    expect(body).toMatch(
      /if retryAfter > 0 \{\s*\n\s*if retryAfter > cfg\.MaxDelay \{\s*\n\s*return cfg\.MaxDelay\s*\n\s*\}\s*\n\s*return retryAfter\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Exponential backoff with full jitter: rand\(0, base \* bm\^attempt\),/,
    );
    expect(body).toMatch(/\/\/ capped at MaxDelay\./);
    expect(body).toMatch(
      /pow := 1\.0\s*\n\s*for i := 0; i < attempt; i\+\+ \{\s*\n\s*pow \*= bm\s*\n\s*\}/,
    );
    expect(body).toMatch(/cap := time\.Duration\(float64\(cfg\.InitialDelay\) \* pow\)/);
    expect(body).toMatch(/if cap > cfg\.MaxDelay \{\s*\n\s*cap = cfg\.MaxDelay\s*\n\s*\}/);
    expect(body).toMatch(/if cap <= 0 \{\s*\n\s*return 0\s*\n\s*\}/);
    expect(body).toMatch(/\/\/ Use rand\.Int63n with crypto-safe-enough seed; jitter doesn't/);
    expect(body).toMatch(/\/\/ need crypto-grade randomness\./);
    expect(body).toMatch(/return time\.Duration\(rand\.Int63n\(int64\(cap\)\)\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
