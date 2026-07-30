// Release-blocking regression: profile taxonomy must resolve against the same
// effective account as the profiles it organizes. A selected team workspace
// must never read or overwrite the authenticated actor's personal taxonomy.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountOrganization } from '@driftstack/api-types';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000b2';
const NONMEMBER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c3';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000000d4';

const ACTOR_ORGANIZATION: AccountOrganization = {
  folders: [{ name: 'Personal', icon: '👤' }],
  tags: ['actor-only'],
};
const OWNER_ORGANIZATION: AccountOrganization = {
  folders: [{ name: 'Workspace', icon: '🏢' }],
  tags: ['owner-only'],
};

let fx: TestAppFixture;

afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

function auth(fixture: TestAppFixture, effectiveAccount?: string): Record<string, string> {
  return {
    authorization: `Bearer ${fixture.plaintext}`,
    ...(effectiveAccount === undefined
      ? {}
      : { 'x-driftstack-account': `acc_${effectiveAccount}` }),
  };
}

async function seedOwner(fixture: TestAppFixture, role: 'member' | 'admin'): Promise<void> {
  await seedAdditionalAccount(fixture, {
    accountId: OWNER_ACCOUNT_ID,
    apiKeyId: '00000000-0000-4000-8000-000000000b02',
  });
  fixture.authRepo.setTeamMemberships(fixture.accountId, [
    {
      membershipId: MEMBERSHIP_ID,
      ownerAccountId: OWNER_ACCOUNT_ID,
      role,
    },
  ]);
  await fixture.authRepo.setOrganization(fixture.accountId, ACTOR_ORGANIZATION);
  await fixture.authRepo.setOrganization(OWNER_ACCOUNT_ID, OWNER_ORGANIZATION);
}

describe('GET /v1/account/me/organization effective owner', () => {
  it.each([
    ['member', 'read:profiles'],
    ['member', 'read'],
    ['member', 'account_owner'],
    ['admin', 'read:profiles'],
    ['admin', 'read'],
    ['admin', 'account_owner'],
  ] as const)(
    'returns the selected owner taxonomy to a team %s with %s without exposing the actor taxonomy',
    async (role, scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      await seedOwner(fx, role);

      const getOrganization = vi.spyOn(fx.authRepo, 'getOrganization');
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me/organization',
        headers: auth(fx, OWNER_ACCOUNT_ID),
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(OWNER_ORGANIZATION);
      expect(res.json()).not.toEqual(ACTOR_ORGANIZATION);
      expect(getOrganization).toHaveBeenCalledTimes(1);
      expect(getOrganization).toHaveBeenCalledWith(OWNER_ACCOUNT_ID);
    },
  );

  it.each([
    ['malformed', 'not-an-account-id'],
    ['nonmember', `acc_${NONMEMBER_ACCOUNT_ID}`],
  ] as const)(
    'rejects a %s selected account before organization-repo access',
    async (_case, header) => {
      fx = await buildTestApp({ scopes: ['read:profiles'] });
      const getOrganization = vi.spyOn(fx.authRepo, 'getOrganization');

      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me/organization',
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': header,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(getOrganization).not.toHaveBeenCalled();
    },
  );
});

describe('PUT /v1/account/me/organization effective owner', () => {
  it.each(['write:profiles', 'write', 'account_owner'] as const)(
    'lets a team admin with %s mutate only the selected owner and leaves actor bytes unchanged',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      await seedOwner(fx, 'admin');
      const actorBefore = structuredClone(
        await fx.authRepo.getOrganization(fx.accountId),
      ) as AccountOrganization;
      const replacement: AccountOrganization = {
        folders: [{ name: 'Workspace revised', icon: '✅' }],
        tags: ['owner-new'],
      };
      const setOrganization = vi.spyOn(fx.authRepo, 'setOrganization');

      const res = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/organization',
        headers: {
          ...auth(fx, OWNER_ACCOUNT_ID),
          'content-type': 'application/json',
        },
        payload: replacement,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(replacement);
      expect(setOrganization).toHaveBeenCalledTimes(1);
      expect(setOrganization).toHaveBeenCalledWith(OWNER_ACCOUNT_ID, replacement);
      expect(await fx.authRepo.getOrganization(OWNER_ACCOUNT_ID)).toEqual(replacement);
      expect(await fx.authRepo.getOrganization(fx.accountId)).toEqual(actorBefore);
    },
  );

  it.each([
    ['malformed header', 'not-an-account-id'],
    ['nonmember owner', `acc_${NONMEMBER_ACCOUNT_ID}`],
  ] as const)(
    'rejects %s before body validation or organization-repo write',
    async (_case, header) => {
      fx = await buildTestApp({ scopes: ['write:profiles'] });
      const setOrganization = vi.spyOn(fx.authRepo, 'setOrganization');

      // Duplicate folders are deliberately invalid. Authorization must win so
      // an unauthorized caller cannot use validation as an oracle.
      const res = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/organization',
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': header,
          'content-type': 'application/json',
        },
        payload: { folders: [{ name: 'Dup' }, { name: 'Dup' }], tags: [] },
      });

      expect(res.statusCode).toBe(403);
      expect(setOrganization).not.toHaveBeenCalled();
    },
  );

  it.each(['write:profiles', 'write', 'account_owner'] as const)(
    'rejects a team member with %s before body validation or organization-repo write',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      await seedOwner(fx, 'member');
      const setOrganization = vi.spyOn(fx.authRepo, 'setOrganization');

      const res = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/organization',
        headers: {
          ...auth(fx, OWNER_ACCOUNT_ID),
          'content-type': 'application/json',
        },
        payload: { folders: [{ name: 'Dup' }, { name: 'Dup' }], tags: [] },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ detail: string }>().detail).toBe(
        'Team members need the admin role to change profile organization.',
      );
      expect(setOrganization).not.toHaveBeenCalled();
    },
  );
});

describe('headerless organization compatibility', () => {
  it('keeps exact self GET/PUT behavior and also treats an explicit own-account header as self', async () => {
    fx = await buildTestApp({ scopes: ['read:profiles', 'write:profiles'] });
    await fx.authRepo.setOrganization(fx.accountId, ACTOR_ORGANIZATION);

    const initial = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/organization',
      headers: auth(fx),
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toEqual(ACTOR_ORGANIZATION);

    const replacement: AccountOrganization = {
      folders: [{ name: 'Personal revised' }],
      tags: ['self-new'],
    };
    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/organization',
      headers: {
        ...auth(fx),
        'content-type': 'application/json',
      },
      payload: replacement,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await fx.authRepo.getOrganization(fx.accountId)).toEqual(replacement);

    const explicitSelf = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/organization',
      headers: auth(fx, fx.accountId),
    });
    expect(explicitSelf.statusCode, explicitSelf.body).toBe(200);
    expect(explicitSelf.json()).toEqual(replacement);
  });
});
