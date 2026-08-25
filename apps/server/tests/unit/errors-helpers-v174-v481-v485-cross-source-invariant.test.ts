// W967 — errors-helpers V-174 + V-481 + V-485 cross-source invariant.
// Two-hundred-ninety-third in the drift-guard series. Pins the
// scope-check + tier-feature-guard primitives:
//
//   Service intro framing — 'Helpers that need the AccountContext
//   type but live next to errors.ts so services can import without
//   pulling the auth service'.
//
//   3 scope-check rules (V-174 + V-481):
//     1. Exact match — key carries required scope verbatim.
//     2. V-174 legacy customer alias — admin-scoped keys satisfy
//        account_owner but never driftstack_internal_admin.
//     3. V-481 broad-satisfies-granular — when required is granular
//        (read:X, write:X, admin:X), broad key scopes on the same
//        verb satisfy:
//        - read:X ← any of: read, account_owner.
//        - write:X ← any of: write, account_owner.
//        - admin:X ← any of: account_owner, admin.
//        Granular does NOT satisfy broad (narrow keys stay narrow).
//
//   2 scope-check functions:
//     - requireScope(ctx, required) — throws ForbiddenError on fail.
//     - hasScope(ctx, required) — pure boolean predicate.
//
//   Mirror-in-auth framing — 'Mirrored in services/auth.ts::
//   requireScope (kept in sync — same predicate evaluated at both
//   call sites)'.
//
//   V-485 requireTierFeature — per-tier boolean-feature guard.
//   'Throws ForbiddenError when the given tier does NOT have the
//   requested boolean feature enabled'.
//
//   V-485 feature-matrix framing — 'Today's matrix: apiAccess,
//   aiAgent and vpnEgress are gated this way — every boolean field
//   on TierFeatures. Future features extend TierFeatures and pass
//   through the same guard'. V-763 corrected this from 'only
//   aiAgent': apiAccess was already gated, and vpnEgress was
//   published as a paid-tier difference nothing enforced.
//
//   Re-exports NotFoundError from errors.ts.
//
// stays in lockstep across apps/server/src/lib/errors-helpers.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasScope, requireScope } from '../../src/lib/errors-helpers.js';
import type { AccountContext } from '../../src/services/auth.js';
import type { ApiKeyScope } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function ctxWithScopes(scopes: ApiKeyScope[]): AccountContext {
  return {
    apiKey: { scopes },
  } as unknown as AccountContext;
}

