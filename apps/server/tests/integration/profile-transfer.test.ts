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

/** Register a second (recipient) account directly in the in-memory
 *  auth repo so the transfer route's getAccount lookup resolves it. */
function seedRecipient(
  fx: TestAppFixture,
  opts: { id?: string; tier?: 'api_builder' | 'trial_pack' } = {},
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
    // Recipient on trial_pack (profile cap 1) already holding 1 profile.
    seedRecipient(fx, { tier: 'trial_pack' });
    await fx.profilesRepo.insert({
      accountId: RECIPIENT_ID,
      name: 'recipient-existing',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
    });
    const profile = await seedOne(fx);

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
    // trial_pack recipient: profile cap 1, import cap 2/cycle. Hold 0
    // profiles (profile cap clear) but seed 2 prior profile.imported
    // rows this cycle so the transfer (which counts as an import for
    // the recipient) trips the cycle cap, not the profile cap.
    seedRecipient(fx, { tier: 'trial_pack' });
    for (let i = 0; i < 2; i += 1) {
      await fx.accountAuditRepo.insert({
        accountId: RECIPIENT_ID,
        actorType: 'customer',
        action: 'profile.imported',
        targetResourceId: `profile_seed_${i.toString()}`,
      });
    }
    const profile = await seedOne(fx);

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
});
