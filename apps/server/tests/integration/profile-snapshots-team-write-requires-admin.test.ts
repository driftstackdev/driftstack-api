// The team-RBAC write gate on profile snapshots, executed.
//
// `routes/profile-snapshots.ts:44`:
//
//     if (eff.role !== 'admin') {
//       throw new ForbiddenError('Snapshot writes on a team owner require admin role.');
//     }
//
// This is the boundary between a team MEMBER and a team ADMIN. A member may read
// the owner's data; only an admin may write it. One `if`, guarding three routes.
//
// It had never executed. That was established with the coverage statementMap
// rather than by grepping: of the five `require admin role` write gates in the
// codebase — profiles, webhooks, admin api-keys, sessions, and this one — four
// run under the suite and this one did not. (The first guess was that all five
// were text-pinned only; checking per-site is what corrected it.)
//
// What DID exist for this gate was a source pin:
//
//   routes-profile-snapshots-v312-v326e-cross-source-invariant.test.ts:99
//     /throw new ForbiddenError\('Snapshot writes on a team owner require admin role\.'\)/
//
// which matches the string and cannot observe the comparison in front of it.
// Flip `!==` to `===` and the pin stays green while every member gains write
// access and every admin loses it.
//
// ─── all three routes, because one `if` is not one surface ────────────────────
//
// `effectiveAccountIdForWrite` is called from three places — capture, restore
// and delete. They share the function, so a single arm would prove the function
// throws and say nothing about whether a given route still calls it. A route
// that stopped calling it would be an unguarded write path with the gate intact
// and every existing test green, which is precisely the failure a shared helper
// invites.
//
// ─── the arm that is not about refusing ───────────────────────────────────────
//
// `effectiveAccountIdForWrite` returns `undefined` when the caller is acting as
// themselves, before the role check. That is what keeps the gate from applying
// to the overwhelming majority of customers, who are on no team at all. A gate
// written to require admin unconditionally would pass every refusal arm here and
// lock every solo customer out of their own snapshots.
//
// MUTATION-PROVED against routes/profile-snapshots.ts — control 6/6 here,
// 13/13 on the source pin:
//
//                                                    here    source pin
//   the role comparison inverted                    4 red      1 red
//   the gate removed entirely                       3 red      2 red
//   the gate applied to SELF writes too             1 red      1 red
//   the CAPTURE route stops calling the helper      2 red      GREEN
//   the DELETE route stops calling the helper       1 red      GREEN
//
// ⛔ The last two are the reason this file drives all three routes. A route that
// simply stops calling the shared helper leaves the gate itself untouched — so
// the pin still matches the `throw`, still matches the `!== 'admin'`, and reports
// nothing, while that write path is wide open to any team member. The gate being
// correct and the gate being REACHED are different properties, and only one of
// them is visible in the source text.
//
// ⚠️ The self-exemption mutation had to be rewritten before it meant anything.
// The first version changed `return undefined` to `return ctx.account.id`, which
// every arm survived — correctly, because the caller does `eff ?? ctx.account.id`
// and both spellings produce the same account. It was a no-op dressed as a
// mutation. The version in the ledger makes the helper THROW on a self write,
// which is what "the gate applies unconditionally" actually looks like, and that
// reds the self arm.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { AccountRow } from '../../src/services/auth.js';

let fx: TestAppFixture;

const OWNER_ID = '00000000-0000-4000-8000-0000000ad001';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000ad002';
/** Any well-formed profile id: the gate fires before the profile is looked up. */
const PROFILE_ID = `prof_${randomUUID()}`;
const SNAPSHOT_ID = `psnap_${randomUUID()}`;

