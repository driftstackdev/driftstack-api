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
