// Integration tests for V-666 profile transfer (POST /v1/profiles/:id/transfer).
//
// Transfer crosses route → ProfilesService.transferProfile → repo
// (insert under recipient + delete from sender). These tests exercise
// the full chain end-to-end rather than the route/service in isolation,
// per the "end-to-end test first for cross-layer plumbing" lesson — the
// per-layer unit/parity tests can each pass while the wired chain is
// broken (e.g. recipient lookup, tier-ceiling, self-transfer guard).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { seedProfiles } from './_helpers/scenarios.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const RECIPIENT_ID = '00000000-0000-4000-8000-0000000000b2';
/** V-734 — a team OWNER whose workspace an admin member acts on. */
const OWNER_ID = '00000000-0000-4000-8000-0000000000c3';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000000d4';

/** Register a second (recipient) account directly in the in-memory
 *  auth repo so the transfer route's getAccount lookup resolves it. */
function seedRecipient(
  fx: TestAppFixture,
  opts: { id?: string; tier?: 'api_builder' | 'free' } = {},
): void {
  fx.authRepo.upsertAccount({
    id: opts.id ?? RECIPIENT_ID,
    email: 'recipient@driftstack.local',
    name: 'Recipient',
    tier: opts.tier ?? 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

interface TransferResponse {
  new_profile: { id: string; name: string; archetype: string };
  recipient_account_id: string;
}

/** seedProfiles(fx, 1) with a non-undefined return (narrows past
 *  noUncheckedIndexedAccess on the [0] element). */
async function seedOne(
  fx: TestAppFixture,
  names?: string[],
): Promise<{ id: string; name: string; archetype: string }> {
  const [p] = await seedProfiles(fx, 1, names ? { names } : {});
  if (!p) throw new Error('seedProfiles returned no profile');
  return p;
}

// V-734 — transfer must honour X-Driftstack-Account like every other profile
// WRITE in this file.
//
// It was the only write route that never called `effectiveAccountIdForWrite`, so
// an admin team member transferring one of the OWNER's profiles had
// `sourceAccountId` silently set to their OWN account and got a bare `404
// profile not found`. The header was ignored rather than refused, which is the
// worst of the three options: the caller cannot tell whether the profile is
// missing or the scoping was dropped.
//
// Honouring it grants no new power — the sibling DELETE routes already run under
// the same helper, so an admin can already destroy the owner's profiles outright.
//
// The self-transfer guard had the matching bug: it compared the recipient against
// the CALLER, so under a team-scoped write it refused a legitimate transfer to
// the member's own account while permitting a no-op transfer to the owner.
describe('POST /v1/profiles/:id/transfer — team-scoped (X-Driftstack-Account)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  /** Make the fixture account an ADMIN member of OWNER_ID's team, and seed a
   *  profile that belongs to the OWNER (created through the sibling POST route,
   *  which already honours the header). */
  async function ownerProfileViaAdminMember(): Promise<{
    headers: Record<string, string>;
    profileId: string;
  }> {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ID,
      email: 'owner@driftstack.local',
      name: 'Owner',
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role: 'admin' },
    ]);
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'x-driftstack-account': `acc_${OWNER_ID}`,
      'content-type': 'application/json',
    };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { name: 'owners-profile' },
    });
    expect(created.statusCode).toBe(200);
    return { headers, profileId: created.json<{ id: string }>().id };
  }

  it('an admin member can transfer one of the OWNER profiles', async () => {
    const { headers, profileId } = await ownerProfileViaAdminMember();
    seedRecipient(fx);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/transfer`,
      headers,
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });

    // Was a bare 404: sourceAccountId had silently been the member's account.
    expect(res.statusCode).toBe(200);
    expect(res.json<TransferResponse>().recipient_account_id).toBe(`acc_${RECIPIENT_ID}`);
  });

  it('refuses a transfer to the OWNER itself, because the source is the owner', async () => {
    const { headers, profileId } = await ownerProfileViaAdminMember();

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/transfer`,
      headers,
      payload: { recipient_account_id: `acc_${OWNER_ID}` },
    });

    // The self-transfer guard now compares against the SOURCE account. Before,
    // it compared against the caller, so this no-op was allowed through.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });
});

