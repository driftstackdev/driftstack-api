// V-1263 — which subscription statuses count as BILLED, in one place.
//
// This set decides whether a subscription is charging money, and three modules need it: the
// admin-billing aggregate that reports paying customers per tier, and two places in the Stripe
// webhook handler that decide which subscriptions a customer currently holds.
//
// It lived in `admin-billing-repo.ts`, exported (V-1238) so that repo's in-memory double could
// stop keeping a copy. But `stripe-webhooks-repo.ts` wrote `['active', 'trialing']` inline TWICE
// and its double restated it TWICE, so the same decision existed in four places across three
// files. The fix could not be "import it from admin-billing", because a Stripe webhook handler
// reaching into the admin cockpit's repo for a billing rule makes that repo the accidental owner
// of something it does not own.
//
// So the set lives here instead: a module named for what it holds, that both repos and both
// doubles import, and that owns nothing else. Stripe grants `past_due` a retry window in which
// the subscription is still charged, so a third member here is a plausible edit rather than a
// hypothetical one — which is the whole reason it must have a single home.

/** Subscription statuses Stripe actively bills — the "paying" set. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

/**
 * Statuses Stripe is still COLLECTING on — the paying set plus its retry window.
 *
 * V-1288 — the paragraph above calls a third member "a plausible edit rather than a hypothetical
 * one". It was neither: `billing-repo.ts` already had it, spelled inline as
 * `['active', 'trialing', 'past_due']`, with its double restating the same three as a `!==` chain.
 * Neither site was reachable by the sweep that gave the paying set one home, because the pairing
 * every guard uses resolves `in-memory-<X>.ts` against `src/db/<X>.ts` and the billing double is
 * called `in-memory-billing.ts` — deliberately, since it exports two classes.
 *
 * Derived from the paying set rather than listed, so a status added there extends this too and the
 * relationship between them stays a fact rather than a coincidence.
 */
export const COLLECTING_SUBSCRIPTION_STATUSES = [
  ...ACTIVE_SUBSCRIPTION_STATUSES,
  'past_due',
] as const;
