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

async function seedTeamAdmin(ownerAccountId: string, memberAccountId: string): Promise<void> {
  await server.client`
    INSERT INTO team_members (
      owner_account_id,
      member_account_id,
      role,
      invited_at,
      accepted_at,
      invited_by_account_id
    )
    VALUES (
      ${ownerAccountId},
      ${memberAccountId},
      'admin',
      NOW(),
      NOW(),
      ${ownerAccountId}
    )
  `;
}

test('429 RateLimited via real Redis Lua when bucket drained', async ({ request }) => {
  // Paid tier deliberately: `3202fdb17` / `e9b6cd91d` made Free an interactive
  // DESKTOP tier with no programmatic API access, so an ordinary free-tier key
  // is refused 403 `apiAccess` at the auth boundary BEFORE the limiter ever
  // runs — which would make this assert 403 for a reason unrelated to Redis.
  // The bucket is force-drained below, so the tier's own capacity is irrelevant.
  const seed = await seedAccount(server.client, { tier: 'api_starter' });
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
  // Capacity 60, refill 1 token / sec. Firing 100 concurrent calls within ~1s
  // leaves at most ~1-2 tokens of refill, so ~58-60 calls should succeed and
  // ~40-42 should be 429. The Lua script claims atomicity — i.e. across all
  // 100 EVALs there's no race that lets a 61st call succeed despite the bucket
  // only having 60 tokens. Allow a small refill window.
  //
  // Those two numbers used to be inherited from the free tier's defaults. They
  // are now pinned by an explicit override on a PAID tier, for two reasons:
  // Free became a desktop tier with no programmatic API access (403 at auth,
  // before the limiter), and an atomicity proof should not silently re-scale
  // itself the next time the tier table moves.
  const seed = await seedAccount(server.client, { tier: 'api_starter' });
  await server.client`
    INSERT INTO rate_limit_overrides (
      account_id,
      bucket_key,
      capacity,
      refill_per_second_centi,
      expires_at,
      set_by_key_id
    )
    VALUES (
      ${seed.accountId},
      'global',
      60,
      100,
      NOW() + INTERVAL '1 hour',
      ${seed.apiKeyId}
    )
  `;

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
  // Paid tier — Free has no programmatic API access and would 403 at auth
  // before either bucket is consulted.
  const a = await seedAccount(server.client, { tier: 'api_starter', email: 'a@bucket.test' });
  const b = await seedAccount(server.client, { tier: 'api_starter', email: 'b@bucket.test' });

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

test('two admins contend atomically on one capacity-one effective-owner bucket', async ({
  request,
}) => {
  const owner = await seedAccount(server.client, {
    tier: 'free',
    email: 'owner@dual-limit.e2e',
  });
  const first = await seedAccount(server.client, {
    tier: 'api_scale',
    scopes: ['read'],
    email: 'admin-a@dual-limit.e2e',
  });
  const second = await seedAccount(server.client, {
    tier: 'api_scale',
    scopes: ['read'],
    email: 'admin-b@dual-limit.e2e',
  });
  await seedTeamAdmin(owner.accountId, first.accountId);
  await seedTeamAdmin(owner.accountId, second.accountId);

  // One token and a 0.01 token/second refill keeps the contention window
  // deterministic while still exercising the production Redis Lua path.
  await server.client`
    INSERT INTO rate_limit_overrides (
      account_id,
      bucket_key,
      capacity,
      refill_per_second_centi,
      expires_at,
      set_by_key_id
    )
    VALUES (
      ${owner.accountId},
      'global',
      1,
      1,
      NOW() + INTERVAL '1 hour',
      ${owner.apiKeyId}
    )
  `;
  const ownerKey = `rl:${owner.accountId}:global`;
  await server.redis.hmset(ownerKey, 'tokens', '1', 'last_ms', Date.now().toString());
  await server.redis.expire(ownerKey, 120);

  const headersFor = (plaintext: string) => ({
    ...authHeader(plaintext),
    'x-driftstack-account': `acc_${owner.accountId}`,
  });
  const responses = await Promise.all([
    request.get(`${server.baseUrl}/v1/sessions`, { headers: headersFor(first.plaintext) }),
    request.get(`${server.baseUrl}/v1/sessions`, { headers: headersFor(second.plaintext) }),
  ]);

  expect(responses.map((response) => response.status()).sort()).toEqual([200, 429]);
  const denied = responses.find((response) => response.status() === 429);
  expect(denied).toBeDefined();
  const deniedHeaders = denied!.headers();
  expect(deniedHeaders['retry-after']).toBeTruthy();
  for (const header of [
    'x-ratelimit-bucket',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
  ]) {
    expect(deniedHeaders[header]).toBeUndefined();
  }
  const problem = (await denied!.json()) as Record<string, unknown>;
  expect(problem).toMatchObject({
    type: PROBLEM_TYPES.RateLimited,
    detail: 'Rate limit exceeded.',
  });
  expect(JSON.stringify(problem)).not.toContain('free');
  expect(JSON.stringify(problem)).not.toContain('capacity');
});