describe('W967 errors-helpers V-174 + V-481 + V-485 cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/lib/errors-helpers.ts header pins surface — 'Helpers that need the AccountContext type but live next to errors.ts so services can import without pulling the auth service'. The next-to-errors-not-auth design avoids cyclic imports.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/Helpers that need the AccountContext type but live next to errors\.ts so/);
    expect(p).toMatch(/services can import without pulling the auth service\./);
  });

  // ─── V-174 legacy customer alias framing ────────────────────

  it('CRITICAL V-174 + V-481 scope-check framing keeps legacy admin customer-only and requires exact staff scope', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/V-174 \+ V-481 — scope check with backwards-compat aliases\./);
    expect(p).toMatch(/1\. Exact match — the key carries the required scope verbatim\./);
    expect(p).toMatch(/2\. V-174 legacy customer alias — `'admin'`-scoped keys satisfy/);
    expect(p).toMatch(/`'account_owner'` so pre-split customer automation keeps its own-account/);
    expect(p).toMatch(/The expired migration bridge to/);
    expect(p).toMatch(/`'driftstack_internal_admin'` is deliberately closed: only the exact/);
    expect(p).toMatch(/staff scope can authorize cross-account operations\./);
  });

  // ─── V-481 broad-satisfies-granular framing ──────────────────

  it("CRITICAL V-481 broad-satisfies-granular framing — '3. V-481 broad-satisfies-granular — when the required scope is granular (read:sessions, admin:profiles, etc.), the key's broad scopes can satisfy it on the same verb: required read:X is satisfied by any of read, account_owner (read implied by full account access). required write:X is satisfied by write, account_owner. required admin:X is satisfied by account_owner, admin. Granular scopes do NOT satisfy broad checks — a key with read:sessions cannot pass requireScope(read). That's the point of granular scoping; narrow keys stay narrow'. The asymmetric broad-satisfies-granular but not vice-versa is the V-481 narrow-keys-stay-narrow contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/3\. V-481 broad-satisfies-granular — when the required scope is/);
    expect(p).toMatch(/granular \(`read:sessions`, `admin:profiles`, etc\.\), the key's/);
    expect(p).toMatch(/broad scopes can satisfy it on the same verb:/);
    expect(p).toMatch(/- required `read:X` is satisfied by any of `read`,/);
    expect(p).toMatch(/`account_owner` \(read implied by full account access\)\./);
    expect(p).toMatch(/- required `write:X` is satisfied by `write`, `account_owner`\./);
    expect(p).toMatch(/- required `admin:X` is satisfied by `account_owner`, `admin`\./);
    expect(p).toMatch(/Granular scopes do NOT satisfy broad checks — a key with/);
    expect(p).toMatch(/`read:sessions` cannot pass `requireScope\('read'\)`\. That's/);
    expect(p).toMatch(/the point of granular scoping; narrow keys stay narrow\./);
  });

  // ─── Mirror-in-auth framing ──────────────────────────────────

  it("CRITICAL mirror-in-auth framing — 'Mirrored in services/auth.ts::requireScope (kept in sync — same predicate evaluated at both call sites)'. The 2-copies-of-predicate design lets auth-middleware avoid the import-cycle.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/Mirrored in `services\/auth\.ts::requireScope` \(kept in sync — same/);
    expect(p).toMatch(/predicate evaluated at both call sites\)\./);
  });

  // ─── requireScope + hasScope 2-function split ────────────────

  it('CRITICAL 2-function split — requireScope throws ForbiddenError on fail; hasScope returns boolean. The 2-function design lets routes choose throw-or-test semantics without duplicating the predicate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(
      /export function requireScope\(ctx: AccountContext, required: ApiKeyScope\): void \{/,
    );
    expect(p).toMatch(/if \(hasScope\(ctx, required\)\) return;/);
    expect(p).toMatch(
      /throw new ForbiddenError\(`This action requires the "\$\{required\}" scope\.`\);/,
    );
    expect(p).toMatch(
      /export function hasScope\(ctx: AccountContext, required: ApiKeyScope\): boolean \{/,
    );
  });

  it('CRITICAL hasScope JSDoc pins the legacy alias as customer-only', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/V-481 — pure predicate version of \{@link requireScope\}\. Returns/);
    expect(p).toMatch(/true iff the key satisfies the required scope \(exact, V-174 legacy/);
    expect(p).toMatch(/customer alias, or V-481 broad-satisfies-granular\)\./);
  });

  // ─── 3-verb exhaustive switch ────────────────────────────────

  it("CRITICAL 3-verb exhaustive switch in hasScope — 'read' | 'write' | 'admin' branches, with const _exhaustive: never default to enforce exhaustiveness at compile time. The exhaustiveness check is TS-level defense against new verbs being added without updating the predicate.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/case 'read':/);
    expect(p).toMatch(
      /return scopes\.includes\('read'\) \|\| scopes\.includes\('account_owner'\);/,
    );
    expect(p).toMatch(/case 'write':/);
    expect(p).toMatch(
      /return scopes\.includes\('write'\) \|\| scopes\.includes\('account_owner'\);/,
    );
    expect(p).toMatch(/case 'admin':/);
    expect(p).toMatch(
      /return scopes\.includes\('admin'\) \|\| scopes\.includes\('account_owner'\);/,
    );
    expect(p).toMatch(/const _exhaustive: never = granular\.verb;/);
  });

  // ─── V-485 requireTierFeature framing ────────────────────────

  it("CRITICAL V-485 requireTierFeature JSDoc — 'V-485 — per-tier feature guard. Throws ForbiddenError when the given tier does NOT have the requested boolean feature enabled. Use this in route handlers gating tier-restricted endpoints (e.g. AI-agent endpoints land in V-487+). The single guard call replaces if (tier === X || tier === Y) throw … style scattered conditionals — when a tier's feature row in packages/api-types/src/common.ts:TIER_FEATURES flips, every call site picks it up automatically'. The single-guard + TIER_FEATURES-as-source-of-truth design replaces tier-string-comparison scatter.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/V-485 — per-tier feature guard\. Throws `ForbiddenError` when the/);
    expect(p).toMatch(/given tier does NOT have the requested boolean feature enabled\./);
    expect(p).toMatch(/Use this in route handlers gating tier-restricted endpoints \(e\.g\./);
    expect(p).toMatch(/AI-agent endpoints land in V-487\+\)\. The single guard call replaces/);
    expect(p).toMatch(/`if \(tier === 'X' \|\| tier === 'Y'\) throw …` style scattered/);
    expect(p).toMatch(/conditionals — when a tier's feature row in/);
    expect(p).toMatch(/`packages\/api-types\/src\/common\.ts:TIER_FEATURES` flips, every/);
    expect(p).toMatch(/call site picks it up automatically\./);
  });

  it("CRITICAL V-485 feature-matrix framing — 'Today's matrix: apiAccess, aiAgent and vpnEgress are gated this way — every boolean field on TierFeatures'. V-763 corrected this from 'only aiAgent', which had gone stale in BOTH directions: apiAccess was already gated, and vpnEgress was published as a paid-tier difference that nothing enforced. Two pins froze the stale sentence, so the comment could not be corrected without them. (trialPack reference removed 2026-05-27.)", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/Today's matrix: `apiAccess`, `aiAgent` and `vpnEgress` are gated this/);
    expect(p).toMatch(
      /Future\s*\*\s*features extend `TierFeatures` and pass through the same guard/,
    );
    expect(p).not.toMatch(/trialPack/);
  });

  // ─── requireTierFeature error message ────────────────────────

  it('CRITICAL requireTierFeature error message — \'The "feature" feature is not available on the "tier" tier. Upgrade to a tier that includes this feature.\' 2-sentence interpolation. The upgrade-prompt-in-message is the customer-facing 403-explanation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/`The "\$\{feature\}" feature is not available on the "\$\{tier\}" tier\. `/);
    expect(p).toMatch(/`Upgrade to a tier that includes this feature\.`/);
  });

  // ─── NotFoundError re-export ─────────────────────────────────

  it('CRITICAL NotFoundError re-exported from errors-helpers — `export { NotFoundError };`. The re-export lets services import requireScope + NotFoundError from one module (matches convention across W940 admin-accounts / W919 oauth / W946 sessions).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/export \{ NotFoundError \};/);
  });

  // ─── Imports check ───────────────────────────────────────────

  it('CRITICAL imports parseGranularScope + TIER_FEATURES (values) + AccountTier + ApiKeyScope + TierBooleanFeature (types) from @driftstack/api-types. The api-types primitives are the cross-service shared vocabulary.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts'));
    expect(p).toMatch(/parseGranularScope,/);
    expect(p).toMatch(/TIER_FEATURES,/);
    expect(p).toMatch(/type AccountTier,/);
    expect(p).toMatch(/type ApiKeyScope,/);
    expect(p).toMatch(/type TierBooleanFeature,/);
    expect(p).toMatch(/\} from '@driftstack\/api-types';/);
  });

  // ─── Runtime parity: rule 1 (exact match) ────────────────────

  it("CRITICAL hasScope rule 1 — exact match returns true. A key with scope 'read:sessions' satisfies requireScope('read:sessions').", () => {
    const ctx = ctxWithScopes(['read:sessions']);
    expect(hasScope(ctx, 'read:sessions')).toBe(true);
  });

  // ─── Runtime parity: rule 2 (legacy customer alias) ──────────

  it('CRITICAL hasScope rule 2 — legacy admin preserves account_owner but cannot cross the staff boundary', () => {
    const ctx = ctxWithScopes(['admin']);
    expect(hasScope(ctx, 'account_owner')).toBe(true);
    expect(hasScope(ctx, 'driftstack_internal_admin')).toBe(false);
  });

  it('CRITICAL hasScope rule 2 — admin aliases account_owner and its own admin:X verb only, not staff or unrelated granular reads', () => {
    const ctx = ctxWithScopes(['admin']);
    // The 'admin' broad scope satisfies admin:X granular (rule 3), but not unrelated like 'read:sessions' (read:X granular).
    // 'admin' DOES satisfy 'admin:profiles' via rule 3 (admin broad → admin:X granular).
    expect(hasScope(ctx, 'admin:profiles')).toBe(true);
    // 'admin' does NOT satisfy 'read:sessions' (no read alias).
    expect(hasScope(ctx, 'read:sessions')).toBe(false);
  });

  // ─── Runtime parity: rule 3 (V-481 broad-satisfies-granular) ─

  it("CRITICAL hasScope rule 3a — read broad satisfies read:X granular. 'read' scope → 'read:sessions' = true.", () => {
    const ctx = ctxWithScopes(['read']);
    expect(hasScope(ctx, 'read:sessions')).toBe(true);
    expect(hasScope(ctx, 'read:profiles')).toBe(true);
  });

  it("CRITICAL hasScope rule 3a — account_owner satisfies read:X granular. 'account_owner' → 'read:sessions' = true (read implied by full account access).", () => {
    const ctx = ctxWithScopes(['account_owner']);
    expect(hasScope(ctx, 'read:sessions')).toBe(true);
  });

  it("CRITICAL hasScope rule 3b — write broad satisfies write:X granular. 'write' scope → 'write:sessions' = true.", () => {
    const ctx = ctxWithScopes(['write']);
    expect(hasScope(ctx, 'write:sessions')).toBe(true);
  });

  it("CRITICAL hasScope rule 3c — account_owner + admin satisfy admin:X granular. 'admin' → 'admin:profiles' = true; 'account_owner' → 'admin:profiles' = true.", () => {
    expect(hasScope(ctxWithScopes(['admin']), 'admin:profiles')).toBe(true);
    expect(hasScope(ctxWithScopes(['account_owner']), 'admin:profiles')).toBe(true);
  });

  // ─── Runtime parity: narrow-keys-stay-narrow ─────────────────

  it("CRITICAL hasScope rule 3 asymmetric — granular does NOT satisfy broad. 'read:sessions' key does NOT pass requireScope('read'). 'Narrow keys stay narrow'.", () => {
    const ctx = ctxWithScopes(['read:sessions']);
    expect(hasScope(ctx, 'read')).toBe(false);
  });

  // ─── Runtime parity: no match ────────────────────────────────

  it("CRITICAL hasScope no-match returns false. A key with 'read' scope does NOT satisfy 'admin' or 'write:sessions'.", () => {
    const ctx = ctxWithScopes(['read']);
    expect(hasScope(ctx, 'admin')).toBe(false);
    expect(hasScope(ctx, 'write:sessions')).toBe(false);
  });

  // ─── Runtime: requireScope throws ForbiddenError ─────────────

  it('CRITICAL requireScope throws ForbiddenError with interpolated message on fail. \'This action requires the "X" scope.\' template.', () => {
    const ctx = ctxWithScopes(['read']);
    expect(() => requireScope(ctx, 'admin')).toThrow(/This action requires the "admin" scope\./);
  });

  it('CRITICAL requireScope is silent (no throw) when hasScope returns true. The void-return-on-success contract.', () => {
    const ctx = ctxWithScopes(['admin']);
    expect(() => requireScope(ctx, 'admin')).not.toThrow();
    expect(() => requireScope(ctx, 'account_owner')).not.toThrow(); // V-174 alias
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/errors-helpers-v174-v481-v485-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
