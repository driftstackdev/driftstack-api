// V-298c — Team RBAC routes integration tests.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

describe('team route API-key scope floor', () => {
  it.each([
    ['zero-scope', []],
    ['write-only', ['write']],
    ['unrelated granular', ['read:sessions']],
  ] as const)('blocks a %s key from team directory reads', async (_label, scopes) => {
    fx = await buildTestApp({ scopes: [...scopes] });
    for (const url of ['/v1/team/invites', '/v1/team/members', '/v1/team/owners']) {
      const res = await fx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ detail: string }>().detail, url).toBe(
        'This action requires the "read" scope.',
      );
    }
  });

  it.each(['read', 'account_owner'] as const)(
    'allows a %s key to read each team directory',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      for (const url of ['/v1/team/invites', '/v1/team/members', '/v1/team/owners']) {
        const res = await fx.app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${fx.plaintext}` },
        });
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      }
    },
  );

  it.each([
    ['zero-scope', []],
    ['read-only', ['read']],
    ['write-only', ['write']],
  ] as const)('blocks a %s key from accepting a team invite', async (_label, scopes) => {
    fx = await buildTestApp({ scopes: [...scopes] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { token: 'x'.repeat(20) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toBe(
      'This action requires the "account_owner" scope.',
    );
  });
});

describe('POST /v1/team/invites', () => {
  it('202 sends invite + records email + creates pending row', async () => {
    fx = await buildTestApp();
    const before = fx.emailSends.length;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: 'invitee@example.test', role: 'admin' },
    });
    expect(res.statusCode).toBe(202);

    const after = fx.emailSends.slice(before);
    const invite = after.find((s) => s.template === 'team-invite');
    expect(invite).toBeDefined();
    expect(invite!.to).toBe('invitee@example.test');
    expect(invite!.vars.role).toBe('admin');

    const invites = fx.teamMembersRepo.getAllInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.role).toBe('admin');
  });

  it('403 when the key lacks account_owner scope (read/write key)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: 'invitee@example.test', role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('account_owner');
  });

  it('400 on malformed email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/team/invites + GET /v1/team/members', () => {
  it('200 lists pending invites for the calling owner', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: 'a@example.test' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: 'b@example.test' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/team/invites',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ data: { invitee_email: string }[] }>();
    expect(body.data).toHaveLength(2);
    expect(body.data.map((d) => d.invitee_email).sort()).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('200 returns empty members list before any accepts', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/team/members',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });
});

describe('POST /v1/team/invites/accept (route happy path)', () => {
  it('200 creates membership when invitee email matches', async () => {
    fx = await buildTestApp();
    // Owner invites their own email so the test fixture's seeded
    // account-email mapping satisfies the email-match check.
    const ownerEmail = 'tester@driftstack.local'; // matches build-test-app default
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: ownerEmail },
    });
    expect(res.statusCode).toBe(202);
    // Invite owner=fx.accountId, invitee_email=fx own email.
    const inviteRow = fx.teamMembersRepo.getAllInvites()[0]!;
    expect(inviteRow.inviteeEmail).toBe(ownerEmail);
    // Recover plaintext from invite-email vars.
    const inviteEmail = fx.emailSends[fx.emailSends.length - 1]!;
    const acceptLink = inviteEmail.vars.acceptLink as string;
    const token = new URL(acceptLink).searchParams.get('token');
    expect(token).toBeDefined();

    const acceptRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { token: token! },
    });
    expect(acceptRes.statusCode).toBe(200);
    const body = acceptRes.json<{
      membership: { member_email: string; role: string };
    }>();
    expect(body.membership.member_email).toBe(ownerEmail);
    expect(body.membership.role).toBe('member');
  });

  it('400 on missing token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/team/members/:id', () => {
  it('204 removes owned membership', async () => {
    fx = await buildTestApp();
    const ownerEmail = 'tester@driftstack.local';
    await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { email: ownerEmail },
    });
    const inviteEmail = fx.emailSends[fx.emailSends.length - 1]!;
    const token = new URL(inviteEmail.vars.acceptLink as string).searchParams.get('token');
    const acceptRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { token: token! },
    });
    const memberId = acceptRes.json<{ membership: { id: string } }>().membership.id;

    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/team/members/${memberId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('404 on unknown membership id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/team/members/mem_00000000-0000-4000-8000-000000000999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://errors.driftstack.dev/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Membership mem_00000000-0000-4000-8000-000000000999 not found.',
      instance: res.headers['x-request-id'],
    });
  });

  it('400 on malformed id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/team/members/not-a-mem-id',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── an unrelated account cannot remove a member from someone else's team ───
//
// `DELETE /v1/team/members/:id` scopes its delete by
// `ownerAccountId: ctx.account.id`, so a foreign membership id finds no row and
// answers 404. Nothing had ever checked that: the isolation census
// (70 customer-facing parameterised routes) flagged this route, and confirming
// it meant looking at every test that touches `team/members/` — five files, none
// of which seeds a second account.
//
// The stake is not disclosure, it is availability. A successful cross-account
// delete evicts a real person from a customer's team: their act-as access to the
// owner's sessions, profiles and keys stops working, and the owner has no signal
// beyond a member who suddenly cannot log in to their work.
//
// ⭐ Order matters here and is the reason this is one test rather than two. B's
// attempt runs FIRST and must 404; A then deletes the SAME membership and must
// get 204. Without the second half the arm is satisfied by a build where the
// membership never existed, or where every delete 404s — the same
// refuses-everything trap that a bare refusal assertion cannot see.
//
// LEDGER — control 19/19:
//
//   removeMember stops scoping by owner              SURVIVES
//   removeMemberWithInvites stops scoping by owner   1 red
//
// ⚠️ The survivor is not a coverage gap — it is the ledger identifying which
// function is actually live. `TeamMembersService.removeMember` calls
// `removeMemberWithInvites` (one transaction that also cancels the member's
// pending invites and revokes the keys they minted), so the plain `removeMember`
// on the repo is not on this path at all. Mutating it changes nothing a request
// can observe. That is worth knowing before someone "fixes" a scoping bug in the
// function nobody calls and watches the tests stay green either way.
//
// The anchor for that mutation also matched TWICE on first attempt — the same
// `m.id === … && m.ownerAccountId === …` predicate appears at three sites in the
// fixture repo — and the run aborted rather than mutating an arbitrary one.
describe("DELETE /v1/team/members/:id — another account's membership", () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  /** Invite + accept against A's own email, which is the shortest real membership. */
  async function membershipOwnedByA(fixture: TestAppFixture): Promise<string> {
    const ownerEmail = 'tester@driftstack.local'; // build-test-app default
    const invite = await fixture.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { authorization: `Bearer ${fixture.plaintext}`, 'content-type': 'application/json' },
      payload: { email: ownerEmail },
    });
    expect(invite.statusCode, `invite returned ${invite.statusCode}`).toBe(202);
    const sent = fixture.emailSends[fixture.emailSends.length - 1]!;
    const token = new URL(sent.vars.acceptLink as string).searchParams.get('token');
    expect(token, 'invite email must carry an accept token').toBeTruthy();

    const accepted = await fixture.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { authorization: `Bearer ${fixture.plaintext}`, 'content-type': 'application/json' },
      payload: { token },
    });
    expect(accepted.statusCode, `accept returned ${accepted.statusCode}`).toBe(200);
    return accepted.json<{ membership: { id: string } }>().membership.id;
  }

  it('CRITICAL 404 for an unrelated account, and the OWNER can still remove the same membership afterwards — so the refusal is ownership and not a build that refuses every delete', async () => {
    fx = await buildTestApp();
    const membershipId = await membershipOwnedByA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@team-isolation.test',
      tier: 'api_builder',
      scopes: ['read', 'write', 'account_owner'],
    });

    const asB = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/team/members/${membershipId}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    expect(asB.statusCode, `B removing A's member returned ${asB.statusCode}`).toBe(404);

    // 404 rather than 403 on purpose: a 403 confirms the membership exists and
    // turns a guessed id into an existence oracle over other customers' teams.
    expect(asB.json<{ type: string }>().type).toContain('not-found');

    const asA = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/team/members/${membershipId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(asA.statusCode, `the owner removing its own member returned ${asA.statusCode}`).toBe(
      204,
    );
  });
});
