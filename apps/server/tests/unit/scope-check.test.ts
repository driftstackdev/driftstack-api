// V-174 + V-481 — scope-check predicate matrix.
//
// requireScope() is mirrored at two call sites (lib/errors-helpers
// and services/auth). Both should evaluate the same predicate.
// Unit tests pin the matrix so future migrations don't accidentally
// drift the two implementations apart.

import { describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { requireScope as requireScopeFromHelpers, hasScope } from '../../src/lib/errors-helpers.js';
import { requireScope as requireScopeFromAuth } from '../../src/services/auth.js';
import type { AccountContext } from '../../src/services/auth.js';

function ctxWithScopes(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: {
      id: 'acc_test',
      email: 'test@example.com',
      tier: 'api_starter',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      paymentMethodLast4: null,
      paymentMethodBrand: null,
      activeSession: 0,
      createdAt: new Date(),
      slug: null,
      avatarUrl: null,
      avatarObjectKey: null,
      timezone: null,
      region: null,
    },
    apiKey: {
      id: 'key_test',
      name: 'test',
      scopes,
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: null,
    },
    membership: null,
  } as unknown as AccountContext;
}

describe('hasScope (V-481 predicate)', () => {
  it('exact match: returns true when key has the required scope verbatim', () => {
    const ctx = ctxWithScopes(['read:sessions']);
    expect(hasScope(ctx, 'read:sessions')).toBe(true);
  });

  it('exact match: returns false when scope absent', () => {
    const ctx = ctxWithScopes(['read:sessions']);
    expect(hasScope(ctx, 'read:profiles')).toBe(false);
  });

  it('V-174 admin alias: admin satisfies account_owner', () => {
    const ctx = ctxWithScopes(['admin']);
    expect(hasScope(ctx, 'account_owner')).toBe(true);
  });

  it('V-174 legacy admin never satisfies driftstack_internal_admin', () => {
    const ctx = ctxWithScopes(['admin']);
    expect(hasScope(ctx, 'driftstack_internal_admin')).toBe(false);
  });

  describe('V-481 broad satisfies granular (read verb)', () => {
    it('read satisfies read:sessions', () => {
      expect(hasScope(ctxWithScopes(['read']), 'read:sessions')).toBe(true);
    });
    it('read satisfies read:profiles', () => {
      expect(hasScope(ctxWithScopes(['read']), 'read:profiles')).toBe(true);
    });
    it('read satisfies read:webhooks', () => {
      expect(hasScope(ctxWithScopes(['read']), 'read:webhooks')).toBe(true);
    });
    it('read satisfies read:audit', () => {
      expect(hasScope(ctxWithScopes(['read']), 'read:audit')).toBe(true);
    });
    it('account_owner satisfies read:sessions', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'read:sessions')).toBe(true);
    });
  });

  describe('V-481 broad satisfies granular (write verb)', () => {
    it('write satisfies write:sessions', () => {
      expect(hasScope(ctxWithScopes(['write']), 'write:sessions')).toBe(true);
    });
    it('write satisfies write:profiles', () => {
      expect(hasScope(ctxWithScopes(['write']), 'write:profiles')).toBe(true);
    });
    it('account_owner satisfies write:webhooks', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'write:webhooks')).toBe(true);
    });
  });

  describe('V-481 broad satisfies granular (admin verb)', () => {
    it('admin satisfies admin:profiles', () => {
      expect(hasScope(ctxWithScopes(['admin']), 'admin:profiles')).toBe(true);
    });
    it('admin satisfies admin:webhooks', () => {
      expect(hasScope(ctxWithScopes(['admin']), 'admin:webhooks')).toBe(true);
    });
    it('account_owner satisfies admin:billing', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'admin:billing')).toBe(true);
    });
    it('admin satisfies admin:api-keys', () => {
      expect(hasScope(ctxWithScopes(['admin']), 'admin:api-keys')).toBe(true);
    });
  });

  describe('V-481 narrow does NOT satisfy broad (the whole point)', () => {
    it('read:sessions does NOT satisfy read', () => {
      expect(hasScope(ctxWithScopes(['read:sessions']), 'read')).toBe(false);
    });
    it('write:sessions does NOT satisfy write', () => {
      expect(hasScope(ctxWithScopes(['write:sessions']), 'write')).toBe(false);
    });
    it('admin:profiles does NOT satisfy admin', () => {
      expect(hasScope(ctxWithScopes(['admin:profiles']), 'admin')).toBe(false);
    });
    it('read:sessions does NOT satisfy account_owner', () => {
      expect(hasScope(ctxWithScopes(['read:sessions']), 'account_owner')).toBe(false);
    });
  });

  describe('V-481 narrow does NOT cross-resource satisfy', () => {
    it('read:sessions does NOT satisfy read:profiles', () => {
      expect(hasScope(ctxWithScopes(['read:sessions']), 'read:profiles')).toBe(false);
    });
    it('admin:profiles does NOT satisfy admin:webhooks', () => {
      expect(hasScope(ctxWithScopes(['admin:profiles']), 'admin:webhooks')).toBe(false);
    });
  });

  describe('cross-verb mismatch within granular', () => {
    it('read does NOT satisfy write:sessions', () => {
      expect(hasScope(ctxWithScopes(['read']), 'write:sessions')).toBe(false);
    });
    it('write does NOT satisfy read:sessions', () => {
      expect(hasScope(ctxWithScopes(['write']), 'read:sessions')).toBe(false);
    });
    it('write does NOT satisfy admin:profiles', () => {
      expect(hasScope(ctxWithScopes(['write']), 'admin:profiles')).toBe(false);
    });
  });

  // account_owner is the customer's full-account-control superscope: it MUST
  // satisfy the BARE read/write verbs (not just granular ones). Regression guard
  // for the desktop device-login key, which cli-authorize mints as
  // scopes:['account_owner'] — without this it could not launch sessions
  // (POST /v1/agent-sessions requireScope('write') 403'd).
  describe('account_owner satisfies bare read/write (superscope), NOT staff gates', () => {
    it('account_owner satisfies bare write', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'write')).toBe(true);
    });
    it('account_owner satisfies bare read', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'read')).toBe(true);
    });
    it('account_owner does NOT satisfy bare admin (staff gate)', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'admin')).toBe(false);
    });
    it('account_owner does NOT satisfy driftstack_internal_admin (staff gate)', () => {
      expect(hasScope(ctxWithScopes(['account_owner']), 'driftstack_internal_admin')).toBe(false);
    });
  });
});

