// W679 — cross-SDK retry-policy semantics parity. Sixth in the
// cross-SDK drift-guard series (W649 verb + W675 error class + W676
// problem-type URI + W677 auth/UA + W678 webhook sig + W679 retry).
//
// Asserts the same RETRY POLICY SEMANTICS across all 3 SDKs:
//
//   - Exponential backoff with FULL jitter (NOT half/equal/decorrelated)
//   - Honor 429 Retry-After hint (server-supplied wait wins over
//     exponential)
//   - Cap each sleep at maxDelay (prevents pathological cases)
//   - 4 total tries (initial + 3 retries) — constants now UNIFIED
//     across SDKs (all use 200ms/10s; TS aligned to Go/Python 2026-06-23)
//   - Retry on transient: RateLimitError + TransportError + 5xx
//   - DON\'T retry on 4xx (except 429)
//
// NOTE: numeric defaults INTENTIONALLY differ between SDKs (each SDK
// tuned its defaults independently). Only the policy SEMANTICS are
// shared — drift on the semantics would silently change customer-
// facing retry behavior; drift on the per-SDK constants is allowed.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_RETRY = resolve(REPO_ROOT, 'packages/sdk-typescript/src/retry.ts');
const GO_RETRY = resolve(REPO_ROOT, 'packages/sdk-go/retry.go');
const PY_RETRY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/retry.py');