describe('POST /v1/profiles/:id/transfer', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 transfers the profile to the recipient + removes it from the sender', async () => {
    fx = await buildTestApp();
    seedRecipient(fx);
    const profile = await seedOne(fx, ['shopper-acctA']);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<TransferResponse>();
    expect(body.recipient_account_id).toBe(`acc_${RECIPIENT_ID}`);
    expect(body.new_profile.name).toBe('shopper-acctA');
    expect(body.new_profile.archetype).toBe(profile.archetype);
    // New profile id differs from the source (fresh row under recipient).
    expect(body.new_profile.id).not.toBe(profile.id);

    // Source profile is gone from the sender's account.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const senderProfiles = list.json<{ data: Array<{ id: string }> }>().data;
    expect(senderProfiles.some((p) => p.id === profile.id)).toBe(false);
  });

  it('400 ValidationError on a malformed recipient_account_id', async () => {
    fx = await buildTestApp();
    const profile = await seedOne(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: 'not-an-account-id' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('400 ValidationError when transferring to your own account', async () => {
    fx = await buildTestApp();
    const profile = await seedOne(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${fx.accountId}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('429 TierLimit when the recipient is already at their profile cap', async () => {
    fx = await buildTestApp();
    // Recipient on free (profile cap 1) already holding 1 profile.
    seedRecipient(fx, { tier: 'free' });
    await fx.profilesRepo.insert({
      accountId: RECIPIENT_ID,
      name: 'recipient-existing',
      archetype: 'iphone13_ios18_6_safari18_6',
      description: null,
    });
    // P-15 — the TRANSFERRED profile must be a device the free recipient is entitled to,
    // so this arm still measures the CAP (a paid device to a free recipient is now
    // refused as an entitlement — see the free-tier test).
    const [profile] = await seedProfiles(fx, 1, { archetype: 'iphone13_ios18_6_safari18_6' });
    if (!profile) throw new Error('seedProfiles returned no profile');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.TierLimit);

    // The transfer must NOT have consumed the source — sender keeps it.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const senderProfiles = list.json<{ data: Array<{ id: string }> }>().data;
    expect(senderProfiles.some((p) => p.id === profile.id)).toBe(true);
  });

  it('429 TierLimit when the recipient is under their profile cap but over the per-cycle import cap', async () => {
    fx = await buildTestApp();
    // free recipient: profile cap 1, import cap 2/cycle. Hold 0
    // profiles (profile cap clear) but seed 2 prior profile.imported
    // rows this cycle so the transfer (which counts as an import for
    // the recipient) trips the cycle cap, not the profile cap.
    seedRecipient(fx, { tier: 'free' });
    for (let i = 0; i < 2; i += 1) {
      await fx.accountAuditRepo.insert({
        accountId: RECIPIENT_ID,
        actorType: 'customer',
        action: 'profile.imported',
        targetResourceId: `profile_seed_${i.toString()}`,
      });
    }
    // P-15 — an entitled device, so this arm measures the per-cycle import cap and not
    // the device entitlement.
    const [profile] = await seedProfiles(fx, 1, { archetype: 'iphone13_ios18_6_safari18_6' });
    if (!profile) throw new Error('seedProfiles returned no profile');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.TierLimit);
  });

  it('404 when the recipient account does not exist', async () => {
    fx = await buildTestApp();
    const profile = await seedOne(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });

  it('404 when transferring a profile owned by a DIFFERENT account (source-ownership scope)', async () => {
    // Seed a profile under a foreign account in the SHARED repo, then have the
    // caller attempt to transfer it to a VALID recipient (so the route reaches
    // the source-ownership check rather than 404-ing on an unknown recipient).
    // transferProfile's findById is scoped to the caller's account, so it 404s
    // (never confirming the profile exists in another account's namespace) and
    // the foreign profile is NOT moved. Guards the source-ownership invariant
    // against the accountId scope being dropped — clone has the equivalent test,
    // transfer did not (its other tests are all recipient-side).
    fx = await buildTestApp();
    seedRecipient(fx, { id: RECIPIENT_ID });
    const VICTIM_ID = '00000000-0000-4000-8000-0000000000c3';
    const victimProfile = await fx.profilesRepo.insert({
      accountId: VICTIM_ID,
      name: 'victim-profile',
      archetype: 'iphone16pro',
      description: null,
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/prof_${victimProfile.id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { recipient_account_id: `acc_${RECIPIENT_ID}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);

    // The foreign profile was NOT moved — still owned by the victim account.
    const still = await fx.profilesRepo.findById({ id: victimProfile.id, accountId: VICTIM_ID });
    expect(still).not.toBeNull();
  });
});
