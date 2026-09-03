// The cross-device half of "Get set up" being first-time-only (owner item T-13).
//
// The first half made completion durable ON THIS MACHINE: the checklist marks
// ds_onboarding_completed in localStorage the first time it sees every step
// done, and both surfaces gate on it. That flag never leaves the install, so a
// customer who finished on one Mac and installs on a second one was greeted as
// a first-time customer again — the account had already set up, only this
// machine did not know.
//
// Two small pieces close that gap, both keyed on the account rather than the
// machine:
//   • MIRROR — the first local completion also tells the account
//     (PATCH /v1/account/me {onboarding_completed:true}). Fire-and-forget: a
//     failure never blocks the UI, and the next completion event retries.
//   • SEED — when /me lands carrying onboarding_completed_at, the local flag is
//     set from it, so a fresh install of a finished customer never shows the
//     card. The account value only ever ADDS completion; it never removes a
//     dismissal or completion this machine already recorded.
//
// ⚠️ A SEPARATE MODULE ON PURPOSE (the N-1 pattern in agent-session-unload.ts).
// use-onboarding-steps.ts and SettingsContext are replaced by hand-listed mock
// factories in several suites, so the transport is reached through a dynamic
// import inside the one function that needs it and nothing new is exported
// from those modules.

/** The /me field this half reads. It is read at runtime rather than typed on
 *  the SDK's AccountSelfProfile: that type lives in another package, and the
 *  SDK's account.me() casts the JSON without validation, so a consumer that
 *  trusted the type would still be trusting the wire. A server that predates
 *  the field simply reads as "not completed on the account". */
export function readOnboardingCompletedAt(account: object | null | undefined): string | null {
  // `in` throws on a primitive; the typed contract is `object`, but the value
  // arrives from a cast JSON body (and from hand-built test doubles).
  if (account === null || typeof account !== 'object') return null;
  if (!('onboarding_completed_at' in account)) return null;
  const value: unknown = account.onboarding_completed_at;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** True when the account says this customer finished onboarding somewhere. */
export function accountSaysOnboardingCompleted(account: object | null | undefined): boolean {
  return readOnboardingCompletedAt(account) !== null;
}

/**
 * Mirror a local completion to the account.
 *
 * Best-effort by design: the card is already hidden locally, so nothing waits
 * on this. The request goes through the bearer path of the session-control
 * transport (account key from the store, no workspace header — completion is
 * a fact about the CALLING account). Any failure — offline, an older server
 * that does not know the field, a revoked key — is swallowed; the next
 * completion event sends it again.
 */
export function syncOnboardingCompletedToAccount(): void {
  void import('./agent-session-control')
    .then(({ authedResponse }) =>
      authedResponse(
        '/v1/account/me',
        { method: 'PATCH', body: JSON.stringify({ onboarding_completed: true }) },
        null,
        8_000,
      ),
    )
    .catch(() => undefined);
}
