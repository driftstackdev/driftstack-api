# Auth path benchmarks

Snapshot of `npm run bench` output for `apps/server/tests/bench/auth-cache.bench.ts`. Re-run on demand; numbers vary by hardware. **Not a CI gate** — bench results on shared runners are too noisy to fail builds on. Snapshots here are reference points for spotting regressions during local profiling.

## Baseline (V-120, 2026-05-04)

Hardware: Apple M-class (dev workstation, no thermal throttling, ~no concurrent load).
Node: v25 local. Vitest: 2.1.9 with built-in `bench` (tinybench under the hood).

### `sha256(plaintext)` — cache-key derivation

Every authenticated request runs this once to derive the cache key from the bearer token.

| metric | value           |
| ------ | --------------- |
| hz     | 2,406,539 ops/s |
| mean   | 0.4µs           |
| p75    | 0.4µs           |
| p99    | 0.7µs           |
| p999   | 1.5µs           |

### `InMemoryAuthCache.get()` — cache hit

The hot path: bearer token sha256 maps to a populated cache entry, version + expiry checks pass, `AccountContext` returned.

| metric | value           |
| ------ | --------------- |
| hz     | 9,122,173 ops/s |
| mean   | 0.1µs           |
| p75    | 0.1µs           |
| p99    | 0.2µs           |
| p999   | 0.4µs           |

### Cache miss → set → hit roundtrip

Empty cache, lookup misses, populate, re-fetch hit. Excludes the actual scrypt verify + DB load that happen ABOVE the cache on a real cache miss.

| metric | value           |
| ------ | --------------- |
| hz     | 1,621,288 ops/s |
| mean   | 0.6µs           |
| p75    | 0.6µs           |
| p99    | 0.8µs           |
| p999   | 1.1µs           |

## Observations

- `get()` cache hit is the dominant hot-path operation (every authenticated request) at p99 < 0.2µs — negligible compared to the network roundtrip.
- The cold path number above is the in-memory cost only. The real cold-path latency is dominated by scrypt verify (logN=15, ~50–100ms on dev hardware per `services/auth-cache.ts` comment) plus the DB read for `AccountRow + ApiKeyRow + rate-limit overrides`. Those bounds belong to a separate benchmark (autocannon against the running server, not in scope for V-120).

## What's intentionally NOT benched here

- Redis-backed `AuthCache` — Redis adds network latency (microseconds on local, ~1–2ms on Upstash). Bench would need a Redis fixture; deferred to a future autocannon-based suite.
- scrypt verify — slow by design (~50–100ms). Microbenchmarking it doesn't surface anything actionable; the design decision (D-020) is "amortise via cache, never weaken".
- Full request roundtrip — needs autocannon against a running server. Belongs to a separate `docs/benchmarks/api-endpoints.md` doc once that lands.

## How to re-run

```bash
npm run bench
```

Filters: `npx vitest bench --run apps/server/tests/bench/auth-cache.bench.ts` to run only this file.

## Adding new bench files

`vitest.config.ts` includes `apps/**/tests/bench/**/*.bench.ts`. New `*.bench.ts` files in that path are picked up automatically. Use `bench(name, fn)` from `vitest`. Tinybench provides hz/min/max/mean/p75/p99/p999/rme/samples.
