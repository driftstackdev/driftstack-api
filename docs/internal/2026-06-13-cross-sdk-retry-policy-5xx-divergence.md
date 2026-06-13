# Cross-SDK retry-policy divergence on 5xx — surfaced 2026-06-13

**Status:** SURFACED (read-only audit wave; high box load → no push). Cross-cutting,
customer-facing behavior spanning 3 SDK packages + the documented retry contract →
needs a decision, not an autonomous flip.

**Severity:** MEDIUM. Customer-visible behavioral inconsistency + a latent double-submit
exposure on the TS SDK + a misleading public helper in the Python SDK. No data-loss /
security issue; the idempotency-key path (when used) already protects the money POSTs.

## What was found

The three client SDKs claim parity ("Python `retry.py`: _Mirrors
packages/sdk-typescript/src/retry.ts_"; the W706 `cross-sdk-client-defaults-parity`
test asserts a retry wrapper is applied to every call in all 3). But the **set of
errors each built-in retry actually retries diverges**:

| SDK        | network (transport) | 429 (rate-limit) | **5xx (server)** | call site                                                                         |
| ---------- | :-----------------: | :--------------: | :--------------: | --------------------------------------------------------------------------------- |
| TypeScript |         ✅          |        ✅        |  **✅ retries**  | `retry.ts` `shouldRetry: err.status >= 500`                                       |
| Python     |         ✅          |        ✅        | **❌ no retry**  | `http.py:249` → `with_retry`, `retryable_errors=(TransportError, RateLimitError)` |
| Go         |         ✅          |        ✅        | **❌ no retry**  | `retry.go:78` `isRetryable` = `*TransportError`/`*RateLimitError` only            |

**TypeScript is the outlier** — the only SDK whose built-in retry re-attempts 5xx
responses. Python + Go treat any 5xx as terminal.

### Two distinct problems

1. **Cross-SDK inconsistency.** The same API call (e.g. a transient `503` during a
   prod deploy) behaves differently per language: TS auto-retries and succeeds; Python/Go
   surface the 503 to the caller immediately. Customers porting between SDKs, or running a
   polyglot fleet, get inconsistent resilience. The Python/Go docstrings asserting they
   "mirror" the TS SDK are inaccurate.

2. **Intra-Python contradiction.** Python ships a _public_ helper
   `is_retryable(err)` (errors.py:432, exported in `__init__.py`) whose
   `_RETRYABLE_TYPES = (TransportError, InternalError, RateLimitError)` reports
   **`InternalError` (5xx) as retryable** — and `test_errors.py:268` pins
   `is_retryable(InternalError(status=500)) is True`. But the **built-in** client
   (`with_retry`) never retries 5xx. A customer who builds their own loop on the documented
   `is_retryable` helper, or who reasons from it about the built-in behavior, is misled.

### Latent: double-submit on the TS SDK

Because TS retries 5xx for **all** methods (the retry wraps every request in
`http.ts:50`), a non-idempotent `POST` that returns 5xx _after the server committed_
(or whose response is lost → `TransportError`, which all 3 retry) is silently re-sent →
duplicate resource / double-metered bill. This is mitigated **only** when the caller
passes an `Idempotency-Key` (optional on `agentSessions.create` / `cryptoOrders.create`
in all 3 SDKs; server dedups via the `(account_id, idempotency_key)` partial unique
index). Customers who omit the key are exposed — and TS is most exposed because it also
retries 5xx, not just transport errors. Python/Go avoid the 5xx slice of this entirely.

## Why it slipped through

`cross-sdk-client-defaults-parity.test.ts` (W706, line 147) asserts only that a retry
**wrapper** is wired into every call; it never pins **which** errors each SDK retries.
Its own comment ("handles transient 5xx + transport errors") even mis-states that all 3
retry 5xx. So the retryable-error-set is an uncovered parity blind spot.

## Recommendation (for a low-load wave / founder nod — do NOT auto-flip)

**Preferred (the principled fix): method/idempotency-aware retry, aligned across all 3.**
Retry transport + 429 for every method; retry 5xx only for idempotent methods
(GET/HEAD/PUT/DELETE) and for POSTs that carry an `Idempotency-Key`. This keeps
read-path resilience, removes the bare-POST double-submit risk, and is identical in all
three SDKs. Requires threading the method (+ key presence) into the retry decision in each
SDK — a focused cross-package change.

**Pragmatic fallback (minimal, safest baseline): align TS _down_ to Python/Go** — drop
5xx from the TS retryable set so no SDK retries 5xx. One-line-ish change per the TS
`shouldRetry`; instantly consistent and eliminates the 5xx double-submit slice. Cost: a
transient 503 on a read no longer auto-retries in TS (rare; caller can retry).

**Either way, also:**

- Reconcile Python's `is_retryable` helper / `_RETRYABLE_TYPES` with the built-in
  `with_retry` policy (today they disagree on 5xx) — pick one and document it.
- Strengthen the W706 parity test to pin the **retryable-error set** per SDK (not just
  wrapper presence), and fix its "handles transient 5xx" comment to match reality.
- Land the SDK change + parity test in the same commit (gate green, low-load window).

## Not in scope / verified-fine

- Idempotency-Key support itself is consistent + complete across all 3 SDKs for the two
  money/resource POSTs (agent-sessions create, crypto-orders create); server dedup verified
  (`routes/agent-sessions.ts:729-782`, `routes/billing-crypto.ts:223`). Covered by
  `cross-sdk-idempotency-key-parity.test.ts`.
- No API-key leakage in TS error paths (the key lives only in `init.headers.authorization`;
  `transportMessage` returns the fetch error message / name, never the request headers).
- Retry loops are otherwise sound (bounded attempts, full jitter, no 4xx retry, no retry of
  non-DriftstackError). TS `computeDelay` Retry-After branch is _uncapped_ by `maxDelay`
  (LOW — server-trusted; Python/Go cap it at `max_delay_ms`/equivalent — another small
  divergence worth folding into the same fix).
