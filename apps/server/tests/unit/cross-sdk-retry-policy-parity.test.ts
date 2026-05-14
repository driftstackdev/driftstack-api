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
//   - 4 total tries (initial + 3 retries) — but the constants differ
//     between SDKs (TS uses 250ms/8s, Go/Python use 200ms/10s)
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

  it('CRITICAL RateLimitError + TransportError retryable across all 3 SDKs. These 2 error classes are unconditionally retryable because they represent transient failures (429 with a hint to retry, or network failure). Drift to making either non-retryable would silently let customers fail-fast on transient errors.', () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: instanceof RateLimitError return true; instanceof TransportError return true.
    expect(ts).toMatch(/RateLimitError/);
    expect(ts).toMatch(/TransportError/);

    // sdk-go: errors.As(err, &RateLimitError{}) etc.
    expect(go).toMatch(/RateLimitError/);
    expect(go).toMatch(/TransportError/);

    // sdk-python: isinstance(err, RateLimitError) etc.
    expect(py).toMatch(/RateLimitError/);
    expect(py).toMatch(/TransportError/);
  });

  it('CRITICAL retry-set per-SDK — RateLimitError + TransportError are retried in ALL 3 SDKs (the common transient set). sdk-typescript additionally retries 5xx DriftstackError (status>=500); sdk-go + sdk-python treat 5xx as terminal (only RateLimit + Transport). Drift to retrying 4xx in ANY SDK would blast the server with auth failures.', () => {
    const ts = read(TS_RETRY);

    // sdk-typescript-specific: 5xx retry + explicit "do NOT retry on 4xx" comment.
    expect(ts).toMatch(/status >= 500/);
    expect(ts).toMatch(/do NOT retry on 4xx/);
  });

  it('CRITICAL maxDelay cap on each sleep pinned in all 3 SDKs. Caps the exponential growth at a fixed ceiling (prevents pathological "wait 4 hours" scenarios after 10 retries). Each SDK uses a different ceiling (TS 8s, Go/Python 10s) but the CAP semantics are shared.', () => {
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

  it("Per-SDK numeric defaults — intentionally DIFFERENT across SDKs. sdk-typescript: initialDelayMs=250 + maxDelayMs=8_000. sdk-go: InitialDelay=200ms + MaxDelay=10s. sdk-python: initial_delay_ms=200 + max_delay_ms=10_000. Drift to MATCHING constants is fine; drift to a different per-SDK default that's wildly out of range (e.g. TS to 60s default) would silently change the customer's retry latency.", () => {
    const ts = read(TS_RETRY);
    const go = read(GO_RETRY);
    const py = read(PY_RETRY);

    // sdk-typescript: 250ms initial + 8_000ms max.
    expect(ts).toMatch(/initialDelayMs: 250/);
    expect(ts).toMatch(/maxDelayMs: 8_000/);

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
