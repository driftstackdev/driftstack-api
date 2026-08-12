// Helpers that need the AccountContext type but live next to errors.ts so
// services can import without pulling the auth service.

import {
  parseGranularScope,
  TIER_FEATURES,
  type AccountTier,
  type ApiKeyScope,
  type TierBooleanFeature,
} from '@driftstack/api-types';
import type { AccountContext } from '../services/auth.js';
import { ForbiddenError, NotFoundError } from './errors.js';

/**
 * V-174 + V-481 — scope check with backwards-compat aliases.
 *
 *   1. Exact match — the key carries the required scope verbatim.
 *   2. V-174 legacy customer alias — `'admin'`-scoped keys satisfy
 *      `'account_owner'` so pre-split customer automation keeps its own-account
 *      authority. The expired migration bridge to
 *      `'driftstack_internal_admin'` is deliberately closed: only the exact
 *      staff scope can authorize cross-account operations.
 *   3. V-481 broad-satisfies-granular — when the required scope is
 *      granular (`read:sessions`, `admin:profiles`, etc.), the key's
 *      broad scopes can satisfy it on the same verb:
 *      - required `read:X` is satisfied by any of `read`,
 *        `account_owner` (read implied by full account access).
 *      - required `write:X` is satisfied by `write`, `account_owner`.
 *      - required `admin:X` is satisfied by `account_owner`, `admin`.
 *      Granular scopes do NOT satisfy broad checks — a key with
 *      `read:sessions` cannot pass `requireScope('read')`. That's
 *      the point of granular scoping; narrow keys stay narrow.
 *
 * Mirrored in `services/auth.ts::requireScope` (kept in sync — same
 * predicate evaluated at both call sites).
 */
export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (hasScope(ctx, required)) return;
  throw new ForbiddenError(`This action requires the "${required}" scope.`);
}

/**
 * V-481 — pure predicate version of {@link requireScope}. Returns
 * true iff the key satisfies the required scope (exact, V-174 legacy
 * customer alias, or V-481 broad-satisfies-granular).
 */
export function hasScope(ctx: AccountContext, required: ApiKeyScope): boolean {
  return scopesSatisfy(ctx.apiKey.scopes, required);
}

/**
 * Pure scope-set predicate for authorization flows that do not carry a full
 * AccountContext (for example OAuth consent scope reduction). This is the
 * canonical hierarchy: exact match, legacy customer alias, account_owner broad
 * verbs, then broad-satisfies-granular on the same verb.
 */
export function scopesSatisfy(scopes: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  if (scopes.includes(required)) return true;

  // V-174 legacy customer alias. Never satisfies the staff-only scope.
  if (required === 'account_owner' && scopes.includes('admin')) {
    return true;
  }

  // account_owner (full customer-account control) satisfies the BARE `read`/
  // `write` verbs — mirrors requireScope in services/auth.ts. Without this an
  // account_owner-only key (the desktop device-login key) failed a bare
  // requireScope('write'). account_owner does NOT satisfy the bare admin /
  // driftstack_internal_admin staff gates.
  if ((required === 'read' || required === 'write') && scopes.includes('account_owner')) {
    return true;
  }

  // V-481 broad satisfies granular on the same verb.
  const granular = parseGranularScope(required);
  if (granular === null) return false;
  switch (granular.verb) {
    case 'read':
      return scopes.includes('read') || scopes.includes('account_owner');
    case 'write':
      return scopes.includes('write') || scopes.includes('account_owner');
    case 'admin':
      return scopes.includes('admin') || scopes.includes('account_owner');
    default: {
      const _exhaustive: never = granular.verb;
      return _exhaustive;
    }
  }
}

/**
 * V-485 — per-tier feature guard. Throws `ForbiddenError` when the
 * given tier does NOT have the requested boolean feature enabled.
 *
 * Use this in route handlers gating tier-restricted endpoints (e.g.
 * AI-agent endpoints land in V-487+). The single guard call replaces
 * `if (tier === 'X' || tier === 'Y') throw …` style scattered
 * conditionals — when a tier's feature row in
 * `packages/api-types/src/common.ts:TIER_FEATURES` flips, every
 * call site picks it up automatically.
 *
 * Today's matrix: `apiAccess`, `aiAgent` and `vpnEgress` are gated this
 * way — every boolean field on `TierFeatures`. (This comment previously
 * said "only `aiAgent`", which had gone stale: `apiAccess` was already
 * gated, and `vpnEgress` was published as a paid-tier difference while
 * nothing enforced it.) `every-boolean-tier-feature-is-enforced.test.ts`
 * now fails if a new boolean feature is added without a gate. Future
 * features extend `TierFeatures` and pass through the same guard.
 */
export function requireTierFeature(tier: AccountTier, feature: TierBooleanFeature): void {
  if (TIER_FEATURES[tier][feature]) return;
  throw new ForbiddenError(
    `The "${feature}" feature is not available on the "${tier}" tier. ` +
      `Upgrade to a tier that includes this feature.`,
  );
}

/**
 * S42 2026-07-07 (founder-approved) — bundled-LLM billing tier gate.
 *
 * `llmBilling` is the one non-boolean feature in TIER_FEATURES, so it
 * can't ride {@link requireTierFeature}. Bundled billing (Driftstack
 * pays Anthropic, customer pays Driftstack) is only offered on the
 * tiers whose `llmBilling` is `byok_or_bundled` / `byok_or_bundled_custom`
 * — api_builder, api_scale, enterprise. Every other aiAgent tier is
 * BYOK-only: the byok-anthropic settings routes stay ungated.
 * Error shape mirrors requireTierFeature (403 ForbiddenError).
 */
export function requireBundledLlmTier(tier: AccountTier): void {
  const llmBilling = TIER_FEATURES[tier].llmBilling;
  if (llmBilling === 'byok_or_bundled' || llmBilling === 'byok_or_bundled_custom') return;
  throw new ForbiddenError(
    `Bundled-LLM billing is not available on the "${tier}" tier. ` +
      `Upgrade to a tier that includes this feature.`,
  );
}

export { NotFoundError };
