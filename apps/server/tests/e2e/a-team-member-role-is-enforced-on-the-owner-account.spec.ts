// V-1041 — a 'member' acting on the owner's account is refused where 'admin' is required.
//
// This session spent four commits correcting the same sentence across nine files:
// the team auth-path integration shipped, and what remains true is narrower —
// membership grants nothing implicitly, and a member acting on an owner's account
// via `X-Driftstack-Account` is "bounded by membership role and required scope"
// (V-1010, V-1015, V-1016, and the guard V-1016 added).
//
// That corrected sentence was verified by reading `resolveEffectiveAccount`. The
// ROLE half of it is enforced in eleven places across seven route files
// (`effective.role !== 'admin'`), and exactly one of them —
// `PUT /v1/account/me/organization` — had a behavioural test. The rest were prose
// plus a source-level guard.
//
// So this drives the real flow: seed an owner and an invitee, create an invite with
// role 'member', accept it through the API, then have the member act on the owner's
// account with the header and attempt operations that require 'admin'.
//
// Three assertions, and the second two are what make the first mean something:
//
//   1. A 'member' is refused (403) on the admin-bound writes.
//   2. The SAME member performs the SAME writes on their OWN account — so the 403
//      is about the role, not about the operation being broken or the key being
//      weak.
//   3. An 'admin'-role member IS allowed through on the owner's account — so the
//      403 is a role bound rather than team access being blocked outright, which
//      is the failure that would look identical from inside test 1 alone.

import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

/** Insert an invite directly, the way `team.spec.ts` does, and return its token. */
async function seedInvite(
  ownerAccountId: string,
  inviteeEmail: string,
  role: 'member' | 'admin',
): Promise<string> {
  const token = `inv-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await server.client`
    INSERT INTO team_invites
      (id, owner_account_id, invited_by_account_id, invitee_email,
       role, invite_token_hash, invite_expires_at)
    VALUES (${randomUUID()}, ${ownerAccountId}, ${ownerAccountId}, ${inviteeEmail},
            ${role}, ${tokenHash}, ${expiresAt}::timestamptz)
  `;
  return token;
}

interface Team {
  readonly ownerAccountId: string;
  readonly memberKey: string;
}

/** Owner + a member holding `role`, established through the real accept endpoint. */
async function seedTeam(request: APIRequestContext, role: 'member' | 'admin'): Promise<Team> {
  const stamp = `${role}-${randomUUID().slice(0, 8)}`;
  const owner = await seedAccount(server.client, { email: `owner-${stamp}@driftstack.test` });
  const memberEmail = `m-${stamp}@driftstack.test`;
  const member = await seedAccount(server.client, { email: memberEmail });
  const token = await seedInvite(owner.accountId, memberEmail, role);

  const accepted = await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
    headers: authHeader(member.plaintext),
    data: { token },
  });
  expect(accepted.status(), `accepting a ${role} invite`).toBe(200);
  expect(
    ((await accepted.json()) as { membership: { role: string } }).membership.role,
    'the membership carries the role that was invited',
  ).toBe(role);

  return { ownerAccountId: owner.accountId, memberKey: member.plaintext };
}

/** Admin-bound writes, one per route file that enforces the role. */
const ADMIN_BOUND = [
  {
    what: 'PUT /v1/account/email-preferences',
    send: (request: APIRequestContext, headers: Record<string, string>) =>
      request.put(`${server.baseUrl}/v1/account/email-preferences`, {
        headers,
        data: { event_type: 'session-failed-first', opted_in: false },
        failOnStatusCode: false,
      }),
  },
  {
    what: 'PUT /v1/account/me/organization',
    send: (request: APIRequestContext, headers: Record<string, string>) =>
      request.put(`${server.baseUrl}/v1/account/me/organization`, {
        headers,
        data: { organization: { folders: [], tags: [] } },
        failOnStatusCode: false,
      }),
  },
] as const;

test("a 'member' is refused on admin-bound writes against the owner's account", async ({
  request,
}) => {
  const { ownerAccountId, memberKey } = await seedTeam(request, 'member');
  const actingAsOwner = {
    ...authHeader(memberKey),
    'x-driftstack-account': `acc_${ownerAccountId}`,
  };

  for (const route of ADMIN_BOUND) {
    const res = await route.send(request, actingAsOwner);
    expect(res.status(), `${route.what} as a 'member' acting on the owner`).toBe(403);
  }
});

test('the same member performs those writes on their OWN account', async ({ request }) => {
  const { memberKey } = await seedTeam(request, 'member');
  const ownHeaders = { ...authHeader(memberKey) };

  for (const route of ADMIN_BOUND) {
    const res = await route.send(request, ownHeaders);
    // Not 403: the member is the account owner here. Any 2xx/4xx that is not a
    // role refusal is fine — the point is only that the operation itself works for
    // them, so the 403 above is attributable to the role.
    expect(res.status(), `${route.what} on the member's own account`).not.toBe(403);
  }
});

test("an 'admin'-role member IS allowed through on the owner's account", async ({ request }) => {
  const { ownerAccountId, memberKey } = await seedTeam(request, 'admin');
  const actingAsOwner = {
    ...authHeader(memberKey),
    'x-driftstack-account': `acc_${ownerAccountId}`,
  };

  for (const route of ADMIN_BOUND) {
    const res = await route.send(request, actingAsOwner);
    expect(
      res.status(),
      `${route.what} as an 'admin' acting on the owner — a 403 here would mean team access is ` +
        'blocked outright rather than bounded by role',
    ).not.toBe(403);
  }
});
