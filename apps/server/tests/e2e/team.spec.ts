// V-540.B-9 — E2E walkthrough of /v1/team/* routes.
//
// Covers:
//  - POST /v1/team/invites enqueues an invite (202).
//  - GET /v1/team/invites lists pending invites for the owner.
//  - POST /v1/team/invites/accept consumes a token + creates a
//    membership row for the accepting account.
//  - GET /v1/team/members lists memberships from the OWNER's
//    perspective ("my members").
//  - GET /v1/team/owners lists memberships from the MEMBER's
//    perspective ("teams I am on").
//  - DELETE /v1/team/members/:id removes a membership.
//  - 401 on every route without auth.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

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

interface InviteEntry {
  id: string;
  invitee_email: string;
  role: 'member' | 'admin';
  expires_at: string;
}

interface MemberEntry {
  id: string;
  owner_account_id: string;
  member_account_id: string;
  member_email: string;
  role: 'member' | 'admin';
  invited_at: string;
  accepted_at: string;
  invited_by_account_id: string | null;
}

interface OwnerEntry {
  owner_account_id: string;
  role: string;
  membership_id: string;
}

/** Seeds a team_invites row directly so we can exercise the accept
 *  path without depending on real email delivery. Returns the
 *  plaintext token the accept endpoint expects. */
async function seedInvite(
  client: TestServer['client'],
  ownerAccountId: string,
  inviteeEmail: string,
  role: 'member' | 'admin' = 'member',
): Promise<{ token: string; inviteId: string }> {
  const token = `inv-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const id = randomUUID();
  // 2026-05-20 — pre-serialize Date to ISO; postgres-js Bind step
  // doesn't accept raw Date params (drizzle 0.38.4 transparentParser
  // swap; same fix as auth-flows-repo.ts:190).
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString(); // +7d
  await client`
    INSERT INTO team_invites
      (id, owner_account_id, invited_by_account_id, invitee_email,
       role, invite_token_hash, invite_expires_at)
    VALUES (${id}, ${ownerAccountId}, ${ownerAccountId}, ${inviteeEmail},
            ${role}, ${tokenHash}, ${expiresAt}::timestamptz)
  `;
  return { token, inviteId: id };
}

test('POST /v1/team/invites returns 202 + invite enqueued', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner@driftstack.test' });
  const res = await request.post(`${server.baseUrl}/v1/team/invites`, {
    headers: authHeader(owner.plaintext),
    data: { email: 'invitee@driftstack.test', role: 'member' },
  });
  expect(res.status()).toBe(202);

  const list = (await (
    await request.get(`${server.baseUrl}/v1/team/invites`, {
      headers: authHeader(owner.plaintext),
    })
  ).json()) as { data: InviteEntry[] };
  expect(list.data.length).toBe(1);
  expect(list.data[0]?.invitee_email).toBe('invitee@driftstack.test');
  expect(list.data[0]?.role).toBe('member');
});

test('POST /v1/team/invites accepts admin role', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner-a@driftstack.test' });
  const res = await request.post(`${server.baseUrl}/v1/team/invites`, {
    headers: authHeader(owner.plaintext),
    data: { email: 'admin-invitee@driftstack.test', role: 'admin' },
  });
  expect(res.status()).toBe(202);
});

test('POST /v1/team/invites 400 on malformed email', async ({ request }) => {
  const owner = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/team/invites`, {
    headers: authHeader(owner.plaintext),
    data: { email: 'not-an-email' },
  });
  expect(res.status()).toBe(400);
});

test('POST /v1/team/invites/accept creates a membership', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner-b@driftstack.test' });
  const invitee = await seedAccount(server.client, { email: 'member@driftstack.test' });
  const { token } = await seedInvite(
    server.client,
    owner.accountId,
    'member@driftstack.test',
    'member',
  );

  const res = await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
    headers: authHeader(invitee.plaintext),
    data: { token },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { membership: MemberEntry };
  expect(body.membership.id).toMatch(/^mem_/);
  expect(body.membership.role).toBe('member');
});

test('GET /v1/team/members lists the owner perspective', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner-c@driftstack.test' });
  const invitee = await seedAccount(server.client, { email: 'member-c@driftstack.test' });
  const { token } = await seedInvite(server.client, owner.accountId, 'member-c@driftstack.test');
  await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
    headers: authHeader(invitee.plaintext),
    data: { token },
  });

  const res = await request.get(`${server.baseUrl}/v1/team/members`, {
    headers: authHeader(owner.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: MemberEntry[] };
  expect(body.data.length).toBe(1);
  // 2026-05-21 — route shape: { member_email } (not { email }); see
  // publicMember() in apps/server/src/routes/team.ts. Fix the test's
  // interface + assertion to match.
  expect(body.data[0]?.member_email).toBe('member-c@driftstack.test');
});

test('GET /v1/team/owners lists the member perspective', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner-d@driftstack.test' });
  const invitee = await seedAccount(server.client, { email: 'member-d@driftstack.test' });
  const { token } = await seedInvite(server.client, owner.accountId, 'member-d@driftstack.test');
  await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
    headers: authHeader(invitee.plaintext),
    data: { token },
  });

  const res = await request.get(`${server.baseUrl}/v1/team/owners`, {
    headers: authHeader(invitee.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: OwnerEntry[] };
  expect(body.data.length).toBe(1);
  expect(body.data[0]?.owner_account_id).toBe(`acc_${owner.accountId}`);
});

test('DELETE /v1/team/members/:id removes a membership', async ({ request }) => {
  const owner = await seedAccount(server.client, { email: 'owner-e@driftstack.test' });
  const invitee = await seedAccount(server.client, { email: 'member-e@driftstack.test' });
  const { token } = await seedInvite(server.client, owner.accountId, 'member-e@driftstack.test');
  const accept = (await (
    await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
      headers: authHeader(invitee.plaintext),
      data: { token },
    })
  ).json()) as { membership: MemberEntry };

  const delRes = await request.delete(`${server.baseUrl}/v1/team/members/${accept.membership.id}`, {
    headers: authHeader(owner.plaintext),
  });
  expect(delRes.status()).toBe(204);

  const list = (await (
    await request.get(`${server.baseUrl}/v1/team/members`, {
      headers: authHeader(owner.plaintext),
    })
  ).json()) as { data: MemberEntry[] };
  expect(list.data).toEqual([]);
});

test('team routes return 401 without auth', async ({ request }) => {
  const eps = [
    {
      method: 'post' as const,
      path: '/v1/team/invites',
      data: { email: 'x@y.com' },
    },
    { method: 'get' as const, path: '/v1/team/invites' },
    {
      method: 'post' as const,
      path: '/v1/team/invites/accept',
      data: { token: 'x' },
    },
    { method: 'get' as const, path: '/v1/team/members' },
    { method: 'get' as const, path: '/v1/team/owners' },
    {
      method: 'delete' as const,
      path: `/v1/team/members/mem_${randomUUID()}`,
    },
  ];
  for (const ep of eps) {
    const res = await request[ep.method](`${server.baseUrl}${ep.path}`, { data: ep.data });
    expect(res.status(), `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
  }
});
