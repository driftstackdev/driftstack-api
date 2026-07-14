import { expect, test } from '@playwright/test';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { sha256Hex } from '../../src/services/auth-cache.js';
import { authHeader, seedAccount } from './helpers/seed.js';
import { startTestServer, type TestServer } from './helpers/server.js';

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

async function warmApiKey(plaintext: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/v1/whoami`, {
    headers: authHeader(plaintext),
  });
  expect(response.status).toBe(200);
  const physicalCacheKey = `auth:apikey:${sha256Hex(plaintext)}`;
  expect(await server.redis.exists(physicalCacheKey)).toBe(1);
}

test('cached API key is rejected after direct PostgreSQL revoke with no Redis bump', async () => {
  const seeded = await seedAccount(server.client);
  await warmApiKey(seeded.plaintext);

  await server.client`
    UPDATE api_keys
    SET revoked_at = NOW()
    WHERE id = ${seeded.apiKeyId}
  `;

  const response = await fetch(`${server.baseUrl}/v1/whoami`, {
    headers: authHeader(seeded.plaintext),
  });
  expect(response.status).toBe(401);
  expect((await response.json()) as { type: string }).toMatchObject({
    type: PROBLEM_TYPES.RevokedKey,
  });
});

test('cached credential is rejected after direct account suspension with no Redis bump', async () => {
  const seeded = await seedAccount(server.client);
  await warmApiKey(seeded.plaintext);

  await server.client`
    UPDATE accounts
    SET status = 'suspended'
    WHERE id = ${seeded.accountId}
  `;

  const response = await fetch(`${server.baseUrl}/v1/whoami`, {
    headers: authHeader(seeded.plaintext),
  });
  expect(response.status).toBe(403);
  expect((await response.json()) as { type: string }).toMatchObject({
    type: PROBLEM_TYPES.Forbidden,
  });
});

test('cached credential is rejected after direct account deletion with no Redis bump', async () => {
  const seeded = await seedAccount(server.client);
  await warmApiKey(seeded.plaintext);

  await server.client`
    UPDATE accounts
    SET status = 'deleted', deleted_at = NOW()
    WHERE id = ${seeded.accountId}
  `;

  const response = await fetch(`${server.baseUrl}/v1/whoami`, {
    headers: authHeader(seeded.plaintext),
  });
  expect(response.status).toBe(401);
  expect((await response.json()) as { type: string }).toMatchObject({
    type: PROBLEM_TYPES.InvalidKey,
  });
});
