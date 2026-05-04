# Webhook signature verify benchmarks

Snapshot of `npm run bench` output for `packages/sdk-typescript/tests/bench/webhook-signature.bench.ts`. Re-run on demand; numbers vary by hardware. **Not a CI gate.**

`verifyWebhookSignature` runs once per inbound webhook delivery on customer infrastructure. Latency here is part of the customer's hot path, so it's worth a baseline.

## Baseline (V-124, 2026-05-04)

Hardware: Apple M-class (dev workstation, no thermal throttling, ~no concurrent load).
Node: v25 local. Uses Node's `globalThis.crypto.subtle` (WebCrypto) for HMAC-SHA256.

### Small body (~70 bytes JSON), valid signature

The common-case shape: a `session.completed` event payload, signature matches.

| metric | value        |
| ------ | ------------ |
| hz     | 54,859 ops/s |
| mean   | 18.2µs       |
| p75    | 18.8µs       |
| p99    | 25.7µs       |
| p999   | 173µs        |

### Small body, invalid signature

Constant-time compare runs to completion regardless of valid/invalid.

| metric | value        |
| ------ | ------------ |
| hz     | 56,478 ops/s |
| mean   | 17.7µs       |
| p99    | 23.6µs       |

The two paths track within RME — there's no observable timing-side-channel between valid and invalid (which is the entire point of using constant-time comparison via WebCrypto's HMAC-SHA256 verify).

### Large body (~10 KB JSON), valid signature

A `session.completed` event with a 10 KB payload extension.

| metric | value        |
| ------ | ------------ |
| hz     | 36,796 ops/s |
| mean   | 27.2µs       |
| p99    | 112µs        |
| p999   | 467µs        |

## Observations

- Verify is dominated by WebCrypto subtle's HMAC-SHA256 + the per-call `importKey` step (the SDK doesn't cache imported keys — each call imports fresh). 18µs mean for small bodies is well above the surrounding network roundtrip cost, so a customer's inbound-webhook handler latency is dominated by HTTP receive + their own logic, not signature verify.
- Large-body p99 (112µs) shows allocation + hash cost scaling roughly linearly with body size. 10 KB is large for a webhook payload; typical Driftstack events are <1 KB.
- Optimization opportunity: cache `subtle.importKey` per (secret) value across calls. That would shave ~5-10µs off the mean and is invisible to the API contract. Not yet worth the complexity — file an issue if customer-side latency becomes a real complaint.

## What's intentionally NOT benched here

- Server-side `signWebhookPayload` (Node `createHmac`, no WebCrypto) — different perf profile, runs once per delivery, not the constraint.
- Constant-time compare for partial signatures — WebCrypto returns boolean from `verify()`; the timing of that comparison is implementation-defined.

## How to re-run

```bash
npx vitest bench --run packages/sdk-typescript/tests/bench/webhook-signature.bench.ts
```
