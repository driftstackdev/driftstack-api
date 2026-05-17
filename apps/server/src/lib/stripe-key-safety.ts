// Q.2 (orchestrator handoff #3) — fail-fast safety check that
// prevents a live-mode Stripe key from running before the BV KvK
// closure on 2026-05-21. If the operator accidentally drops a
// sk_live_ key into the prod env before the company entity is
// registered, the server refuses to boot rather than letting it
// silently start charging real cards.
//
// The check intentionally lives outside BillingService so it fires
// during bootstrap regardless of whether billingService is fully
// wired — even a partial Stripe config (sk_live_ + nothing else)
// trips it before any HTTP routes register.
//
// Cutover: on 2026-05-21 a follow-up commit relaxes this guard;
// once the founder has the entity in place + share the live keys,
// the bootstrap check passes any sk_ prefix.

/**
 * Cutover date after which sk_live_ keys are permitted. Inclusive:
 * on 2026-05-21 a sk_live_ key is allowed. Before that date, only
 * sk_test_ (or absent / undefined) is acceptable.
 *
 * Encoded as a UTC midnight timestamp so the check is timezone-stable
 * — the host running the safety check could be in any TZ.
 */
export const STRIPE_LIVE_KEY_CUTOVER_UTC = Date.UTC(2026, 4, 21); // 2026-05-21

export interface StripeKeySafetyArgs {
  /** The STRIPE_SECRET_KEY value as configured. May be undefined. */
  secretKey: string | undefined;
  /** Wall-clock injected so tests can pin a known date. Defaults to Date.now(). */
  now?: Date;
}

export type StripeKeySafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate the Stripe secret key against the launch-safety cutover.
 * Returns ok=false when:
 *   - the key starts with sk_live_, AND
 *   - the current wall-clock is BEFORE the cutover date
 *
 * All other combinations pass:
 *   - undefined key (billing routes register as 503 stubs anyway)
 *   - sk_test_ key (always acceptable, regardless of date)
 *   - any sk_* key after the cutover
 *
 * Caller is responsible for failing the bootstrap when ok=false —
 * the reason string is the operator-facing error message.
 */
export function validateStripeKeyForLaunch(args: StripeKeySafetyArgs): StripeKeySafetyResult {
  const { secretKey } = args;
  if (secretKey === undefined || secretKey === '') {
    return { ok: true };
  }
  if (!secretKey.startsWith('sk_live_')) {
    return { ok: true };
  }
  const now = (args.now ?? new Date()).getTime();
  if (now >= STRIPE_LIVE_KEY_CUTOVER_UTC) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'STRIPE_SECRET_KEY is sk_live_ but the BV KvK launch cutover ' +
      '(2026-05-21 UTC) has not been reached. Refusing to boot with a ' +
      'live-mode key before the entity is in place. Either switch to a ' +
      'sk_test_ key or wait for the cutover.',
  };
}
