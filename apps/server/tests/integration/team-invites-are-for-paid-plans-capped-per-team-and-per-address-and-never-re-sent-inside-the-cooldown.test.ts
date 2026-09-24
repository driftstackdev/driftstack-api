// Security sweep 2026-09-24, findings #4 and #6 — team invites emailed any
// address without limit.
//
// Every POST /v1/team/invites upserted the invite (a fresh token) and sent a new
// "X invited you" email: 20 invites to one address were 20 emails, 50 invites
// from a brand-new FREE account were 50 emails, and the only bound was the
// account's `global` bucket (60 burst, 1/s on free) — about 3,600 branded mails
// an hour per account, to strangers, from Driftstack's sender.
//
// Now:
//   - inviting is a paid-plan feature (the pricing page: "On a paid plan, invite
//     teammates"), so a free account is refused before anything is sent;
//   - a team has at most 20 invites waiting at once;
//   - re-inviting an address inside the 10-minute cooldown is refused and sends
//     nothing — the link already emailed keeps working;
//   - one address receives at most 5 invite emails an hour and 10 a day, across
//     every team that invites it.
// Each refusal says what happened and when to try again.

import { afterEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../../src/lib/auth-tokens.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const json = { 'content-type': 'application/json' };
const RATE_LIMITED = 'https://errors.driftstack.dev/rate-limited';
const COOLDOWN_MS = 10 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function invite(
  email: string,
  bearer = fx.plaintext,
): Promise<{ status: number; body: { detail?: string; type?: string }; retryAfter: number }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/team/invites',
    headers: { ...json, authorization: `Bearer ${bearer}` },
    payload: { email },
  });
  return {
    status: res.statusCode,
    body: res.json<{ detail?: string; type?: string }>(),
    retryAfter: Number(res.headers['retry-after'] ?? NaN),
  };
}

function inviteMailsTo(address: string): number {
  return fx.emailSends.filter((s) => s.template === 'team-invite' && s.to === address).length;
}

/** Move a pending invite's send time back past the cooldown, as if time had passed. */
function backdatePastCooldown(ownerAccountId: string, email: string): void {
  const row = fx.teamMembersRepo
    .getAllInvites()
    .find(
      (i) =>
        i.ownerAccountId === ownerAccountId && i.inviteeEmail === email && i.acceptedAt === null,
    );
  expect(row, `a pending invite for ${email}`).toBeDefined();
  row!.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS - COOLDOWN_MS - 1000);
}

