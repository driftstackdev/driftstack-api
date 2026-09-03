// GDPR Article 17 — a 'deleted' account must be rejected on the NEXT auth
// attempt for both credential shapes authenticate() supports. auth.ts's two
// `account.status === 'deleted'` checks (slowPathApiKey + slowPathWebSession)
// existed as dead code before AccountsAdminService.deleteAccount() shipped —
// nothing ever set status='deleted'. This exercises both branches directly
// against authenticate() with a fake AccountAuthRepo (no real scrypt/DB).
//
// The API-key branch is ALSO covered end-to-end at the HTTP layer by
// apps/server/tests/integration/auth.test.ts ("401 when account deleted").
// This file adds the web-session branch, which had no coverage anywhere,
// plus a focused unit-level API-key check alongside it for symmetry.

import { describe, expect, it } from 'vitest';
import {
  authenticate,
  type AccountAuthRepo,
  type AccountRow,
  type ApiKeyRow,
  type WebSessionAuthRow,
} from '../../src/services/auth.js';
import { InvalidKeyError } from '../../src/lib/errors.js';
import { hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { sha256Hex } from '../../src/services/auth-cache.js';

const DELETED_ACCOUNT: AccountRow = {
  id: 'acc_deleted',
  email: 'gone@e.test',
  name: null,
  tier: 'solo_manual',
  status: 'deleted',
  timezone: null,
  avatarR2Key: null,
  slug: null,
  region: null,
  createdAt: new Date('2026-01-01Z'),
  updatedAt: new Date('2026-06-01Z'),
} as unknown as AccountRow;

function baseRepo(overrides: Partial<AccountAuthRepo> = {}): AccountAuthRepo {
  return {
    findApiKeyByPrefix: () => Promise.resolve(null),
    getAccount: () => Promise.resolve(DELETED_ACCOUNT),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(null),
    touchWebSessionLastUsed: () => Promise.resolve(),
    findTeamMemberships: () => Promise.resolve([]),
    updateAccountBasics: () => Promise.resolve(null),
    setOnboardingCompleted: () => Promise.resolve(),
    getOnboardingCompletedAt: () => Promise.resolve(null),
    getOrganization: () => Promise.resolve(null),
    setOrganization: () => Promise.resolve(),
    ...overrides,
  };
}

describe('GDPR Article 17 — authenticate() rejects a deleted account', () => {
  it('web-session path: a deleted account throws InvalidKeyError (slowPathWebSession)', async () => {
    const plaintext = 'wsess_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // no ds_ prefix → web-session shape
    const sha = sha256Hex(plaintext);
    const row: WebSessionAuthRow = {
      id: 'ws_1',
      accountId: DELETED_ACCOUNT.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastUsedAt: null,
      mfaSatisfiedAt: null,
      createdAt: new Date('2026-05-01Z'),
    };
    const repo = baseRepo({
      findActiveWebSession: (args) => Promise.resolve(args.tokenHash === sha ? row : null),
    });

    await expect(authenticate(repo, plaintext, null, new Date())).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it('API-key path: a deleted account throws InvalidKeyError (slowPathApiKey)', async () => {
    const plaintext = 'ds_live_deletedaccountkeyvalueaaaaa';
    const keyHash = await hashApiKey(plaintext);
    const apiKey: ApiKeyRow = {
      id: 'key_1',
      accountId: DELETED_ACCOUNT.id,
      name: 'test key',
      keyPrefix: keyPrefixFromPlaintext(plaintext),
      keyHash,
      scopes: ['read', 'write'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01Z'),
    };
    const repo = baseRepo({
      findApiKeyByPrefix: () => Promise.resolve(apiKey),
    });

    await expect(authenticate(repo, plaintext, null, new Date())).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });
});
