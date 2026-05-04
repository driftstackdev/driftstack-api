# Rate-limit benchmarks

Snapshot of `npm run bench` output for `apps/server/tests/bench/rate-limit.bench.ts`. Re-run on demand; numbers vary by hardware. **Not a CI gate** — see `auth-path.md` for the rationale.

## Baseline (V-123, 2026-05-04)

Hardware: Apple M-class (dev workstation, no thermal throttling, ~no concurrent load).
Node: v25 local. Vitest: 2.1.9 with built-in `bench` (tinybench under the hood).

### Happy path: `consume(cost=1)` against a fresh bucket

Each iteration uses a new key, so the bucket initializes at full capacity and immediately serves. Includes the `Math.random().toString(36).slice(2)` key generation overhead, so this number is conservative.

| metric | value           |
| ------ | --------------- |
| hz     | 1,645,889 ops/s |
| mean   | 0.6µs           |
| p75    | 0.6µs           |
| p99    | 1.1µs           |
| p999   | 3.8µs           |

### Refill + consume on existing bucket (the production hot path)

Same key across calls, advancing time per iteration so refill math fires. Closest match to the production "key gets requests at sustained rate" pattern.

| metric | value           |
| ------ | --------------- |
| hz     | 7,883,370 ops/s |
| mean   | 0.1µs           |
| p75    | 0.1µs           |
| p99    | 0.3µs           |
| p999   | 1.2µs           |

### Denied path: bucket empty, `allowed: false`

Bucket pre-drained, every consume() returns `allowed: false` with a computed `retryAfterMs`.

| metric | value           |
| ------ | --------------- |
| hz     | 8,939,258 ops/s |
| mean   | 0.1µs           |
| p75    | 0.1µs           |
| p99    | 0.2µs           |
| p995   | 0.3µs           |

## Observations

- The hot path (`refill + consume`) at p99 0.3µs and the denied path at p99 0.2µs are both negligible relative to the surrounding network roundtrip.
- The "fresh bucket" path is dominated by the per-iteration random key allocation (test artifact). Real production fresh-bucket consumes don't generate strings on the fly.
- All three branches share a single small `Map` lookup + arithmetic — no I/O — so total cost is JS engine + GC. JIT warmup brings sustained throughput well above 1M ops/s for every shape.

## What's intentionally NOT benched here

- Redis-backed `RateLimitStore` (production multi-instance variant) — adds ~0.5–2ms network roundtrip per call. Belongs to the autocannon-against-server suite when that lands.
- Production rate-limit override resolution — that path is in `services/rate-limit.ts` orchestration around the store, not the store itself.

## How to re-run

```bash
npm run bench
```

Filtered:

```bash
npx vitest bench --run apps/server/tests/bench/rate-limit.bench.ts
```
