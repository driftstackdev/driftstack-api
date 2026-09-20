// An Enterprise contract's figure reaches the repo that writes it, with the
// admin who asked attached to it.
//
// The Enterprise rule lives in the repo, because that is where the transaction
// is: the tier and the `contract` override it is worth are written together or
// not at all (`an-admin-tier-change-holds-the-account-…` proves that against
// Postgres). This file covers the two hops in front of it, where a figure is
// easy to drop silently:
//
//   · the REQUEST schema, which must accept a whole number of credits inside
//     the range the database will take, and refuse anything else before the
//     transaction is opened;
//   · `AccountsAdminService.changeTier`, which passes the options through
//     UNCHANGED and stamps the admin key that asked onto them — the audit trail
//     on the override row. A caller that supplied no figure must reach the repo
//     with NO figure, not with an explicit `undefined` that a later `in` check
//     would read as "they sent one".

import { describe, expect, it } from 'vitest';
import { ChangeTierRequestSchema, type AccountTier, type ApiKeyScope } from '@driftstack/api-types';
import {
  AccountsAdminService,
  type AccountsAdminRepo,
  type SetAccountTierOptions,
} from '../../src/services/admin-accounts.js';
import type { AccountContext, AccountRow } from '../../src/services/auth.js';

const ADMIN_KEY = 'key_admin_1';
const ACCOUNT = 'acc_1';

function ctx(): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: ADMIN_KEY, scopes: ['driftstack_internal_admin'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

function serviceRecording(seen: { opts?: SetAccountTierOptions }): AccountsAdminService {
  const repo = {
    setTier: (id: string, tier: AccountTier, _at: Date, opts?: SetAccountTierOptions) => {
      seen.opts = opts;
      return Promise.resolve({ id, tier } as unknown as AccountRow);
    },
  } as unknown as AccountsAdminRepo;
  return new AccountsAdminService(repo);
}

describe('an enterprise contract figure reaches the repo that writes it', () => {
  it('CRITICAL the figure and the note are passed through UNCHANGED, and the admin key that asked is stamped on them', async () => {
    const seen: { opts?: SetAccountTierOptions } = {};
    await serviceRecording(seen).changeTier(ctx(), ACCOUNT, 'enterprise', {
      monthlyCredits: 42_000,
      note: 'signed 2026-09',
    });

    expect(seen.opts).toEqual({
      monthlyCredits: 42_000,
      note: 'signed 2026-09',
      setByKeyId: ADMIN_KEY,
    });
  });

  it('CRITICAL a tier change with NO figure reaches the repo with no figure — not with an explicit undefined, which is what the Enterprise refusal is keyed on', async () => {
    const seen: { opts?: SetAccountTierOptions } = {};
    await serviceRecording(seen).changeTier(ctx(), ACCOUNT, 'api_scale');

    expect(seen.opts).toEqual({ setByKeyId: ADMIN_KEY });
    expect(seen.opts?.monthlyCredits).toBeUndefined();
  });

  it('a key id the caller supplied wins over the context’s, so a tool acting for another admin records the right one', async () => {
    const seen: { opts?: SetAccountTierOptions } = {};
    await serviceRecording(seen).changeTier(ctx(), ACCOUNT, 'enterprise', {
      monthlyCredits: 1,
      setByKeyId: 'key_someone_else',
    });

    expect(seen.opts?.setByKeyId).toBe('key_someone_else');
  });

  it('CRITICAL the request schema takes a whole number of credits from 0 to ten million — the range the database’s own CHECK takes — and refuses everything else', () => {
    for (const good of [0, 1, 42_000, 10_000_000]) {
      expect(
        ChangeTierRequestSchema.parse({ tier: 'enterprise', monthly_credits: good }),
        String(good),
      ).toMatchObject({ monthly_credits: good });
    }
    for (const bad of [-1, 0.5, 10_000_001, '42000', null]) {
      expect(
        ChangeTierRequestSchema.safeParse({ tier: 'enterprise', monthly_credits: bad }).success,
        String(bad),
      ).toBe(false);
    }
    // Optional: every other plan ignores it, and a request that sends none is
    // the ordinary tier change it has always been.
    const plain = ChangeTierRequestSchema.parse({ tier: 'api_scale' });
    expect('monthly_credits' in plain).toBe(false);
  });
});
