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

async function seedTeamMembership(args: {
  ownerAccountId: string;
  memberAccountId: string;
  role: 'admin' | 'member';
}): Promise<string> {
  const [row] = await server.client<{ id: string }[]>`
    INSERT INTO team_members (
      owner_account_id,
      member_account_id,
      role,
      invited_at,
      accepted_at,
      invited_by_account_id
    )
    VALUES (
      ${args.ownerAccountId},
      ${args.memberAccountId},
      ${args.role},
      NOW(),
      NOW(),
      ${args.ownerAccountId}
    )
    RETURNING id
  `;
  if (!row) throw new Error('failed to seed team membership');
  return row.id;
}

async function warmTeamGrant(args: {
  memberPlaintext: string;
  ownerAccountId: string;
}): Promise<void> {
  const response = await fetch(`${server.baseUrl}/v1/sessions`, {
    headers: {
      ...authHeader(args.memberPlaintext),
      'x-driftstack-account': `acc_${args.ownerAccountId}`,
    },
  });
  expect(response.status).toBe(200);
  const physicalCacheKey = `auth:apikey:${sha256Hex(args.memberPlaintext)}`;
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

test('cached team grant is rejected after direct membership removal with no Redis bump', async () => {
  const owner = await seedAccount(server.client, { email: 'owner-remove@example.test' });
  const member = await seedAccount(server.client, { email: 'member-remove@example.test' });
  const membershipId = await seedTeamMembership({
    ownerAccountId: owner.accountId,
    memberAccountId: member.accountId,
    role: 'admin',
  });
  await warmTeamGrant({ memberPlaintext: member.plaintext, ownerAccountId: owner.accountId });

  await server.client`DELETE FROM team_members WHERE id = ${membershipId}`;

  const response = await fetch(`${server.baseUrl}/v1/sessions`, {
    headers: {
      ...authHeader(member.plaintext),
      'x-driftstack-account': `acc_${owner.accountId}`,
    },
  });
  expect(response.status).toBe(403);
  expect((await response.json()) as { type: string }).toMatchObject({
    type: PROBLEM_TYPES.Forbidden,
  });
});

test('cached team admin demotion blocks owner-scoped write with no side effect', async () => {
  const owner = await seedAccount(server.client, { email: 'owner-demote@example.test' });
  const member = await seedAccount(server.client, { email: 'member-demote@example.test' });
  const membershipId = await seedTeamMembership({
    ownerAccountId: owner.accountId,
    memberAccountId: member.accountId,
    role: 'admin',
  });
  await warmTeamGrant({ memberPlaintext: member.plaintext, ownerAccountId: owner.accountId });

  await server.client`
    UPDATE team_members
    SET role = 'member'
    WHERE id = ${membershipId}
  `;

  const response = await fetch(`${server.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      ...authHeader(member.plaintext),
      'content-type': 'application/json',
      'x-driftstack-account': `acc_${owner.accountId}`,
    },
    body: JSON.stringify({ label: 'must-not-exist' }),
  });
  expect(response.status).toBe(403);
  const [count] = await server.client<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM sessions
    WHERE account_id = ${owner.accountId}
  `;
  expect(count?.count).toBe(0);
});

test('cached team grant is rejected when the owner becomes suspended', async () => {
  const owner = await seedAccount(server.client, { email: 'owner-suspend@example.test' });
  const member = await seedAccount(server.client, { email: 'member-suspend@example.test' });
  await seedTeamMembership({
    ownerAccountId: owner.accountId,
    memberAccountId: member.accountId,
    role: 'admin',
  });
  await warmTeamGrant({ memberPlaintext: member.plaintext, ownerAccountId: owner.accountId });

  await server.client`
    UPDATE accounts
    SET status = 'suspended'
    WHERE id = ${owner.accountId}
  `;

  const response = await fetch(`${server.baseUrl}/v1/sessions`, {
    headers: {
      ...authHeader(member.plaintext),
      'x-driftstack-account': `acc_${owner.accountId}`,
    },
  });
  expect(response.status).toBe(403);
});
