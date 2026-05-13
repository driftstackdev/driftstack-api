// W571.A — drift guard for /docs/benchmarks/rate-limit.md.
// V-123 perf-baseline snapshot 2026-05-04. Drift here either weakens
// the not-a-CI-gate framing or distorts the 3-path hz ladder
// (fresh-bucket 1.6M / refill+consume 7.9M / denied 8.9M ops/s).
//
//   • V-123 baseline. NOT a CI gate (see auth-path.md rationale).
//   • Apple M-class, Node v25, Vitest 2.1.9 tinybench.
//   • 3 paths: fresh-bucket consume / refill+consume / denied.
//   • Excluded: Redis-backed RateLimitStore + override resolution.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/benchmarks/rate-limit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W571.A /docs/benchmarks/rate-limit.md content parity', () => {
  const body = read(LIB);

  it('Header + V-123-baseline + Apple-M + Node-v25 + Vitest-2.1.9 + not-a-CI-gate framing pinned', () => {
    expect(body).toMatch(/^# Rate-limit benchmarks$/m);
    expect(body).toMatch(
      /Snapshot of `npm run bench` output for `apps\/server\/tests\/bench\/rate-limit\.bench\.ts`\./,
    );
    expect(body).toMatch(/Re-run on demand; numbers vary by hardware\./);
    expect(body).toMatch(/\*\*Not a CI gate\*\* — see `auth-path\.md` for the rationale\./);
    expect(body).toMatch(/## Baseline \(V-123, 2026-05-04\)/);
    expect(body).toMatch(
      /Hardware: Apple M-class \(dev workstation, no thermal throttling, ~no concurrent load\)\./,
    );
    expect(body).toMatch(
      /Node: v25 local\. Vitest: 2\.1\.9 with built-in `bench` \(tinybench under the hood\)\./,
    );
  });

  it('3 paths (fresh-bucket / refill+consume / denied) bench tables framing pinned', () => {
    expect(body).toMatch(/### Happy path: `consume\(cost=1\)` against a fresh bucket/);
    expect(body).toMatch(
      /Each iteration uses a new key, so the bucket initializes at full capacity and immediately serves\./,
    );
    expect(body).toMatch(
      /Includes the `Math\.random\(\)\.toString\(36\)\.slice\(2\)` key generation overhead, so this number is conservative\./,
    );
    expect(body).toMatch(/\| hz\s+\| 1,645,889 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 0\.6µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 1\.1µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 3\.8µs\s+\|/);
    expect(body).toMatch(/### Refill \+ consume on existing bucket \(the production hot path\)/);
    expect(body).toMatch(
      /Same key across calls, advancing time per iteration so refill math fires\./,
    );
    expect(body).toMatch(
      /Closest match to the production "key gets requests at sustained rate" pattern\./,
    );
    expect(body).toMatch(/\| hz\s+\| 7,883,370 ops\/s \|/);
    expect(body).toMatch(/\| mean\s+\| 0\.1µs\s+\|/);
    expect(body).toMatch(/\| p99\s+\| 0\.3µs\s+\|/);
    expect(body).toMatch(/\| p999\s+\| 1\.2µs\s+\|/);
    expect(body).toMatch(/### Denied path: bucket empty, `allowed: false`/);
    expect(body).toMatch(
      /Bucket pre-drained, every consume\(\) returns `allowed: false` with a computed `retryAfterMs`\./,
    );
    expect(body).toMatch(/\| hz\s+\| 8,939,258 ops\/s \|/);
    expect(body).toMatch(/\| p99\s+\| 0\.2µs\s+\|/);
    expect(body).toMatch(/\| p995\s+\| 0\.3µs\s+\|/);
  });

  it('Observations + Excluded-from-scope + How-to-re-run framing pinned', () => {
    expect(body).toMatch(/## Observations/);
    expect(body).toMatch(
      /- The hot path \(`refill \+ consume`\) at p99 0\.3µs and the denied path at p99 0\.2µs are both negligible relative to the surrounding network roundtrip\./,
    );
    expect(body).toMatch(
      /- The "fresh bucket" path is dominated by the per-iteration random key allocation \(test artifact\)\./,
    );
    expect(body).toMatch(
      /Real production fresh-bucket consumes don't generate strings on the fly\./,
    );
    expect(body).toMatch(
      /- All three branches share a single small `Map` lookup \+ arithmetic — no I\/O — so total cost is JS engine \+ GC\./,
    );
    expect(body).toMatch(
      /JIT warmup brings sustained throughput well above 1M ops\/s for every shape\./,
    );
    expect(body).toMatch(/## What's intentionally NOT benched here/);
    expect(body).toMatch(
      /- Redis-backed `RateLimitStore` \(production multi-instance variant\) — adds ~0\.5–2ms network roundtrip per call\./,
    );
    expect(body).toMatch(/Belongs to the autocannon-against-server suite when that lands\./);
    expect(body).toMatch(
      /- Production rate-limit override resolution — that path is in `services\/rate-limit\.ts` orchestration around the store, not the store itself\./,
    );
    expect(body).toMatch(/## How to re-run/);
    expect(body).toMatch(/npm run bench/);
    expect(body).toMatch(
      /npx vitest bench --run apps\/server\/tests\/bench\/rate-limit\.bench\.ts/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
