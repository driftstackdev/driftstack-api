// E2E rate-limit — exercises the RedisRateLimitStore Lua script under
// concurrent contention. The in-memory algorithm correctness is covered by
// tests/unit/rate-limit.test.ts; this suite asserts that Redis Lua agrees
// with the algorithm under load and that atomicity holds.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

test('429 RateLimited via real Redis Lua when bucket drained', async ({ request }) => {
  // Use free tier (global capacity = 60). Drain via direct Redis state
  // manipulation — the Lua script reads (tokens, last_ms) from the same hash.
  const seed = await seedAccount(server.client, { tier: 'trial_pack' });
  const key = `rl:${seed.accountId}:global`;
  await server.redis.hmset(key, 'tokens', '0', 'last_ms', Date.now().toString());
  await server.redis.expire(key, 120);

  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(429);
  expect(res.headers()['content-type']).toMatch(/application\/problem\+json/);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.RateLimited);
  expect(typeof body.retry_after_seconds).toBe('number');
  expect(res.headers()['retry-after']).toBeTruthy();
});

test('Lua atomicity: 100 concurrent calls with capacity=60 yield exactly 60 successes', async ({
  request,
}) => {
  // Free tier global capacity = 60, refill = 1 token / sec. Firing 100
  // concurrent calls within ~1s leaves at most ~1-2 tokens of refill, so
  // ~58-60 calls should succeed and ~40-42 should be 429. The Lua script
  // claims atomicity — i.e. across all 100 EVALs there's no race that lets
  // a 61st call succeed despite the bucket only having 60 tokens. Allow a
  // small refill window: assert successes ≤ 65.

  const seed = await seedAccount(server.client, { tier: 'trial_pack' });

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 100 }, () =>
      request
        .get(`${server.baseUrl}/v1/sessions`, { headers: authHeader(seed.plaintext) })
        .then((r) => r.status()),
    ),
  );
  const elapsedMs = Date.now() - start;

  const successes = results.filter((s) => s === 200).length;
  const denials = results.filter((s) => s === 429).length;

  // Every result must be one of the two expected codes.
  expect(successes + denials).toBe(100);

  // No 5xx leaks — atomicity guarantees no internal errors from races.
  for (const s of results) {
    expect(s === 200 || s === 429).toBe(true);
  }

  // Allow some refill — the test is non-instantaneous. At 1 tok/sec refill
  // and elapsedMs ~ 100-1500ms, refill is at most ~2 tokens. So successes
  // should be in [60, 60 + ceil(elapsedMs / 1000) + 2].
  const maxAllowedSuccesses = 60 + Math.ceil(elapsedMs / 1000) + 2;
  expect(successes).toBeGreaterThanOrEqual(60);
  expect(successes).toBeLessThanOrEqual(maxAllowedSuccesses);
  expect(denials).toBeGreaterThanOrEqual(100 - maxAllowedSuccesses);
});

test('different accounts have independent buckets', async ({ request }) => {
  const a = await seedAccount(server.client, { tier: 'trial_pack', email: 'a@bucket.test' });
  const b = await seedAccount(server.client, { tier: 'trial_pack', email: 'b@bucket.test' });

  // Drain account A's bucket via direct Redis.
  await server.redis.hmset(
    `rl:${a.accountId}:global`,
    'tokens',
    '0',
    'last_ms',
    Date.now().toString(),
  );

  const aRes = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(a.plaintext),
  });
  expect(aRes.status()).toBe(429);

  const bRes = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(b.plaintext),
  });
  expect(bRes.status()).toBe(200);
});
