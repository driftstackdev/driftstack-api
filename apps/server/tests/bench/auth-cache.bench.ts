// V-120: Auth cache + sha256 microbenchmarks.
//
// Run via `npm run bench`. Output is mean / hz / p50 / p99 per bench;
// vitest's `bench()` harness uses tinybench under the hood for stats.
//
// Goal: establish baseline numbers for the hot auth path so future
// regressions are detectable. Baseline numbers are NOT persisted as a
// gate (a CI bench gate would be flaky on shared runners). Instead the
// numbers go into `docs/benchmarks/auth-path.md` snapshots, captured
// on demand.

import { bench, describe } from 'vitest';
import { createHash } from 'node:crypto';
import { InMemoryAuthCache } from '../../src/services/auth-cache.js';
import type { AccountContext, AccountRow, ApiKeyRow } from '../../src/services/auth.js';

function sampleAccount(): AccountRow {
  return {
    id: 'acc_bench',
    email: 'bench@driftstack.test',
    name: 'Bench Account',
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    createdAt: new Date('2026-05-04T00:00:00Z'),
    updatedAt: new Date('2026-05-04T00:00:00Z'),
  };
}

function sampleApiKey(): ApiKeyRow {
  return {
    id: 'key_bench',
    accountId: 'acc_bench',
    name: 'bench-key',
    keyPrefix: 'ds_test_aaaa',
    keyHash: 'scrypt$N=15$' + 'b'.repeat(64),
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-05-04T00:00:00Z'),
  };
}

function sampleContext(): AccountContext {
  return {
    account: sampleAccount(),
    apiKey: sampleApiKey(),
    rateLimitOverrides: {},
    teams: [],
  };
}

const PLAINTEXT = 'ds_test_' + 'a'.repeat(32);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const SHA = sha256(PLAINTEXT);

describe('sha256(plaintext) — cache key derivation', () => {
  // Every authenticated request hashes the bearer token to look up the
  // cache. This is one of two operations on the cache-hit path.
  bench('createHash sha256 hex digest', () => {
    sha256(PLAINTEXT);
  });
});

describe('InMemoryAuthCache — hot path', () => {
  // Pre-populate cache; bench measures the cache-hit return.
  const cache = new InMemoryAuthCache();
  void cache.set(SHA, 'key_bench', 'acc_bench', sampleContext(), 30);

  bench('get() — cache hit', async () => {
    await cache.get(SHA);
  });
});

describe('InMemoryAuthCache — cold path', () => {
  // Each iteration: empty cache, populate, then re-fetch. Measures the
  // miss + load + populate cost (sans actual scrypt verify or DB
  // load — those happen above the cache).
  bench('miss → set → hit roundtrip', async () => {
    const cache = new InMemoryAuthCache();
    await cache.get(SHA); // miss
    await cache.set(SHA, 'key_bench', 'acc_bench', sampleContext(), 30);
    await cache.get(SHA); // hit
  });
});