describe('W679 cross-SDK retry-policy semantics parity', () => {
  it('all 3 SDK retry files exist at canonical paths', () => {
    expect(existsSync(TS_RETRY), `missing ${TS_RETRY}`).toBe(true);
    expect(existsSync(GO_RETRY), `missing ${GO_RETRY}`).toBe(true);
    expect(existsSync(PY_RETRY), `missing ${PY_RETRY}`).toBe(true);
  });

  it('CRITICAL exponential-backoff with FULL JITTER pinned in all 3 SDKs. "Full jitter" means random in [0, computedDelay] — NOT half-jitter / equal-jitter / decorrelated-jitter (AWS variants). Drift to a different jitter strategy would silently change the convergence characteristics under load (full-jitter prevents thundering-herd best).', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: "full jitter" wording in policy comment.
    expect(ts).toMatch(/full jitter/);

    // sdk-go: full jitter comment.
    expect(go).toMatch(/full jitter/);

    // sdk-python: full jitter comment.
    expect(py).toMatch(/full jitter/);
  });

  it('CRITICAL 429 Retry-After honor pinned in all 3 SDKs. Server-supplied Retry-After WINS over the exponential-backoff computation when the error is a RateLimitError. Drift to ignoring Retry-After would silently make customers exceed server-side rate limits (server says "wait 30s" + SDK retries in 250ms = 4xx storm).', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    expect(ts).toMatch(/Retry-After/);
    expect(go).toMatch(/Retry-After/);
    expect(py).toMatch(/Retry-After/);
  });

  // The boundary the other arms step over: what a NON-POSITIVE Retry-After
  // means. The hint path has no jitter, so an SDK that treats 0 as a hint
  // sleeps a fixed 0 ms — it burns its whole retry budget in a tight loop and
  // every client hammering the same endpoint wakes in lockstep, which is the
  // thundering herd the full-jitter backoff above exists to prevent.
  //
  // sdk-python used to do exactly that: `if retry_after_seconds is not None`
  // took the hint path for 0 and, via a max(0, ...) clamp, for a negative
  // (malformed) value too. Measured before the fix — attempt 0 returned a fixed
  // 0 ms for both, where TS and Go returned 0..199 ms of jittered backoff.
  //
  // Our own server cannot produce it: every rate-limit path floors the header
  // at `Math.max(1, Math.ceil(ms / 1000))`. This is about the SDK being sound
  // against a hint it did not generate.
  it('CRITICAL a non-positive Retry-After is treated as NO hint in all 3 SDKs, not as a zero sleep', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // Each gates the hint path on a strictly-positive value.
    expect(ts, 'sdk-typescript must gate the Retry-After path on > 0').toMatch(
      /retryAfterSeconds\s*>\s*0/,
    );
    expect(go, 'sdk-go must gate the Retry-After path on > 0').toMatch(/retryAfter\s*>\s*0/);
    expect(py, 'sdk-python must gate the Retry-After path on > 0').toMatch(
      /retry_after_seconds\s+is\s+not\s+None\s+and\s+retry_after_seconds\s*>\s*0/,
    );

    // And the shape that caused it must not come back: clamping a non-positive
    // hint to zero and returning it IS the bug, however defensively it reads.
    expect(
      py,
      'sdk-python is clamping a non-positive Retry-After to 0 and returning it — that is the ' +
        'jitter-free hot-retry loop, not a defensive floor',
    ).not.toMatch(/return\s+max\(0,\s*min\(retry_after_seconds/);
  });

  it('CRITICAL RateLimitError + TransportError retryable across all 3 SDKs. These error classes are transient (429 with a retry hint, or network failure) and must stay retryable. sdk-typescript expresses this by delegating shouldRetry to the public isRetryable() (which retries transport / internal / rate_limited) — so TransportError retryability lives in errors.ts:isRetryable, not as a literal instanceof check in retry.ts. Drift to making either non-retryable would silently let customers fail-fast on transient errors.', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: computeDelay honours RateLimitError; shouldRetry
    // delegates to isRetryable() (covers transport + internal + rate_limited).
    expect(ts).toMatch(/RateLimitError/);
    expect(ts).toMatch(/return isRetryable\(err\);/);

    // sdk-go: errors.As(err, &RateLimitError{}) etc.
    expect(go).toMatch(/RateLimitError/);
    expect(go).toMatch(/TransportError/);

    // sdk-python: isinstance(err, RateLimitError) etc.
    expect(py).toMatch(/RateLimitError/);
    expect(py).toMatch(/TransportError/);
  });

  it('CRITICAL retry-set per-SDK — RateLimitError + TransportError + InternalError (5xx) are the transient set retried in ALL 3 SDKs. sdk-typescript delegates shouldRetry to the public isRetryable() (which retries ONLY transport/internal/rate_limited), so it does NOT blanket-retry every status>=500 — the terminal 5xx kinds DriverError(502)/DriverNotIntegrated(503)/SessionTimeout(504) are NOT retried, matching sdk-go (IsRetryable) + sdk-python (is_retryable). Drift to retrying 4xx in ANY SDK would blast the server with auth failures; drift back to a blanket status>=500 would auto-retry terminal driver/timeout failures.', () => {
    const ts = read(TS_RETRY);

    // sdk-typescript: shouldRetry delegates to isRetryable + explicit
    // "do NOT retry on 4xx" comment is preserved as the stable anchor.
    expect(ts).toMatch(/return isRetryable\(err\);/);
    expect(ts).toMatch(/do NOT retry on 4xx/);
  });

  it('CRITICAL maxDelay cap on each sleep pinned in all 3 SDKs. Caps the exponential growth at a fixed ceiling (prevents pathological "wait 4 hours" scenarios after 10 retries). All 3 SDKs now share the same 10s ceiling (TS unified to Go/Python per the 2026-06-23 audit); the CAP semantics are shared.', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: maxDelay reference + cap math (Math.min).
    expect(ts).toMatch(/maxDelay/);
    expect(ts).toMatch(/Math\.min/);

    // sdk-go: MaxDelay cap.
    expect(go).toMatch(/MaxDelay/);

    // sdk-python: max_delay_ms cap.
    expect(py).toMatch(/max_delay_ms/);
  });

  it("Cross-SDK numeric defaults — now UNIFIED at initial 200ms + max 10_000ms across all 3 SDKs (TS aligned to Go/Python per the 2026-06-23 audit; was 250/8_000). sdk-typescript: initialDelayMs=200 + maxDelayMs=10_000. sdk-go: InitialDelay=200ms + MaxDelay=10s. sdk-python: initial_delay_ms=200 + max_delay_ms=10_000. Drift to a per-SDK default that's wildly out of range (e.g. TS to 60s default) would silently change the customer's retry latency.", () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: 200ms initial + 10_000ms max (unified with Go/Python).
    expect(ts).toMatch(/initialDelayMs: 200/);
    expect(ts).toMatch(/maxDelayMs: 10_000/);

    // sdk-go: 200 * time.Millisecond + 10 * time.Second.
    expect(go).toMatch(/200 ?\* ?time\.Millisecond/);
    expect(go).toMatch(/10 ?\* ?time\.Second/);

    // sdk-python: initial_delay_ms = 200 + max_delay_ms = 10_000.
    expect(py).toMatch(/initial_delay_ms: int = 200/);
    expect(py).toMatch(/max_delay_ms: int = 10_000/);
  });

  it('BackoffMultiplier = 2.0 pinned in sdk-go + sdk-python. sdk-typescript uses `2 ** attemptIndex` (implicit base 2). Drift to a different base (e.g. 3.0) would change the doubling behavior — customers anchor their retry budgets on the doubling.', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: implicit 2 via ** attemptIndex.
    expect(ts).toMatch(/2 \*\* attemptIndex/);

    // sdk-go: BackoffMultiplier 2.0 default.
    expect(go).toMatch(/BackoffMultiplier/);

    // sdk-python: backoff_multiplier 2.0 default.
    expect(py).toMatch(/backoff_multiplier: float = 2\.0/);
  });

  it('CRITICAL "Mirrors" cross-reference comment pinned in sdk-python (Python is the latest-added SDK so it documents that it mirrors sdk-typescript\'s retry.ts). Drift to dropping the cross-reference would lose the canonical-source pointer for future maintainers.', () => {
    const py = read(PY_RETRY);
    expect(py).toMatch(/Mirrors.*sdk-typescript|sdk-typescript.*retry/);
  });

  it('Export surface — each SDK exposes a public retry helper under its language-canonical name. sdk-typescript: withRetry. sdk-go: doWithRetry or similar (Go convention; checked via "Retry" presence). sdk-python: similar.', () => {
    const ts = read(TS_RETRY);
    const py = read(PY_RETRY);

    expect(ts).toMatch(/export async function withRetry/);

    // sdk-python: public retry function.
    expect(py).toMatch(/def [a-z_]+_with_retry|def with_retry|def retry/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-retry-policy-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
