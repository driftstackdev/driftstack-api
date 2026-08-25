// W815 — cross-SDK retry-policy parity. One-hundred-forty-first in
// the drift-guard series. Pins the 3 SDK retry implementations in
// lockstep: same 3-retry default, same exponential-backoff with full
// jitter, same Retry-After honoring, same retryable-error set
// (TransportError + RateLimitError + InternalError/5xx). Drift would let one SDK retry
// more aggressively than its siblings — a class of cross-SDK divergence
// that's invisible until production traffic hits the edge cases.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/retry.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/retry.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/retry.go');

describe('W815 cross-SDK retry policy parity', () => {
  it('all 3 retry implementations exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Header framing ───────────────────────────────────────────

  it("CRITICAL all 3 retry implementations document exponential-backoff with full jitter + Retry-After honoring + cross-SDK lockstep framing. Python explicitly says 'Mirrors packages/sdk-typescript/src/retry.ts'; Go says 'Matches the TS + Python SDKs'. Drift would break the three-way lockstep.", () => {
    expect(read(TS)).toMatch(
      /Retry logic — exponential backoff with full jitter, with explicit support\s*\n\/\/ for 429 Retry-After\./,
    );
    expect(read(PY)).toMatch(/Exponential-backoff retry policy with full jitter\./);
    expect(read(PY)).toMatch(/Mirrors `packages\/sdk-typescript\/src\/retry\.ts`/);
    expect(read(GO)).toMatch(/Matches the TS \+ Python SDKs: 3 retries, 200ms-10s window\./);
  });

  // ─── 3-retry default ──────────────────────────────────────────

  it('CRITICAL all 3 retry implementations default to 3 retries (4 total tries). TS: DEFAULTS.maxAttempts:3 + Python: max_retries: int = 3 + Go: MaxRetries: 3. Drift to different defaults would let one SDK retry more aggressively than its siblings.', () => {
    expect(read(TS)).toMatch(/maxAttempts: 3,/);
    expect(read(PY)).toMatch(/max_retries: int = 3/);
    expect(read(GO)).toMatch(/MaxRetries: +3,/);
  });

  // ─── Retry-After honoring framing ─────────────────────────────

  it('CRITICAL all 3 retry implementations document Retry-After honoring. TS: "Honour Retry-After when the error is a RateLimitError or 429". Python: "If the server set a Retry-After (rate-limit case), it wins — we never retry sooner than the server asks". Go: "Honours Retry-After when the error is a RateLimitError".', () => {
    expect(read(TS)).toMatch(
      /\/\/\s+- Honour Retry-After when the error is a RateLimitError or 429/,
    );
    expect(read(PY)).toMatch(
      // Wrap-tolerant, and POSITIVE is load-bearing: a non-positive hint is
      // treated as no hint and falls through to jittered backoff, because the
      // hint path has no jitter and a zero would produce a lockstep hot loop.
      /If the server set a POSITIVE ``Retry-After`` \(rate-limit case\), it\s*\n\s+wins — we never retry sooner than the server asks\./,
    );
    expect(read(GO)).toMatch(/Honours Retry-After when the error is a RateLimitError\./);
  });

  // ─── Retryable error set ──────────────────────────────────────

  it('CRITICAL all 3 retry implementations retry the SAME transient set — TransportError + RateLimitError + InternalError (5xx) — but NOT ValidationError/auth NOR the terminal 5xx kinds (DriverError 502 / DriverNotIntegrated 503 / SessionTimeout 504). TS delegates shouldRetry to the public isRetryable() (so the loop and the predicate cannot diverge — the bug this guard now pins closed: a blanket status>=500 retried terminal driver/timeout errors); Python lists the set in retryable_errors; Go documents it.', () => {
    expect(read(TS)).toMatch(/import \{ RateLimitError, isRetryable \} from '\.\/errors\.js';/);
    expect(read(TS)).toMatch(/return isRetryable\(err\);/);
    expect(read(PY)).toMatch(
      /retryable_errors: tuple\[type\[BaseException\], \.\.\.\] = field\(\s*\n\s+default_factory=lambda: \(TransportError, RateLimitError, InternalError\)\s*\n\s+\)/,
    );
    expect(read(GO)).toMatch(
      /Retries TransportError \+\s*\n\/\/ InternalError \(5xx\) \+ RateLimitError; every other typed Driftstack error\s*\n\/\/ propagates immediately\./,
    );
  });

  // ─── Do-not-retry-on-4xx-except-429 framing ───────────────────

  it("CRITICAL TS 'Retry ONLY transient kinds ... do NOT retry on 4xx (except 429)' framing pinned. This is the load-bearing 'don't retry validation errors' anchor — drift would either retry 401s (silent infinite loops on revoked keys) or, if it reverted to a blanket 5xx, auto-retry the terminal driver/timeout 5xx kinds. The 'do NOT retry on 4xx (except 429)' wording is preserved as the stable anchor.", () => {
    expect(read(TS)).toMatch(/\/\/\s+- Retry ONLY transient kinds/);
    expect(read(TS)).toMatch(/do NOT retry on 4xx \(except 429\)/);
  });

  // ─── Initial backoff + cap defaults ───────────────────────────

  it('CRITICAL retry-config initial-backoff + max-cap defaults pinned. UNIFIED 200/10000 across all 3 SDKs — TS: initialDelayMs 200 + maxDelayMs 10000. Python: initial_delay_ms 200 + max_delay_ms 10000. Go: 200ms + 10s. (TS was 250/8000, aligned to Go/Python in the 2026-06-23 audit so the cross-SDK comments are true.) Drift to different defaults would create cross-SDK divergence under burst conditions.', () => {
    expect(read(TS)).toMatch(/initialDelayMs: 200,/);
    expect(read(TS)).toMatch(/maxDelayMs: 10_000,/);
    expect(read(PY)).toMatch(/initial_delay_ms: int = 200/);
    expect(read(PY)).toMatch(/max_delay_ms: int = 10_000/);
    expect(read(GO)).toMatch(/InitialDelay: +200 \* time\.Millisecond,/);
    expect(read(GO)).toMatch(/MaxDelay: +10 \* time\.Second,/);
  });

  // ─── Full-jitter algorithm framing ────────────────────────────

  it("CRITICAL all 3 retry implementations use 'full jitter' (random uniform in [0, computed delay]). TS: 'Random jitter in [0, computed delay] (full jitter)'. Python: 'random uniform between 0 and the next exponential value'. Go: 'uniformly random in [0, InitialDelay * 2^attempt]'. Full jitter is the AWS Architecture Blog standard — drift to fixed jitter would re-synchronize concurrent retries.", () => {
    expect(read(TS)).toMatch(/\/\/\s+- Random jitter in \[0, computed delay\] \(full jitter\)/);
    expect(read(PY)).toMatch(
      /exponential-backoff with full jitter\s*\(random uniform between 0\s*and the next exponential value\)\./,
    );
    expect(read(GO)).toMatch(/sleep is uniformly random in \[0, InitialDelay \* 2\^attempt\]/);
  });

  // ─── Test-override hooks ──────────────────────────────────────

  it('CRITICAL TS RetryConfig exposes rng + sleep override hooks for tests. Drift to losing the hooks would force tests to rely on real timing (flaky CI).', () => {
    const p = read(TS);
    expect(p).toMatch(/rng\?: \(\) => number;/);
    expect(p).toMatch(/sleep\?: \(ms: number\) => Promise<void>;/);
  });

  // ─── Disabled / enabled toggles ───────────────────────────────

  it("CRITICAL retry-config disable toggle pinned across Python + Go. Python: 'enabled: bool = True'; Go: 'Disabled bool' (inverted). The opt-out lets advanced callers replace the retry loop with their own — drift to no-toggle would force a hard fork.", () => {
    expect(read(PY)).toMatch(/enabled: bool = True/);
    expect(read(GO)).toMatch(/Disabled turns the retry loop off entirely\./);
    expect(read(GO)).toMatch(/Disabled bool/);
  });

  // ─── Go-specific context.Cancel framing ───────────────────────

  it("CRITICAL Go retry loop pins 'ctx cancellation aborts the retry loop between attempts — long-running attempts are cancelled by the inner fn'. The dual-cancellation framing is the canonical Go-idiomatic 'who cancels what' contract.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /ctx cancellation aborts the retry loop between attempts —\s*\n\/\/ long-running attempts are cancelled by the inner fn\./,
    );
    expect(p).toMatch(
      /func withRetry\(ctx context\.Context, cfg RetryConfig, fn func\(\) error\) error/,
    );
  });

  // ─── BackoffMultiplier 2.0 default ────────────────────────────

  it('CRITICAL Python + Go expose BackoffMultiplier default 2.0 (doubling). Python: backoff_multiplier: float = 2.0; Go: BackoffMultiplier: 2.0. Drift to a different base would change the exponential curve.', () => {
    expect(read(PY)).toMatch(/backoff_multiplier: float = 2\.0/);
    expect(read(GO)).toMatch(/BackoffMultiplier: 2\.0,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-retry-policy-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
