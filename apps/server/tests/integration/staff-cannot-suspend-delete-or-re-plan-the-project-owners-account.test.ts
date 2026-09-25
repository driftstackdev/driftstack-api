// Staff cannot suspend, delete or re-plan the project owner's account
// (security sweep #16).
//
// The master-owner model keeps pricing, platform secrets and rate cards away from
// staff: those routes admit the owner alone. But every staff mutation on an account
// accepted the owner's account as its target. A suspended account cannot
// authenticate, so one staff key — rogue or stolen — could suspend the owner and
// lock them out of the very tools that are theirs alone, and delete would also
// revoke their keys and sessions and cancel their billing. The hierarchy ran the
// wrong way.
//
// The owner's account is now refused as the target of a staff suspend, delete or tier
// change, unless the owner is the one asking. The refusal is audited like any other
// failed staff action. Every other account, staff-listed ones included, is handled
// exactly as before: staff are peers, and a suspension one of them makes another can
// undo. A staff force-revoke of one of the owner's API keys, or force-destroy of one
// of their browser sessions, is not refused here: neither locks the owner out (their
// signed-in session is untouched and they can mint a new key), and refusing them
// needs the target's account before the atomic revoke, which the repositories'
// no-unscoped-read rule keeps out of the route.

import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWNER_EMAIL = 'project-owner-16@driftstack.test';
const STAFF_EMAIL = 'staff-16@driftstack.test';
const OWNER_ID = '00000000-0000-4000-8000-00000000d161';
const OWNER_KEY_ID = '00000000-0000-4000-8000-00000000d162';
const CUSTOMER_ID = '00000000-0000-4000-8000-00000000d163';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

function account(id: string, email: string) {
  return {
    id,
    email,
    name: null,
    tier: 'api_builder' as const,
    status: 'active' as const,
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

interface Staffed {
  f: TestAppFixture;
  /** The owner's own key, on the owner's account. */
  ownerKey: string;
}

/** A staff member's app, with the project owner's account beside it. */
async function staffWithAnOwner(): Promise<Staffed> {
  const f = await buildTestApp({ email: STAFF_EMAIL, ownerEmail: OWNER_EMAIL });
  f.authRepo.upsertAccount(account(OWNER_ID, OWNER_EMAIL));
  f.authRepo.upsertAccount(account(CUSTOMER_ID, 'customer-16@example.test'));
  const ownerKey = generateApiKey('test');
  const row = {
    id: OWNER_KEY_ID,
    accountId: OWNER_ID,
    name: 'owner key',
    keyPrefix: keyPrefixFromPlaintext(ownerKey),
    keyHash: await hashApiKey(ownerKey),
    scopes: ['read', 'write'] as const,
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  f.apiKeysRepo.upsert({ ...row, scopes: [...row.scopes] });
  return { f, ownerKey };
}

function staff(f: TestAppFixture): Record<string, string> {
  return { authorization: `Bearer ${f.plaintext}` };
}

async function ownerCanStillSignIn(f: TestAppFixture, ownerKey: string): Promise<number> {
  const me = await f.app.inject({
    method: 'GET',
    url: '/v1/account/me',
    headers: { authorization: `Bearer ${ownerKey}` },
  });
  return me.statusCode;
}

describe("staff cannot suspend, delete or re-plan the project owner's account", () => {
  for (const [label, path, payload] of [
    ['suspend', 'suspend', {}],
    ['delete', 'delete', {}],
    ['change the plan of', 'tier', { tier: 'free' }],
  ] as const) {
    it(`CRITICAL a staff key cannot ${label} the owner's account, and the owner still signs in`, async () => {
      const s = await staffWithAnOwner();
      fx = s.f;
      expect(await ownerCanStillSignIn(fx, s.ownerKey), 'fixture precondition').toBe(200);

      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/accounts/acc_${OWNER_ID}/${path}`,
        headers: staff(fx),
        payload,
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ detail: string }>().detail).toMatch(/project owner/);

      expect(await ownerCanStillSignIn(fx, s.ownerKey)).toBe(200);
      const owner = await fx.authRepo.getAccount(OWNER_ID);
      expect(owner?.status).toBe('active');
      expect(owner?.tier).toBe('api_builder');

      // The refused attempt is on the staff audit trail.
      const rows = fx.adminAuditRepo.getAll();
      expect(rows.at(-1)?.result).toBe('error: forbidden');
      expect(rows.at(-1)?.adminAccountId).toBe(fx.accountId);
    });
  }

  it('CONTROL a staff key still suspends an ordinary customer', async () => {
    const s = await staffWithAnOwner();
    fx = s.f;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${CUSTOMER_ID}/suspend`,
      headers: staff(fx),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await fx.authRepo.getAccount(CUSTOMER_ID))?.status).toBe('suspended');
  });

  it('CONTROL the owner acting on their own account is not refused', async () => {
    fx = await buildTestApp({ email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL, tier: 'api_starter' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${fx.accountId}/tier`,
      headers: staff(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ tier: string }>().tier).toBe('api_scale');
  });
});
