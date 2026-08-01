// V-727 — terminating an account must also revoke the keys it minted on OTHER
// accounts.
//
// V-726 closed this for the team-member REMOVAL door: an admin-role member can
// mint keys on the owner's account, those keys carry account_id = the owner and
// authenticate as the owner, and nothing re-checks the minter's membership — so
// removal now revokes them.
//
// Account TERMINATION is the same hole reached by a different door.
// `revokeAllForAccount` reclaims by `account_id`, so deleting the member's
// account revokes the credentials ON that account and cannot see the ones it
// created on someone else's workspace. Those kept working, authenticating as
// the owner, held by someone whose account had just been deleted.
//
// The distinction under test is precisely that a key can live on an account
// other than the one being terminated.

import { describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { ApiKeysService } from '../../src/services/api-keys.js';
import type { AccountContext } from '../../src/services/auth.js';
import { InMemoryApiKeysRepo } from '../integration/_helpers/in-memory-api-keys-repo.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000b2';
const OTHER = '00000000-0000-4000-8000-0000000000c3';

function adminCtx(scopes: ApiKeyScope[] = ['driftstack_internal_admin']): AccountContext {
  return {
    account: { id: OWNER, tier: 'api_starter', status: 'active' },
    apiKey: { id: 'key_admin', scopes },
    rateLimitOverrides: {},
    teams: [],
  } as unknown as AccountContext;
}

async function seed(repo: InMemoryApiKeysRepo, accountId: string, minter: string | null) {
  const row = await repo.insertApiKey({
    accountId,
    name: `k-${accountId}-${minter ?? 'none'}`,
    scopes: ['read'],
    keyPrefix: `ds_test_${Math.random().toString(36).slice(2, 8)}`,
    keyHash: `hash-${Math.random()}`,
    expiresAt: null,
    ...(minter === null ? {} : { createdByAccountId: minter }),
  });
  return row;
}

describe('V-727 ApiKeysService.revokeAllMintedByAccount', () => {
  it('revokes a key the account minted on a DIFFERENT account, which the by-account reclaim cannot reach', async () => {
    const repo = new InMemoryApiKeysRepo();
    // The key at the heart of it: it lives on the OWNER, but the MEMBER made it.
    const onOwnerByMember = await seed(repo, OWNER, MEMBER);
    // Must survive: the owner's own key, a third party's key, and the member's
    // own key on their own account (that one is the by-account reclaim's job).
    const onOwnerByOwner = await seed(repo, OWNER, OWNER);
    const onOtherByOther = await seed(repo, OTHER, OTHER);
    const onMemberByMember = await seed(repo, MEMBER, MEMBER);

    const svc = new ApiKeysService(repo);
    const revoked = await svc.revokeAllMintedByAccount(adminCtx(), MEMBER);

    // Both keys the member minted: the one on the owner AND their own.
    expect(revoked).toBe(2);
    expect((await repo.findApiKeyUnscoped(onOwnerByMember.id))?.revokedAt).not.toBeNull();
    expect((await repo.findApiKeyUnscoped(onMemberByMember.id))?.revokedAt).not.toBeNull();
    // Everything not attributable to the member is untouched.
    expect((await repo.findApiKeyUnscoped(onOwnerByOwner.id))?.revokedAt).toBeNull();
    expect((await repo.findApiKeyUnscoped(onOtherByOther.id))?.revokedAt).toBeNull();
  });

  it('leaves keys with no recorded minter alone', async () => {
    // Rows written before migration 0111 carry no creator. Unattributed is not
    // attributable — revoking on a guess would break the owner's integrations.
    const repo = new InMemoryApiKeysRepo();
    const legacy = await seed(repo, OWNER, null);

    const svc = new ApiKeysService(repo);
    expect(await svc.revokeAllMintedByAccount(adminCtx(), MEMBER)).toBe(0);
    expect((await repo.findApiKeyUnscoped(legacy.id))?.revokedAt).toBeNull();
  });

  it('works for a staff API key that holds ONLY driftstack_internal_admin', async () => {
    // The reclaim must not depend on which credential TYPE the operator used.
    // A staff WEB SESSION is granted account_owner in its baseScopes
    // (services/auth.ts), so routing through the customer revoke() happened to
    // work for the admin panel — and threw ForbiddenError for a staff API key,
    // which AccountsAdminService.deleteAccount catches and discards. The
    // termination then reported success having revoked nothing.
    const repo = new InMemoryApiKeysRepo();
    const onOwnerByMember = await seed(repo, OWNER, MEMBER);
    const svc = new ApiKeysService(repo);

    const revoked = await svc.revokeAllMintedByAccount(
      adminCtx(['driftstack_internal_admin']),
      MEMBER,
    );

    expect(revoked).toBe(1);
    expect((await repo.findApiKeyUnscoped(onOwnerByMember.id))?.revokedAt).not.toBeNull();
  });

  it('the by-account reclaim is likewise independent of the caller customer scopes', async () => {
    const repo = new InMemoryApiKeysRepo();
    const own = await seed(repo, OWNER, OWNER);
    const svc = new ApiKeysService(repo);

    expect(await svc.revokeAllForAccount(adminCtx(['driftstack_internal_admin']), OWNER)).toBe(1);
    expect((await repo.findApiKeyUnscoped(own.id))?.revokedAt).not.toBeNull();
  });

  it('is staff-only, like the sibling reclaim', async () => {
    const repo = new InMemoryApiKeysRepo();
    await seed(repo, OWNER, MEMBER);
    const svc = new ApiKeysService(repo);
    await expect(svc.revokeAllMintedByAccount(adminCtx(['account_owner']), MEMBER)).rejects.toThrow(
      /driftstack_internal_admin/,
    );
  });
});
