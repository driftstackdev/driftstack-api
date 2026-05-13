// W570.A — drift guard for /docs/benchmarks/auth-path.md.
// V-120 perf-baseline snapshot 2026-05-04. Drift here either weakens
// the "not-a-CI-gate" framing, distorts the 3-bench hz ladder (sha256
// 2.4M / cache-hit 9.1M / miss-set-hit 1.6M ops/s), or unsets the
// scrypt verify ~50-100ms reference + D-020 amortise posture.
//
//   • V-120 baseline. NOT a CI gate.
//   • Apple M-class dev hardware, Node v25, Vitest 2.1.9 tinybench.
//   • 3 micro-benchmarks: sha256 / InMemoryAuthCache.get() /
//     miss→set→hit roundtrip.
//   • Excluded from scope: Redis cache + scrypt verify + full roundtrip.
//   • D-020: amortise via cache, never weaken scrypt logN=15.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/benchmarks/auth-path.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W570.A /docs/benchmarks/auth-path.md content parity', () => {
  const body = read(LIB);

  it('Header + V-120-baseline-2026-05-04 + not-a-CI-gate + Apple-M-Node-v25-Vitest-2.1.9-tinybench framing pinned', () => {
    expect(body).toMatch(/^# Auth path benchmarks$/m);
    expect(body).toMatch(
      /Snapshot of `npm run bench` output for `apps\/server\/tests\/bench\/auth-cache\.bench\.ts`\./,
    );
    expect(body).toMatch(/Re-run on demand; numbers vary by hardware\./);
    expect(body).toMatch(
      /\*\*Not a CI gate\*\* — bench results on shared runners are too noisy to fail builds on\./,
    );
    expect(body).toMatch(
      /Snapshots here are reference points for spotting regressions during local profiling\./,
    );
    expect(body).toMatch(/## Baseline \(V-120, 2026-05-04\)/);
    expect(body).toMatch(
      /Hardware: Apple M-class \(dev workstation, no thermal throttling, ~no concurrent load\)\./,
    );
    expect(body).toMatch(
      /Node: v25 local\. Vitest: 2\.1\.9 with built-in `bench` \(tinybench under the hood\)\./,
    );
  });

  it('sha256-cache-key + InMemoryAuthCache.get-hit + miss-set-hit-roundtrip 3 benchmark tables framing pinned', () => {
    expect(body).toMatch(/### `sha256\(plaintext\)` — cache-key derivation/);
    expect(body).toMatch(
      /Every authenticated request runs this once to derive the cache key from the bearer token\./,
    );
    expect(body).toMatch(/\| hz\s+\| 2,406,539 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 0\.4µs\s+\|/);
    expect(body).toMatch(/\| p75\s+\| 0\.4µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 0\.7µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 1\.5µs\s+\|/);
    expect(body).toMatch(/### `InMemoryAuthCache\.get\(\)` — cache hit/);
    expect(body).toMatch(
      /The hot path: bearer token sha256 maps to a populated cache entry, version \+ expiry checks pass, `AccountContext` returned\./,
    );
    expect(body).toMatch(/\| hz\s+\| 9,122,173 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 0\.1µs\s+\|/);
    expect(body).toMatch(/\| p75\s+\| 0\.1µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 0\.2µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 0\.4µs\s+\|/);
    expect(body).toMatch(/### Cache miss → set → hit roundtrip/);
    expect(body).toMatch(/Empty cache, lookup misses, populate, re-fetch hit\./);
    expect(body).toMatch(
      /Excludes the actual scrypt verify \+ DB load that happen ABOVE the cache on a real cache miss\./,
    );
    expect(body).toMatch(/\| hz\s+\| 1,621,288 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 0\.6µs\s+\|/);
    expect(body).toMatch(/\| p75\s+\| 0\.6µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 0\.8µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 1\.1µs\s+\|/);
  });

  it('Observations + intentionally-NOT-benched + how-to-re-run + adding-new-bench framing pinned', () => {
    expect(body).toMatch(/## Observations/);
    expect(body).toMatch(
      /- `get\(\)` cache hit is the dominant hot-path operation \(every authenticated request\) at p99 < 0\.2µs/,
    );
    expect(body).toMatch(/— negligible compared to the network roundtrip\./);
    expect(body).toMatch(/- The cold path number above is the in-memory cost only\./);
    expect(body).toMatch(
      /The real cold-path latency is dominated by scrypt verify \(logN=15, ~50–100ms on dev hardware/,
    );
    expect(body).toMatch(
      /per `services\/auth-cache\.ts` comment\) plus the DB read for `AccountRow \+ ApiKeyRow \+ rate-limit overrides`\./,
    );
    expect(body).toMatch(
      /Those bounds belong to a separate benchmark \(autocannon against the running server, not in scope for V-120\)\./,
    );
    expect(body).toMatch(/## What's intentionally NOT benched here/);
    expect(body).toMatch(
      /- Redis-backed `AuthCache` — Redis adds network latency \(microseconds on local, ~1–2ms on Upstash\)\./,
    );
    expect(body).toMatch(
      /Bench would need a Redis fixture; deferred to a future autocannon-based suite\./,
    );
    expect(body).toMatch(/- scrypt verify — slow by design \(~50–100ms\)\./);
    expect(body).toMatch(/Microbenchmarking it doesn't surface anything actionable;/);
    expect(body).toMatch(/the design decision \(D-020\) is "amortise via cache, never weaken"\./);
    expect(body).toMatch(/- Full request roundtrip — needs autocannon against a running server\./);
    expect(body).toMatch(
      /Belongs to a separate `docs\/benchmarks\/api-endpoints\.md` doc once that lands\./,
    );
    expect(body).toMatch(/## How to re-run/);
    expect(body).toMatch(/npm run bench/);
    expect(body).toMatch(
      /Filters: `npx vitest bench --run apps\/server\/tests\/bench\/auth-cache\.bench\.ts` to run only this file\./,
    );
    expect(body).toMatch(/## Adding new bench files/);
    expect(body).toMatch(
      /`vitest\.config\.ts` includes `apps\/\*\*\/tests\/bench\/\*\*\/\*\.bench\.ts`\./,
    );
    expect(body).toMatch(/New `\*\.bench\.ts` files in that path are picked up automatically\./);
    expect(body).toMatch(/Use `bench\(name, fn\)` from `vitest`\./);
    expect(body).toMatch(/Tinybench provides hz\/min\/max\/mean\/p75\/p99\/p999\/rme\/samples\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
