// V-540.B-2 — E2E walkthrough of /v1/account/rate-limits.
//
// Exercises the customer-facing rate-limit-view route. Surface is
// read-only; covered scenarios:
//  - happy path returns tier + per-bucket structure
//  - tier_default source when no override is active
//  - override source when an active override is in place (seeded via
//    direct DB insert mirroring the admin override path)
//  - expired override falls back to tier_default
//  - 401 without auth header

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

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

interface BucketEntry {
  bucket_key: 'global' | 'sessions:create';
  capacity: number;
  refill_per_second: number;
  source: 'tier_default' | 'override';
  override_expires_at: string | null;
}

interface RateLimitsResponse {
  tier: string;
  buckets: BucketEntry[];
}

test('GET /v1/account/rate-limits returns tier + buckets array', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/rate-limits`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as RateLimitsResponse;
  expect(body.tier).toBe(seed.tier);
  expect(Array.isArray(body.buckets)).toBe(true);
  expect(body.buckets.length).toBeGreaterThanOrEqual(2);
  const keys = body.buckets.map((b) => b.bucket_key);
  expect(keys).toContain('global');
  expect(keys).toContain('sessions:create');
});

test('default source is tier_default with capacity + refill positive numbers', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/rate-limits`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as RateLimitsResponse;
  for (const bucket of body.buckets) {
    expect(bucket.source).toBe('tier_default');
    expect(bucket.override_expires_at).toBeNull();
    expect(bucket.capacity).toBeGreaterThan(0);
    expect(bucket.refill_per_second).toBeGreaterThan(0);
  }
});

test('active override is reflected with source=override and an expiry timestamp', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000); // +1h
  await server.client`
    INSERT INTO rate_limit_overrides
      (account_id, bucket_key, capacity, refill_per_second_centi,
       expires_at, set_by_key_id)
    VALUES (${seed.accountId}, 'global', 9999, 100000, ${futureExpiry},
            ${seed.apiKeyId})
  `;

  const res = await request.get(`${server.baseUrl}/v1/account/rate-limits`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as RateLimitsResponse;
  const globalBucket = body.buckets.find((b) => b.bucket_key === 'global');
  expect(globalBucket).toBeDefined();
  expect(globalBucket?.source).toBe('override');
  expect(globalBucket?.capacity).toBe(9999);
  expect(globalBucket?.refill_per_second).toBe(1000);
  expect(globalBucket?.override_expires_at).not.toBeNull();

  // The OTHER bucket remains on tier_default (override was scoped to
  // 'global' only).
  const sessionsBucket = body.buckets.find((b) => b.bucket_key === 'sessions:create');
  expect(sessionsBucket?.source).toBe('tier_default');
});

test('expired override falls back to tier_default', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const pastExpiry = new Date(Date.now() - 60 * 1000); // -1m
  await server.client`
    INSERT INTO rate_limit_overrides
      (account_id, bucket_key, capacity, refill_per_second_centi,
       expires_at, set_by_key_id)
    VALUES (${seed.accountId}, 'global', 9999, 100000, ${pastExpiry},
            ${seed.apiKeyId})
  `;

  const res = await request.get(`${server.baseUrl}/v1/account/rate-limits`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as RateLimitsResponse;
  const globalBucket = body.buckets.find((b) => b.bucket_key === 'global');
  expect(globalBucket?.source).toBe('tier_default');
  expect(globalBucket?.capacity).not.toBe(9999);
});

test('returns 401 without Authorization header', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/account/rate-limits`);
  expect(res.status()).toBe(401);
});
