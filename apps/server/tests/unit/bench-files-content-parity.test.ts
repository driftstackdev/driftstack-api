// W793 — V-120/V-123/V-124 bench-file content parity bundle. One-
// hundred-nineteenth in the cross-SDK drift-guard series.
//
// Pins the 3 microbenchmark files that establish baseline numbers
// for the hot paths:
//   - V-120 auth-cache.bench.ts (sha256 + cache hit + cold path)
//   - V-123 rate-limit.bench.ts (consume happy/refill/denied)
//   - V-124 webhook-signature.bench.ts (SDK verify, small/large body)
//
// All three feed `docs/benchmarks/*.md` snapshots. Drift to the
// scenarios or framing would let future refactors silently change
// what the baseline measures.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AUTH_CACHE = resolve(REPO_ROOT, 'apps/server/tests/bench/auth-cache.bench.ts');
const RATE_LIMIT = resolve(REPO_ROOT, 'apps/server/tests/bench/rate-limit.bench.ts');
const WH_SIG = resolve(REPO_ROOT, 'packages/sdk-typescript/tests/bench/webhook-signature.bench.ts');

describe('W793 V-120/V-123/V-124 bench-file content parity', () => {
  it('all 3 bench files exist at canonical paths', () => {
    expect(existsSync(AUTH_CACHE)).toBe(true);
    expect(existsSync(RATE_LIMIT)).toBe(true);
    expect(existsSync(WH_SIG)).toBe(true);
  });

  // ─── auth-cache.bench.ts (V-120) ──────────────────────────────

  it("CRITICAL V-120 + npm-run-bench + tinybench framing pinned. The 'V-120: Auth cache + sha256 microbenchmarks. Run via npm run bench. Output is mean / hz / p50 / p99 per bench; vitest\\'s bench() harness uses tinybench under the hood for stats' wording threads the W-NNN bench-config separation contract.", () => {
    const p = read(AUTH_CACHE);

    expect(p).toMatch(/V-120: Auth cache \+ sha256 microbenchmarks\./);
    expect(p).toMatch(/Run via `npm run bench`\. Output is mean \/ hz \/ p50 \/ p99 per bench;/);
    expect(p).toMatch(/vitest's `bench\(\)` harness uses tinybench under the hood for stats\./);
  });

  it("CRITICAL baseline-not-CI-gate framing pinned. The 'Baseline numbers are NOT persisted as a gate (a CI bench gate would be flaky on shared runners). Instead the numbers go into docs/benchmarks/auth-path.md snapshots, captured on demand' wording is the load-bearing flaky-CI rationale.", () => {
    const p = read(AUTH_CACHE);

    expect(p).toMatch(/Baseline numbers are NOT persisted as a/);
    expect(p).toMatch(/gate \(a CI bench gate would be flaky on shared runners\)\. Instead the/);
    expect(p).toMatch(/numbers go into `docs\/benchmarks\/auth-path\.md` snapshots, captured/);
    expect(p).toMatch(/on demand\./);
  });

  it('CRITICAL auth-cache 3-scenario set pinned — sha256(plaintext) cache-key derivation + InMemoryAuthCache hot path + cold path miss→set→hit roundtrip. Drift to dropping any would lose baseline coverage on the hot auth path.', () => {
    const p = read(AUTH_CACHE);

    expect(p).toMatch(/describe\('sha256\(plaintext\) — cache key derivation'/);
    expect(p).toMatch(/describe\('InMemoryAuthCache — hot path'/);
    expect(p).toMatch(/describe\('InMemoryAuthCache — cold path'/);
    expect(p).toMatch(/bench\('createHash sha256 hex digest'/);
    expect(p).toMatch(/bench\('get\(\) — cache hit'/);
    expect(p).toMatch(/bench\('miss → set → hit roundtrip'/);
  });

  it('CRITICAL sampleAccount/sampleApiKey/sampleContext 3-factory framing pinned. The factories produce realistic AccountRow/ApiKeyRow/AccountContext shapes — drift to dropping a field would break baseline measurement realism.', () => {
    const p = read(AUTH_CACHE);

    expect(p).toMatch(/function sampleAccount\(\): AccountRow \{/);
    expect(p).toMatch(/function sampleApiKey\(\): ApiKeyRow \{/);
    expect(p).toMatch(/function sampleContext\(\): AccountContext \{/);
    // sampleApiKey scrypt$N=15$ shape matches V-205 + W746 server-side contract.
    expect(p).toMatch(/keyHash: 'scrypt\$N=15\$' \+ 'b'\.repeat\(64\)/);
  });

  // ─── rate-limit.bench.ts (V-123) ──────────────────────────────

  it("CRITICAL V-123 + token-bucket consume() framing pinned. The 'V-123: Rate-limit token-bucket consume() microbenchmarks. Every authenticated request hits MemoryRateLimitStore.consume() (or its Redis equivalent in production)' wording is the load-bearing hot-path context.", () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(/V-123: Rate-limit token-bucket consume\(\) microbenchmarks\./);
    expect(p).toMatch(
      /Every authenticated request hits `MemoryRateLimitStore\.consume\(\)`\s*\n?\/\/ \(or its Redis equivalent in production\)\./,
    );
  });

  it("CRITICAL same-harness-as-V-120 framing pinned. The 'Same harness as V-120\\'s auth cache bench: vitest\\'s built-in bench() over tinybench' wording threads the cross-bench consistency claim.", () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(
      /Same harness as V-120's auth\s*\n?\/\/ cache bench: vitest's built-in `bench\(\)` over tinybench\./,
    );
  });

  it('CRITICAL rate-limit 3-scenario set pinned — happy path (bucket has tokens) + refill+consume + denied path (over budget). Each describe explores a different code path in the consume math.', () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(
      /describe\('MemoryRateLimitStore\.consume — happy path \(bucket has tokens\)'/,
    );
    expect(p).toMatch(/describe\('MemoryRateLimitStore\.consume — refill \+ consume'/);
    expect(p).toMatch(/describe\('MemoryRateLimitStore\.consume — denied path \(over budget\)'/);
  });

  it('CRITICAL happy-path uses fresh-key-per-call framing pinned. The \'Use a fresh key per call so we always hit the "first consume on a new bucket" path\' wording explains the production-shape rationale.', () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(
      /\/\/ Use a fresh key per call so we always hit the "first consume on a\s*\n\s+\/\/ new bucket" path \(bucket initialized at full capacity, immediately\s*\n\s+\/\/ serves the request\)\./,
    );
    expect(p).toMatch(/const key = `bench_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2\)\}`;/);
  });

  it("CRITICAL refill-test 100ms-per-tick = 1-token framing pinned. The 'Advance time so refill kicks in. 100ms per tick = 1 token refilled' wording explains the refill-rate math.", () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(/\/\/ Advance time so refill kicks in\. 100ms per tick = 1 token refilled\./);
    expect(p).toMatch(/refillPerSecond: 10,/);
    expect(p).toMatch(/now: baseTime \+ tick \* 100,/);
  });

  it("CRITICAL denied-path bucket-pre-drained framing pinned. The 'Pre-drain a bucket so every consume() returns allowed=false. Tests the denial-with-retryAfter computation' wording is the load-bearing denial-cost context.", () => {
    const p = read(RATE_LIMIT);

    expect(p).toMatch(
      /\/\/ Pre-drain a bucket so every consume\(\) returns allowed=false\. Tests\s*\n\s+\/\/ the denial-with-retryAfter computation\./,
    );
    expect(p).toMatch(/refillPerSecond: 0\.001/);
  });

  // ─── webhook-signature.bench.ts (V-124) ───────────────────────

  it("CRITICAL V-124 + customer-cost framing pinned. The 'V-124: Webhook signature verify microbenchmark. Customers call verifyWebhookSignature once per inbound webhook delivery. Latency here directly affects customer infra cost' wording is the load-bearing customer-impact framing.", () => {
    const p = read(WH_SIG);

    expect(p).toMatch(/V-124: Webhook signature verify microbenchmark\./);
    expect(p).toMatch(
      /Customers call `verifyWebhookSignature` once per inbound webhook\s*\n?\/\/ delivery\. Latency here directly affects customer infra cost\./,
    );
  });

  it("CRITICAL SubtleCrypto HMAC-SHA256 dominant-cost framing pinned. The 'SubtleCrypto HMAC-SHA256 is the dominant cost; the surrounding parse + timestamp tolerance are negligible' wording is the load-bearing perf-attribution comment.", () => {
    const p = read(WH_SIG);

    expect(p).toMatch(
      /SubtleCrypto\s*\n?\/\/ HMAC-SHA256 is the dominant cost; the surrounding parse \+ timestamp\s*\n?\/\/ tolerance are negligible\./,
    );
  });

  it('CRITICAL whsec_-prefix + 48-char secret framing pinned. Matches W750 dashboard /api-keys ds_<env>_ + W762 ds_live_ secret-format convention; whsec_ is the webhook signing secret prefix.', () => {
    const p = read(WH_SIG);

    expect(p).toMatch(/const SECRET = 'whsec_'\.padEnd\(48, 'a'\);/);
  });

  it('CRITICAL 70-byte small + 10K large body sizes pinned. The 2 body shapes cover SubtleCrypto-HMAC scaling across the typical (small) + edge (10K) payload distribution.', () => {
    const p = read(WH_SIG);

    expect(p).toMatch(
      /const BODY_SMALL = JSON\.stringify\(\{ event: 'session\.completed', id: 'sess_test' \}\);/,
    );
    expect(p).toMatch(/payload: 'x'\.repeat\(10_000\)/);
  });

  it('CRITICAL webhook-signature 3-bench set pinned — valid small + invalid small (constant-time compare still runs) + valid large body. The invalid-small bench measures the constant-time-compare branch which must NOT short-circuit on signature mismatch.', () => {
    const p = read(WH_SIG);

    expect(p).toMatch(/bench\('valid signature, small body'/);
    expect(p).toMatch(
      /bench\('invalid signature, small body \(constant-time compare still runs\)'/,
    );
    expect(p).toMatch(/bench\('valid signature, large body'/);
  });

  it('CRITICAL t=<unix-seconds>,v1=<hex> header-format helper pinned. The makeHeader() function produces `t=${t},v1=${hex}` — matches W787 webhooks/events.md Driftstack-Signature format.', () => {
    const p = read(WH_SIG);

    expect(p).toMatch(/function makeHeader\(body: string, secret: string\): string \{/);
    expect(p).toMatch(/return `t=\$\{t\.toString\(\)\},v1=\$\{hex\}`;/);
  });

  it("CRITICAL HEADER_BAD all-zeros-64-hex framing pinned. The 'v1=' + '0'.repeat(64) is the canonical 'definitely-wrong' signature for measuring constant-time-compare denial cost.", () => {
    const p = read(WH_SIG);

    expect(p).toMatch(
      /const HEADER_BAD = `t=\$\{Math\.floor\(Date\.now\(\) \/ 1000\)\.toString\(\)\},v1=\$\{'0'\.repeat\(64\)\}`;/,
    );
  });

  it('CRITICAL all 3 use vitest bench() + describe() — not Vitest test()/it(). Drift to test() would let bench files run on the default test suite (which excludes the bench glob via V-120 config).', () => {
    expect(read(AUTH_CACHE)).toMatch(/import \{ bench, describe \} from 'vitest';/);
    expect(read(RATE_LIMIT)).toMatch(/import \{ bench, describe \} from 'vitest';/);
    expect(read(WH_SIG)).toMatch(/import \{ bench, describe \} from 'vitest';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/bench-files-content-parity.test.ts')),
    ).toBe(true);
  });
});
