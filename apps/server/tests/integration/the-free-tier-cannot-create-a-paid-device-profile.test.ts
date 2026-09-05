// V-1611 #15 — the device entitlement is enforced ON THE ROUTE, over a real
// request, not merely defined in a constant.
//
// ⛔ THIS FILE EXISTS BECAUSE THE UNIT TESTS DID NOT NOTICE ITS ABSENCE.
// `the-free-tier-device-entitlement-is-enforced` proves the map is right, that
// the helper narrows the set, and that unknown ids fail closed — six arms, all
// green. Deleting the `requireArchetypeForTier(...)` call from
// `POST /v1/profiles` left every one of them passing: 34 tests, no failure. The
// data was pinned and the ENFORCEMENT was not, which is the same shape as a
// launch gate whose refusal is tested and whose caller-side throw is not.
//
// So the arms below go through `app.inject` and assert the STATUS a customer
// would receive, because that is the only thing that can tell a wired gate from
// an unwired one.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import {
  ARCHETYPE_DEVICES_PER_TIER,
  ARCHETYPE_REGISTRY,
  PROFILE_EXPORT_ENVELOPE_VERSION,
} from '@driftstack/api-types';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';

/** An id on a device the free tier does NOT get, derived rather than hardcoded. */
function paidOnlyArchetypeId(): string {
  const free = ARCHETYPE_DEVICES_PER_TIER.free ?? [];
  const entry = ARCHETYPE_REGISTRY.find((a) => !free.includes(a.device));
  if (!entry) throw new Error('registry has no device outside the free set');
  return entry.id;
}

/** An id the free tier DOES get — the positive control's subject. */
function freeArchetypeId(): string {
  const free = ARCHETYPE_DEVICES_PER_TIER.free ?? [];
  const entry = ARCHETYPE_REGISTRY.find((a) => free.includes(a.device));
  if (!entry) throw new Error('registry has none of the free devices');
  return entry.id;
}

async function seedFreeAccount(
  fx: TestAppFixture,
  accountId = 'acct_00000000-0000-4000-8000-0000000000f1',
): Promise<string> {
  fx.authRepo.upsertAccount({
    id: accountId,
    email: 'free@driftstack.local',
    name: 'Free',
    tier: 'free',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const plaintext = generateApiKey('test');
  fx.authRepo.upsertApiKey({
    id: 'key_00000000-0000-4000-8000-0000000000f1',
    accountId,
    name: 'free-key',
    keyPrefix: keyPrefixFromPlaintext(plaintext),
    keyHash: await hashApiKey(plaintext),
    scopes: ['read', 'write'],
    // ⛔ `cli_device`, not an ordinary key. The free tier has no `apiAccess`
    // feature at all, so an ordinary API key is refused by the auth middleware
    // before any route runs — the first version of this file seeded one and got
    // 403 on EVERY case, including the entitled device, which reads exactly like
    // the gate working and is the gate never being reached.
    //
    // The free tier's real path to profile creation is the desktop's device-code
    // credential, and `POST:/v1/profiles` is on its allowlist
    // (`free-desktop-route-policy.ts`). That is the path this entitlement has to
    // hold on, so it is the path the test uses.
    provenance: 'cli_device',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  return plaintext;
}

describe('the free tier cannot create a paid-device profile', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL a free account is REFUSED a device outside its entitlement, over a real request. This is the arm that fails when the route stops calling the gate — every unit arm stays green through that deletion.', async () => {
    fx = await buildTestApp();
    const key = await seedFreeAccount(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'free-profile', archetype: paidOnlyArchetypeId() },
    });
    expect(res.statusCode, 'a paid device on the free tier is 403').toBe(403);
    expect(res.body).toContain('iPhone 13');
  });

  it('CRITICAL POSITIVE CONTROL the same account CAN create a profile on a device it does get. Without this, a route that refused every create would satisfy the arm above while making the free tier unusable.', async () => {
    fx = await buildTestApp();
    const key = await seedFreeAccount(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'free-profile', archetype: freeArchetypeId() },
    });
    expect(res.statusCode, 'an entitled device on the free tier succeeds').toBe(200);
  });

  it('CRITICAL a PAID account creates the same paid device without complaint — the refusal is about the tier, not the device', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'paid-profile', archetype: paidOnlyArchetypeId() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('an unknown archetype is a 400 and not a 403 — a typo must not send a customer to the billing page', async () => {
    fx = await buildTestApp();
    const key = await seedFreeAccount(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'free-profile', archetype: 'iphone99_ios99_safari99' },
    });
    expect(res.statusCode).toBe(400);
  });

  // P-15 (2026-09-05, found by the plan-completion verification) — the entitlement used
  // to be enforced ONLY on POST /v1/profiles. Every other path that mints a profile
  // (import, transfer, clone, snapshot restore) minted a paid-device profile on a free
  // account without complaint. Import and transfer are exercised here over real
  // requests; clone and restore call the same guard in the services.
  it('CRITICAL P-15 a free account cannot IMPORT a paid-device profile — the guard is where the profile is minted, not only on create', async () => {
    fx = await buildTestApp();
    const key = await seedFreeAccount(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        envelope: {
          version: PROFILE_EXPORT_ENVELOPE_VERSION,
          exported_at: '2026-09-01T00:00:00.000Z',
          source_profile_id: 'prof_00000000-0000-4000-8000-00000000aa01',
          source_account_id: 'acct_00000000-0000-4000-8000-00000000aa01',
          profile: { name: 'imported-paid', archetype: paidOnlyArchetypeId(), description: null },
        },
      },
    });
    expect(res.statusCode, 'importing a paid device onto the free tier is 403').toBe(403);
    expect(res.body).toContain('iPhone 13');
  });

  it('POSITIVE CONTROL the same import with an entitled device is accepted', async () => {
    fx = await buildTestApp();
    const key = await seedFreeAccount(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        envelope: {
          version: PROFILE_EXPORT_ENVELOPE_VERSION,
          exported_at: '2026-09-01T00:00:00.000Z',
          source_profile_id: 'prof_00000000-0000-4000-8000-00000000aa02',
          source_account_id: 'acct_00000000-0000-4000-8000-00000000aa02',
          profile: { name: 'imported-free', archetype: freeArchetypeId(), description: null },
        },
      },
    });
    expect(
      [200, 201],
      `import of an entitled device answered ${res.statusCode.toString()}: ${res.body}`,
    ).toContain(res.statusCode);
  });

  it('CRITICAL P-15 a paid account cannot TRANSFER a paid-device profile to a free recipient — a transfer mints it on the recipient', async () => {
    fx = await buildTestApp();
    // The transfer route validates the recipient as acc_<uuid> and looks it up by the BARE
    // uuid (it strips the prefix), so the seed stores the bare id and the request carries
    // the prefixed form.
    const recipientId = '00000000-0000-4000-8000-0000000000f2';
    await seedFreeAccount(fx, recipientId);
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'paid-profile', archetype: paidOnlyArchetypeId() },
    });
    expect(created.statusCode).toBe(200);
    const id = (JSON.parse(created.body) as { id: string }).id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/transfer`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { recipient_account_id: `acc_${recipientId}` },
    });
    expect(
      res.statusCode,
      `transferring a paid device to a free recipient is 403: ${res.body}`,
    ).toBe(403);
  });
});
