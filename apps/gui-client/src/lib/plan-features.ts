// The account's plan, read from `TIER_FEATURES` — the same table the server
// enforces from. Kept in its own module (2026-09-24) so a view can ask it while
// RENDERING: the profile card and the list now show a VPN row's "not on plan"
// state, and a dozen view suites stub `lib/account-proxies` wholesale, which
// would make a render-time call into that module throw. `account-proxies`
// re-exports both, so every existing import still resolves.

import { TIER_FEATURES, type AccountTier } from '@driftstack/api-types';

/**
 * Whether this account's plan carries no VPN egress — so no check of a VPN row
 * can run, and no VPN credential may be uploaded to be refused.
 *
 * ⛔ (2026-09-17 review) IT READS THE FEATURE, NOT THE TIER NAME. This shipped as
 * `accountMe?.tier === 'free'` in ProxiesView, which re-derives by hand a matrix
 * the repo already publishes and the server itself enforces from
 * (`requireTierFeature(tier, 'vpnEgress')`). `free` is merely the only tier whose
 * `vpnEgress` is false TODAY — and the failure mode of guessing is the expensive
 * direction: a future tier without VPN egress would silently upload the
 * customer's OpenVPN config or WireGuard private key to be refused on arrival.
 * This is the same defect the display-window work was written to remove — a
 * hand-typed value that cannot follow the number it depends on.
 *
 * ⚠️ AN UNKNOWN OR ABSENT TIER IS NOT EXCLUDED. `null` is "still loading, or no
 * API key", and a tier this build has never heard of is a NEWER server: refusing
 * on either would quietly stop checking VPN rows for a paying customer during
 * every /me round trip, and the server's own refusal is the honest backstop.
 * Optional chaining, not `!== null`: a view double (and every suite that
 * hand-mocks the settings context) hands over an object with no `tier` key at
 * all, and `undefined !== null` is TRUE.
 */
export function planExcludesVpnEgress(account: { tier?: AccountTier | null } | null): boolean {
  const tier = account?.tier;
  if (tier === undefined || tier === null) return false;
  return TIER_FEATURES[tier]?.vpnEgress === false;
}

/** Follow-up A (2026-09-24) — the account's plan has no API access, so the full
 *  check through Driftstack (`POST …/proxies/:id/test`) is never run for it: a
 *  Free account's desktop key is refused by the free-desktop route policy, and a
 *  pasted key on a Free account is refused too. An ACCOUNT fact, read from the
 *  same `TIER_FEATURES` table the server enforces from (never a hand-typed tier
 *  name), so a reload of the Proxies tab can say the plan reason before any Test
 *  has been refused in this mount. Unknown / not-yet-loaded → false: a caller
 *  that does not know promises nothing about the plan. */
export function planExcludesFleetTest(account: { tier?: AccountTier | null } | null): boolean {
  const tier = account?.tier;
  if (tier === undefined || tier === null) return false;
  return TIER_FEATURES[tier]?.apiAccess === false;
}
