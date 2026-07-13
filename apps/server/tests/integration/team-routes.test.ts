// V-298c — Team RBAC routes integration tests.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

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
