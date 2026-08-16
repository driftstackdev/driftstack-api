// V-174 + V-481 — scope-check predicate matrix.
//
// requireScope() is mirrored at two call sites (lib/errors-helpers
// and services/auth). Both should evaluate the same predicate.
// Unit tests pin the matrix so future migrations don't accidentally
// drift the two implementations apart.

import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';
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
    // V-174's GRANTING half. The denying half above it — admin must never reach
    // driftstack_internal_admin — was pinned from the start; the grant it exists to
    // make was not, and coverage showed it: the canonical predicate in
    // errors-helpers reached this rule 18 times through production paths, while the
    // services/auth clone reached it ZERO times, because only this matrix drives it.
    // Measured before adding: deleting the alias grant from services/auth left this
    // file green at 53/53. Two content-parity regexes do pin the source text, but a
    // text pin cannot say the rule still FIRES — it passes just as happily if a
    // refactor leaves the branch unreachable.
    { keyScopes: ['admin'], required: 'account_owner', pass: true },
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

// ── Exhaustive agreement, so the matrix above never has to be complete ──
//
// The hand-written matrix is a correctness pin: it says what the predicate SHOULD
// answer for the cases someone thought of. This block is a DRIFT pin: it says
// nothing about what the answer should be, only that all three entry points give
// the same one, for every pair the enum permits.
//
// It exists because the matrix missed a rule. V-174's granting half
// (`admin` satisfies `account_owner`) had no row, so deleting that branch from
// services/auth.ts left this file green at 53/53 while coverage showed the clone's
// alias line at ZERO executions against the canonical's 18. A missing row is
// invisible; a missing PAIR cannot be, because the pairs are generated.
//
// Scopes come from `ApiKeyScopeSchema.options` rather than a local list, so adding
// a scope to the enum extends this automatically instead of silently leaving the
// new one uncompared — the failure mode a hardcoded list would reintroduce.
//
// Granted sets are every subset of size 0, 1 and 2. Size 2 matters: several rules
// read one scope while a second is present, and a singleton-only sweep cannot see
// an implementation that consults the wrong element.
describe('requireScope — the two implementations agree on every pair', () => {
  const ALL = ApiKeyScopeSchema.options;

  const grantedSets: ApiKeyScope[][] = [[]];
  for (const a of ALL) {
    grantedSets.push([a]);
    for (const b of ALL) if (a < b) grantedSets.push([a, b]);
  }

  const throws = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  it(`CRITICAL all three entry points answer identically across ${String(grantedSets.length)} granted sets x ${String(ALL.length)} required scopes. requireScope is implemented twice — inline in services/auth.ts and via scopesSatisfy in lib/errors-helpers.ts — and the two are kept in step by hand; this compares them on every pair the enum permits, so a rule added to one and not the other cannot pass unnoticed the way the V-174 alias grant did.`, () => {
    const disagreements: string[] = [];

    for (const granted of grantedSets) {
      const ctx = ctxWithScopes(granted);
      for (const required of ALL) {
        const authDenies = throws(() => {
          requireScopeFromAuth(ctx, required);
        });
        const helpersDenies = throws(() => {
          requireScopeFromHelpers(ctx, required);
        });
        const predicateDenies = !hasScope(ctx, required);
        if (authDenies !== helpersDenies || authDenies !== predicateDenies) {
          disagreements.push(
            `granted=[${granted.join(',')}] required=${required} → ` +
              `auth=${authDenies ? 'deny' : 'allow'} ` +
              `helpers=${helpersDenies ? 'deny' : 'allow'} ` +
              `hasScope=${predicateDenies ? 'deny' : 'allow'}`,
          );
        }
      }
    }

    expect(disagreements, 'scope predicates disagree').toEqual([]);
  });
});