function ownerRow(): AccountRow {
  return {
    id: OWNER_ID,
    email: 'owner@example.test',
    name: 'Team Owner',
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Seed the caller as a member of OWNER's team with the given role. */
function joinTeam(role: 'member' | 'admin'): void {
  fx.authRepo.upsertAccount(ownerRow());
  fx.authRepo.setTeamMemberships(fx.accountId, [
    { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role },
  ]);
}

const asOwner = (): Record<string, string> => ({
  authorization: `Bearer ${fx.plaintext}`,
  'x-driftstack-account': `acc_${OWNER_ID}`,
});

const asSelf = (): Record<string, string> => ({ authorization: `Bearer ${fx.plaintext}` });

/** The three write routes the gate stands in front of. */
const WRITES = [
  {
    what: 'capture a snapshot',
    method: 'POST' as const,
    url: `/v1/profiles/${PROFILE_ID}/snapshots`,
    payload: { label: 'nightly' } as Record<string, unknown> | undefined,
  },
  {
    what: 'restore a snapshot',
    method: 'POST' as const,
    url: `/v1/profile-snapshots/${SNAPSHOT_ID}/restore`,
    // RestoreSnapshotRequestSchema parses BEFORE the gate, so the body must be
    // valid or the route answers 400 for an unrelated reason.
    payload: { name: 'restored-profile' } as Record<string, unknown> | undefined,
  },
  {
    what: 'delete a snapshot',
    method: 'DELETE' as const,
    url: `/v1/profile-snapshots/${SNAPSHOT_ID}`,
    payload: undefined,
  },
];

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('snapshot writes on a team owner require admin role', () => {
  it('CRITICAL an ADMIN member is NOT refused by this gate. Every arm below asserts a 403, and a gate that refused unconditionally would satisfy all of them while removing the only way a team admin manages the owner’s snapshots. The assertion is "not 403 with this message" rather than a success code, because the request continues into a service that will fail on a profile this fixture never created — and that later failure is not what is under test.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    joinTeam('admin');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${PROFILE_ID}/snapshots`,
      headers: asOwner(),
      payload: { label: 'nightly' },
    });
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '', 'the admin got past the role gate').not.toContain(
      'require admin role',
    );
  });

  for (const w of WRITES) {
    it(`CRITICAL a non-admin member cannot ${w.what} on the owner's account. Read access and write access are different grants; without this the "member" role silently carries everything "admin" does, and the distinction the team UI presents to customers would be decorative.`, async () => {
      fx = await buildTestApp({ tier: 'api_builder' });
      joinTeam('member');
      const res = await fx.app.inject({
        method: w.method,
        url: w.url,
        headers: asOwner(),
        ...(w.payload !== undefined ? { payload: w.payload } : {}),
      });
      expect(res.statusCode, 'refused with Forbidden').toBe(403);
      expect(
        res.json<{ detail?: string }>().detail,
        'and named the reason, so the member knows to ask an admin',
      ).toBe('Snapshot writes on a team owner require admin role.');
    });
  }

  it('CRITICAL a caller acting as THEMSELVES is not subject to the gate at all. The role check runs only when the request carries an effective-account header naming a team owner; applied unconditionally it would refuse every customer on no team — which is most of them — from writing their own snapshots.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${PROFILE_ID}/snapshots`,
      headers: asSelf(),
      payload: { label: 'mine' },
    });
    expect(
      res.json<{ detail?: string }>().detail ?? '',
      'no role gate on a self write',
    ).not.toContain('require admin role');
  });

  it('CRITICAL the refusal is the ROLE one, not the not-a-member one. Both are ForbiddenError from the same request shape, and conflating them would hide a member whose grant vanished behind a message telling them to ask an admin who can no longer help.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // No membership seeded: the caller is not on this team at all.
    fx.authRepo.upsertAccount(ownerRow());
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${PROFILE_ID}/snapshots`,
      headers: asOwner(),
      payload: { label: 'nightly' },
    });
    expect(res.statusCode, 'still forbidden').toBe(403);
    expect(res.json<{ detail?: string }>().detail, 'but for not being a member').toMatch(
      /not a member of/i,
    );
  });
});
