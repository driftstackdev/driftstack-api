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
import { ARCHETYPE_DEVICES_PER_TIER, ARCHETYPE_REGISTRY } from '@driftstack/api-types';
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

async function seedFreeAccount(fx: TestAppFixture): Promise<string> {
  const accountId = 'acct_00000000-0000-4000-8000-0000000000f1';
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
});
