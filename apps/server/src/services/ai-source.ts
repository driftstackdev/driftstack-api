// S12 — which AI source funds ONE turn for a MOVED account (`billing_mode =
// 'credits'`), per the plan's §4.3.
//
// ⛔ PURE, on purpose. Every fact this needs — the plan's entitlement, the
// account's `ai_source`, whether a header key was sent, whether a usable
// stored key exists — is read by the caller first. This function only
// arbitrates between them, so the six rules can be tested without a database,
// a request or a clock, and so the ROUTE stays the one place that decides how
// each fact is fetched (and how each refusal becomes a typed HTTP answer).
//
// ⛔ LEGACY ACCOUNTS NEVER REACH THIS. `billing_mode = 'legacy'` keeps the
// bundled leg exactly as it always ran; this module exists only for accounts
// the cutover (S16) has explicitly moved.
//
// The six rules, in the order §4.3 states them — and the order IS the answer:
// an account that cannot use AI at all is told that before anything about a
// key; a Personal account with a header key is told its plan forbids a key
// before anything about credits.
//
//   1. `!entitlement.aiIncluded` (Free) → refused, even for an own-key request.
//   2. A header key is present:
//        · plan allows an own key → use it (an explicit per-request choice);
//        · Personal → refused, own key not on the plan.
//   3. `ai_source === 'own_key'` → the stored key, if it is usable. NEVER
//      falls back to credits — that is the one thing this source promises.
//   4. `ai_source === null` (automatic) → a usable stored key if the plan
//      allows one, else credits. This reproduces the fallback a legacy
//      account already consented to (H3's cutover mapping).
//   5. `ai_source === 'credits'`, or automatic with no usable key → credits.
//
// Rule 6 (refusing an Opus-class or unpriced model on credits) is NOT decided
// here: `reserve()` asks the rate card the same question inside its own
// transaction (§4.4 step 4), and the route builds that refusal from what
// `reserve()` answers. Deciding it twice, once here from a stale entitlement
// read and once again in the database, is exactly the kind of drift H3 warns
// about for `ai_source`.

import type { AiPlanEntitlement } from '@driftstack/api-types';

/** The plan-entitlement fields this module reads. A `Pick` rather than the
 *  whole `AiPlanEntitlement`, so a caller can pass the full row from
 *  `aiEntitlementFor` unchanged. */
export type AiSourceEntitlement = Pick<AiPlanEntitlement, 'aiIncluded' | 'ownKeyAllowed'>;

export interface DecideAiSourceInput {
  readonly entitlement: AiSourceEntitlement;
  /** `credit_accounts.ai_source`. Null means automatic (rule 4). */
  readonly aiSource: 'credits' | 'own_key' | null;
  /** A key was sent on THIS request (`x-byok-anthropic-api-key`). */
  readonly headerKeyPresent: boolean;
  /** A stored key exists AND is still usable (not expired, not cleared) —
   *  the same predicate `byokService.getPlaintext` already applies. */
  readonly storedKeyUsable: boolean;
}

/** Which source funds the turn, once a refusal has been ruled out. */
export type AiSourceChoice =
  /** The header key sent with this request (rule 2). */
  | { readonly kind: 'header_key' }
  /** The stored key, resolved because it is usable (rules 3 and 4). */
  | { readonly kind: 'stored_key' }
  /** Driftstack's AI, funded from the account's credits (rules 4 and 5). */
  | { readonly kind: 'credits' };

/** Why a turn may not run at all, before any key or reservation is touched. */
export type AiSourceRefusal =
  /** Rule 1 — the plan includes no AI, on any source. */
  | { readonly kind: 'ai_not_on_plan' }
  /** Rule 2 — a header key was sent, but the plan runs AI on credits only. */
  | { readonly kind: 'own_key_not_on_plan' }
  /** Rule 3 — `ai_source = 'own_key'` and the stored key is missing or
   *  expired. NEVER falls back to credits: that is the source's promise. */
  | { readonly kind: 'own_key_missing' };

export type AiSourceDecision =
  | ({ readonly outcome: 'use' } & AiSourceChoice)
  | ({ readonly outcome: 'refuse' } & AiSourceRefusal);

/** §4.3's six rules (five decided here; the sixth is the reservation's). */
export function decideAiSource(input: DecideAiSourceInput): AiSourceDecision {
  // Rule 1 — applies even to an own-key request: a plan with no AI has none
  // on any source, so a header key changes nothing.
  if (!input.entitlement.aiIncluded) {
    return { outcome: 'refuse', kind: 'ai_not_on_plan' };
  }

  // Rule 2 — a header key is an explicit, per-request choice. Honoured only
  // where the plan allows an own key at all.
  if (input.headerKeyPresent) {
    return input.entitlement.ownKeyAllowed
      ? { outcome: 'use', kind: 'header_key' }
      : { outcome: 'refuse', kind: 'own_key_not_on_plan' };
  }

  // Rule 3 — an explicit choice of the customer's own key. Never falls back.
  if (input.aiSource === 'own_key') {
    return input.storedKeyUsable
      ? { outcome: 'use', kind: 'stored_key' }
      : { outcome: 'refuse', kind: 'own_key_missing' };
  }

  // Rule 4 — automatic: reproduces the fallback a legacy account consented
  // to. A plan that forbids an own key never reaches for the stored one here
  // either, even if one happens to be on file (H3's Personal row: a stored
  // key is kept but never read).
  if (input.aiSource === null) {
    return input.entitlement.ownKeyAllowed && input.storedKeyUsable
      ? { outcome: 'use', kind: 'stored_key' }
      : { outcome: 'use', kind: 'credits' };
  }

  // Rule 5 — `ai_source === 'credits'`, the only case left.
  return { outcome: 'use', kind: 'credits' };
}