describe('requireScope — both call sites evaluate the same predicate', () => {
  const matrix: Array<{
    keyScopes: ApiKeyScope[];
    required: ApiKeyScope;
    pass: boolean;
  }> = [
    { keyScopes: ['read'], required: 'read:sessions', pass: true },
    { keyScopes: ['read'], required: 'write:sessions', pass: false },
    { keyScopes: ['admin'], required: 'admin:webhooks', pass: true },
    { keyScopes: ['account_owner'], required: 'admin:profiles', pass: true },
    { keyScopes: ['read:sessions'], required: 'read', pass: false },
    { keyScopes: ['read:sessions'], required: 'read:profiles', pass: false },
    { keyScopes: ['read:sessions'], required: 'read:sessions', pass: true },
    { keyScopes: ['admin'], required: 'driftstack_internal_admin', pass: false },
    // account_owner superscope → bare read/write pass; staff gates fail.
    { keyScopes: ['account_owner'], required: 'write', pass: true },
    { keyScopes: ['account_owner'], required: 'read', pass: true },
    { keyScopes: ['account_owner'], required: 'admin', pass: false },
    { keyScopes: ['account_owner'], required: 'driftstack_internal_admin', pass: false },
  ];

  for (const { keyScopes, required, pass } of matrix) {
    const label = `key=[${keyScopes.join(',')}] required=${required} → ${pass ? 'pass' : 'fail'}`;
    it(`helpers: ${label}`, () => {
      const ctx = ctxWithScopes(keyScopes);
      if (pass) {
        expect(() => requireScopeFromHelpers(ctx, required)).not.toThrow();
      } else {
        expect(() => requireScopeFromHelpers(ctx, required)).toThrow();
      }
    });
    it(`auth.ts: ${label}`, () => {
      const ctx = ctxWithScopes(keyScopes);
      if (pass) {
        expect(() => requireScopeFromAuth(ctx, required)).not.toThrow();
      } else {
        expect(() => requireScopeFromAuth(ctx, required)).toThrow();
      }
    });
  }
});