describe('team invites are for paid plans, capped per team and per address, and never re-sent inside the cooldown', () => {
  it('CRITICAL inviting one address 20 times in a row emails it once; each repeat inside the cooldown is refused 429 and the emailed link keeps working', async () => {
    fx = await buildTestApp();
    const address = 'repeat@example.test';
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) statuses.push((await invite(address)).status);
    expect(inviteMailsTo(address), 'invite emails sent').toBe(1);
    expect(statuses).toEqual([202, ...Array<number>(19).fill(429)]);

    // The refused repeats changed nothing: the one pending invite still carries
    // the token the single email delivered.
    const pending = fx.teamMembersRepo
      .getAllInvites()
      .filter((i) => i.inviteeEmail === address && i.acceptedAt === null);
    expect(pending).toHaveLength(1);
    const link = String(
      fx.emailSends.find((s) => s.template === 'team-invite' && s.to === address)?.vars.acceptLink,
    );
    const token = new URL(link).searchParams.get('token');
    expect(token).not.toBeNull();
    const accepted = await fx.teamMembersRepo.findInviteByTokenHash(tokenHash(token!));
    expect(accepted?.id, 'the emailed link no longer resolves').toBe(pending[0]!.id);
  });

  it('the cooldown refusal says when the address was last emailed and when it can be sent again', async () => {
    fx = await buildTestApp();
    await invite('copy@example.test');
    const refused = await invite('copy@example.test');
    expect(refused.status).toBe(429);
    expect(refused.body.type).toBe(RATE_LIMITED);
    expect(refused.body.detail).toMatch(
      /^An invite was emailed to this address less than 10 minutes ago\. You can send it again in (?:10|9) minutes\.$/,
    );
    expect(refused.retryAfter).toBeGreaterThan(500);
    expect(refused.retryAfter).toBeLessThanOrEqual(600);
  });

  it('control: once the cooldown has passed, re-inviting sends a fresh email as before', async () => {
    fx = await buildTestApp();
    expect((await invite('later@example.test')).status).toBe(202);
    backdatePastCooldown(fx.accountId, 'later@example.test');
    expect((await invite('later@example.test')).status).toBe(202);
    expect(inviteMailsTo('later@example.test')).toBe(2);
  });

  it('CRITICAL one stranger invited by twelve different teams receives at most 5 invite emails in an hour', async () => {
    fx = await buildTestApp();
    const stranger = 'popular-stranger@example.test';
    const statuses: number[] = [];
    let refusal: { detail?: string; type?: string } | undefined;
    for (let i = 0; i < 12; i += 1) {
      const suffix = (0x500 + i).toString(16).padStart(4, '0');
      const owner = await seedAdditionalAccount(fx, {
        accountId: `00000000-0000-4000-8000-00000000${suffix}`,
        apiKeyId: `00000000-0000-4000-8000-00000001${suffix}`,
      });
      const r = await invite(stranger, owner.plaintext);
      statuses.push(r.status);
      if (r.status === 429) refusal = r.body;
    }
    expect(inviteMailsTo(stranger)).toBe(5);
    expect(statuses).toEqual([...Array<number>(5).fill(202), ...Array<number>(7).fill(429)]);
    expect(refusal?.type).toBe(RATE_LIMITED);
    expect(refusal?.detail).toMatch(
      /^This address has been sent too many team invites recently\. Try again in 60 minutes\.$/,
    );
  });

  it('CRITICAL a team can have at most 20 invites waiting; the 21st address is refused 429 and not emailed', async () => {
    fx = await buildTestApp();
    const statuses: number[] = [];
    let refusal: { detail?: string; type?: string } | undefined;
    for (let i = 0; i < 25; i += 1) {
      const r = await invite(`bulk-${String(i)}@example.test`);
      statuses.push(r.status);
      if (r.status === 429) refusal ??= r.body;
    }
    expect(statuses).toEqual([...Array<number>(20).fill(202), ...Array<number>(5).fill(429)]);
    expect(fx.emailSends.filter((s) => s.template === 'team-invite')).toHaveLength(20);
    expect(refusal?.type).toBe(RATE_LIMITED);
    expect(refusal?.detail).toMatch(
      /^Your team has 20 invites waiting to be accepted, the most allowed at once\. Try again when one is accepted, or in 7 days, when the oldest expires\.$/,
    );

    const listed = await fx.app.inject({
      method: 'GET',
      url: '/v1/team/invites',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(20);

    // Re-sending one that is already waiting adds no new invite, so the cap does
    // not stand in its way once the cooldown has passed.
    backdatePastCooldown(fx.accountId, 'bulk-3@example.test');
    expect((await invite('bulk-3@example.test')).status).toBe(202);
  });

  it('CRITICAL a free account cannot invite: 403 with what to do, nothing stored and nothing emailed', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'free-owner@example.test', password: 'correct horse battery staple' },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: {
        token: signup.json<{ debug_token: string }>().debug_token,
        password: 'correct horse battery staple',
      },
    });
    const session = verify.json<{ session: { token: string } }>().session.token;
    const statuses: number[] = [];
    let refusal: { detail?: string; type?: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const r = await invite(`spam-${String(i)}@example.test`, session);
      statuses.push(r.status);
      refusal = r.body;
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403]);
    expect(refusal?.detail).toBe(
      'Inviting teammates is available on paid plans. Upgrade your plan to invite people to your account.',
    );
    expect(fx.emailSends.filter((s) => s.template === 'team-invite')).toHaveLength(0);
    expect(fx.teamMembersRepo.getAllInvites()).toHaveLength(0);
  });
});
