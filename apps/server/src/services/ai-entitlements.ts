// S12 — what a MOVED account's plan says about AI, and the customer copy that
// goes with each refusal (§4.3 rule 1 and 6, M11).
//
// ⛔ THE ENTITLEMENT TABLE ITSELF LIVES IN `@driftstack/api-types`
// (`AI_PLAN_ENTITLEMENTS` / `aiEntitlementFor`), not here. It is shared with
// the SDKs and with `packages/api-types/tests`, and duplicating it here would
// be a second table this codebase could disagree with itself about. This file
// is the SERVER-ONLY half: the sentences a customer reads, which — unlike the
// entitlement table — are not the SDKs' concern and must never repeat a
// vendor's name beyond the model's own product label the app already shows
// (see the repo-wide customer-copy rule).
//
// ⛔ WHY A MODEL REFUSAL ON CREDITS IS NOT `deploymentKeyModelRefusalFor`
// (services/bundled-llm.ts). That helper's copy always says "add your key" —
// right for a plan that allows one, false for Personal, which credits pushed
// into having AI for the first time and which may never add a key (H3's
// cutover row: a stored key is kept but never read). M11 gives Personal its
// own sentence that names no fix a 403 would only refuse a second time.

import {
  agentModelListPrice,
  aiEntitlementFor,
  CLAUDE_MODELS,
  DEFAULT_AGENT_MODEL,
  deploymentKeyModelRefusal,
  type AccountTier,
  type AiPlanEntitlement,
  type DeploymentKeyModelRefusal,
} from '@driftstack/api-types';

export type { AiPlanEntitlement };
export { aiEntitlementFor };

/** Why a moved account's turn may not use `model` on credits, and the
 *  sentence for it — or null when the model may run. Mirrors
 *  `deploymentKeyModelRefusalFor`'s shape so callers can treat the two
 *  refusals identically once they have picked the right one. */
export interface CreditsModelRefusal {
  readonly reason: DeploymentKeyModelRefusal;
  readonly detail: string;
}

/**
 * §9.6's copy table for a 403 `forbidden` `reason: 'own_key_only' | 'unpriced'`
 * on a CREDITS-funded turn (create-time and every turn, §4.3 rule 6).
 *
 * `ownKeyAllowed` is the plan's, not the account's chosen source — a moved
 * account on credits can still be on a plan that allows a key (Team, Agency,
 * a Builder/Scale account with no key on file), and that plan gets the
 * "add your key" sentence; Personal never does.
 */
export function creditsModelRefusalFor(
  model: string,
  ownKeyAllowed: boolean,
): CreditsModelRefusal | null {
  const reason = deploymentKeyModelRefusal(model);
  if (reason === null) return null;
  const modelLabel = agentModelListPrice(model)?.label ?? 'This model';
  const alternative = CLAUDE_MODELS[DEFAULT_AGENT_MODEL].label;
  if (reason === 'unpriced') {
    // Same sentence on every plan: an unpriced model is Driftstack's
    // configuration gap, never the customer's, and an own key would not
    // help either — the registry has no price to meter it by.
    return { reason, detail: `${modelLabel} isn’t available right now. Choose ${alternative}.` };
  }
  if (!ownKeyAllowed) {
    return {
      reason,
      detail: `${modelLabel} isn’t included in your plan. Choose ${alternative}.`,
    };
  }
  return {
    reason,
    detail: `${modelLabel} runs only with your own key. Add your key in Settings, or choose ${alternative}.`,
  };
}

/** Rule 1's refusal: the plan has no AI at all, on any source. */
export function aiNotOnPlanDetail(tier: AccountTier): string {
  return `AI isn’t included on this account’s current plan (${tier}).`;
}

/** Rule 2's refusal: a header key was sent, but the plan runs AI on credits
 *  only and never on a customer-supplied key. */
export const OWN_KEY_NOT_ON_PLAN_DETAIL =
  'This plan runs AI on included credits only; it cannot use your own API key.';

/** Whether `tier`'s plan may ever spend AI credits at all. A thin, named
 *  wrapper so a call site reads as the question it is asking. */
export function aiIncludedForTier(tier: AccountTier): boolean {
  return aiEntitlementFor(tier).aiIncluded;
}

/** Whether `tier`'s plan may run AI on the customer's own provider key. */
export function ownKeyAllowedForTier(tier: AccountTier): boolean {
  return aiEntitlementFor(tier).ownKeyAllowed;
}
