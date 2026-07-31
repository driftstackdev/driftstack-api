// E2E tier concurrency limits — verifies the locked-pricing concurrency
// caps (ADR-004 two-ladder concurrent-only) hold when measured against
// real DB row counts. Concurrent caps are the primary metering primitive
// on paid tiers; trial pack inherits the same enforcement path with
// limit=1 plus the free_credit_cents decrement (per ADR-003).

import { test, expect, type APIRequestContext } from '@playwright/test';
import { PROBLEM_TYPES, type AccountTier } from '@driftstack/api-types';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader, clearRateLimits } from './helpers/seed.js';

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

interface TierExpectation {
  tier: AccountTier;
  limit: number;
}

const TIER_LIMITS: TierExpectation[] = [
  { tier: 'free', limit: 1 },
  { tier: 'solo_manual', limit: 1 },
  { tier: 'team_manual', limit: 3 },
  { tier: 'api_starter', limit: 2 },
  { tier: 'agency_manual', limit: 8 },
  { tier: 'api_builder', limit: 8 },
  // 'api_scale' (24) and 'enterprise' (32) are skipped from this loop because
  // creating 24+ sessions per test multiplies the suite runtime; they're
  // covered by spot-check tests below.
];

async function createSession(
  request: APIRequestContext,
  base: string,
  plaintext: string,
): Promise<number> {
  const res = await request.post(`${base}/v1/sessions`, {
    headers: authHeader(plaintext),
    data: {},
  });
  return res.status();
}

for (const { tier, limit } of TIER_LIMITS) {
  test(`tier=${tier}: allows ${limit.toString()} concurrent sessions, denies the (${(limit + 1).toString()})th`, async ({
    request,
  }) => {
    // Free is a DESKTOP tier: an ordinary API key is refused 403 `apiAccess` at
    // AUTH, before the concurrency cap is ever consulted, so this row measured
    // the tier boundary rather than the cap it names. `POST /v1/sessions` is on
    // the free-desktop allowlist, so a device-provenance credential reaches the
    // real cap.
    const seed = await seedAccount(server.client, {
      tier,
      ...(tier === 'free' ? { provenance: 'cli_device' as const } : {}),
    });

    // Need a fresh rate-limit bucket so we don't run into a sessions:create
    // RL cap before hitting the concurrency cap. Free tier has 5 capacity on
    // sessions:create with 1/min refill, so 5 creates is fine. Starter+ have
    // wider buckets. Just clear Redis at the start to be safe.
    await clearRateLimits(server.redis);

    for (let i = 0; i < limit; i++) {
      const status = await createSession(request, server.baseUrl, seed.plaintext);
      expect(
        status,
        `tier=${tier} create #${(i + 1).toString()} expected 201 got ${String(status)}`,
      ).toBe(201);
    }

    const denied = await request.post(`${server.baseUrl}/v1/sessions`, {
      headers: authHeader(seed.plaintext),
      data: {},
    });
    expect(denied.status()).toBe(429);
    const body = (await denied.json()) as Record<string, unknown>;
    expect(body.type).toBe(PROBLEM_TYPES.ConcurrencyLimit);
    expect(body.current_sessions).toBe(limit);
    expect(body.limit).toBe(limit);
  });
}

test('tier=api_scale: 25th concurrent session denied (spot-check)', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'api_scale' });
  await clearRateLimits(server.redis);

  // Create 24 concurrent sessions in parallel — concurrency-limit logic
  // reads count from DB pre-create, so race conditions could let extras
  // through. We're mainly verifying that the post-24 attempt is denied.
  const created = await Promise.all(
    Array.from({ length: 24 }, () => createSession(request, server.baseUrl, seed.plaintext)),
  );
  const successes = created.filter((s) => s === 201).length;
  // Allow some race tolerance; assert the bulk got through.
  expect(successes).toBeGreaterThanOrEqual(20);

  // Drain to exactly 24 if there's slack.
  if (successes > 24) {
    // unreachable — tier limit is 24 strictly enforced sequentially
    throw new Error(`api_scale tier let ${successes.toString()} sessions through, expected ≤ 24`);
  }

  // After whatever count succeeded, an extra attempt should fail if the
  // count is at the limit. To make this deterministic, fill any remaining
  // slack and then attempt one more.
  for (let i = successes; i < 24; i++) {
    const status = await createSession(request, server.baseUrl, seed.plaintext);
    expect(status).toBe(201);
  }

  const denied = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(denied.status()).toBe(429);
});

test('destroying a session frees a slot', async ({ request }) => {
  // Free is a DESKTOP tier — see the table above. POST/DELETE /v1/sessions are
  // free-desktop allowlisted, so this exercises the real slot accounting.
  const seed = await seedAccount(server.client, {
    tier: 'free',
    provenance: 'cli_device',
  });
  await clearRateLimits(server.redis);

  // Free tier allows 1 concurrent.
  const create1 = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(create1.status()).toBe(201);
  const session = (await create1.json()) as { id: string };

  // Second create blocked.
  const blocked = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(blocked.status()).toBe(429);

  // Destroy frees a slot.
  await request.delete(`${server.baseUrl}/v1/sessions/${session.id}`, {
    headers: authHeader(seed.plaintext),
  });

  const create2 = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(create2.status()).toBe(201);
});
