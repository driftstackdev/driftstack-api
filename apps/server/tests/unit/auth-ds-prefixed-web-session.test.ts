// C4 — a web-session token that begins with `ds_` by chance (~1 in 262k of
// them, since session tokens are URL-safe-base64 random bytes) must still
// authenticate. Before the fix, isApiKeyShape('ds_…') routed it to the
// API-key path, which threw InvalidKeyError on the prefix miss with no
// fall-through — that session could never authenticate again (a silent,
// permanent break). authenticate() now falls through to the web-session
// path when no API key carries the prefix.

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

const ACTIVE: AccountRow = {
  id: 'acc_active',
  email: 'a@e.test',
  name: null,
  tier: 'solo_manual',
  status: 'active',
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
    getAccount: () => Promise.resolve(ACTIVE),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(null),
    touchWebSessionLastUsed: () => Promise.resolve(),
    findTeamMemberships: () => Promise.resolve([]),
    updateAccountBasics: () => Promise.resolve(null),
    getOrganization: () => Promise.resolve(null),
    setOrganization: () => Promise.resolve(),
    ...overrides,
  };
}

describe('C4 — ds_-prefixed web-session token falls through to the web-session path', () => {
  it('authenticates a valid web session whose token happens to start with ds_', async () => {
    // Starts with ds_ → isApiKeyShape true → would route to the API-key path.
    const plaintext = 'ds_thisisactuallyawebsessiontoken_000000000000';
    const sha = sha256Hex(plaintext);
    const session: WebSessionAuthRow = {
      id: 'ws_ds',
      accountId: ACTIVE.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastUsedAt: null,
      mfaSatisfiedAt: null,
      createdAt: new Date('2026-05-01Z'),
    };
    const repo = baseRepo({
      // No API key carries this prefix (the common case for a chance ds_ token).
      findApiKeyByPrefix: () => Promise.resolve(null),
      findActiveWebSession: (args) => Promise.resolve(args.tokenHash === sha ? session : null),
    });

    const ctx = await authenticate(repo, plaintext, null, new Date());
    expect(ctx.account.id).toBe(ACTIVE.id);
    // Authed via the web-session path, so webSession is populated.
    expect(ctx.webSession?.id).toBe('ws_ds');
  });

  it('still rejects a ds_-shaped token matching neither an API key nor a web session', async () => {
    const plaintext = 'ds_live_bogus_nothing_matches_this_00000000';
    const repo = baseRepo({
      findApiKeyByPrefix: () => Promise.resolve(null),
      findActiveWebSession: () => Promise.resolve(null),
    });
    await expect(authenticate(repo, plaintext, null, new Date())).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it('still authenticates a genuine ds_ API key via the API-key path (no regression)', async () => {
    const plaintext = 'ds_live_realapikeyvalue_aaaaaaaaaaaaaaaaaa';
    const keyHash = await hashApiKey(plaintext);
    const apiKey: ApiKeyRow = {
      id: 'key_real',
      accountId: ACTIVE.id,
      name: 'real key',
      keyPrefix: keyPrefixFromPlaintext(plaintext),
      keyHash,
      scopes: ['read', 'write'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01Z'),
    };
    const repo = baseRepo({
      findApiKeyByPrefix: (prefix) =>
        Promise.resolve(prefix === keyPrefixFromPlaintext(plaintext) ? apiKey : null),
      // Never consulted for a valid API key.
      findActiveWebSession: () => Promise.resolve(null),
    });
    const ctx = await authenticate(repo, plaintext, null, new Date());
    expect(ctx.account.id).toBe(ACTIVE.id);
    expect(ctx.apiKey.id).toBe('key_real');
    expect(ctx.webSession).toBeNull();
  });
});
