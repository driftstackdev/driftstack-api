// The test app lists only its seeded staff account, so another account's
// admin-scoped key is refused there as it is in production.
//
// An API key carrying `driftstack_internal_admin` is honoured only while its
// account is on the staff allow-list (services/auth.ts,
// withStaffScopeOnlyIfListed). The shared fixture (build-test-app) seeds a key
// with that scope, so it lists the seeded account exactly when the key carries
// it — the production invariant. This file makes sure that listing does not
// also hide the rule: a second account seeded with the same scope is NOT on the
// list, and its key is refused the admin surface on the slow path and on a cache
// hit, while the seeded account's key, in the same app, is admitted.

import { describe, expect, it } from 'vitest';
import { buildTestApp, seedAdditionalAccount } from './_helpers/build-test-app.js';

async function status(
  fx: Awaited<ReturnType<typeof buildTestApp>>,
  bearer: string,
  url: string,
): Promise<number> {
  const res = await fx.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${bearer}` },
  });
  return res.statusCode;
}

describe('the test app lists only its seeded staff account', () => {
  it('the seeded admin key reaches the admin surface; a second account’s key with the same scope is refused, on both paths, and is an ordinary key', async () => {
    const fx = await buildTestApp();
    try {
      const unlisted = await seedAdditionalAccount(fx, { email: 'not-staff@example.test' });
      for (let i = 0; i < 2; i++) {
        expect(await status(fx, fx.plaintext, '/v1/admin/accounts'), 'seeded, listed').toBe(200);
        expect(await status(fx, unlisted.plaintext, '/v1/admin/accounts'), 'unlisted').toBe(403);
      }
      const me = await fx.app.inject({
        method: 'GET',
        url: '/v1/whoami',
        headers: { authorization: `Bearer ${unlisted.plaintext}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ scopes: string[] }>().scopes).not.toContain('driftstack_internal_admin');
    } finally {
      await fx.app.close();
    }
  });

  it('a fixture whose seeded key does not carry the scope lists nobody: an admin key on another account is refused', async () => {
    const fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
    try {
      const other = await seedAdditionalAccount(fx);
      expect(await status(fx, other.plaintext, '/v1/admin/accounts')).toBe(403);
      expect(await status(fx, fx.plaintext, '/v1/admin/accounts')).toBe(403);
    } finally {
      await fx.app.close();
    }
  });
});
