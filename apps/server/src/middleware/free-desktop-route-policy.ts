// Free is an interactive desktop tier. Its browser-authorized `cli_device`
// credential is still a reusable bearer token, so provenance alone cannot
// prove that a request came from the signed desktop app. Keep that credential
// useful for the current GUI while bounding a copied token to the exact route
// templates the GUI uses.

import { ForbiddenError } from '../lib/errors.js';
import { DEVICE_KEY_DENY_ROUTES } from './device-key-deny.js';

/**
 * Exact `METHOD:template` strings from the current GUI HTTP manifest. These
 * are Fastify route templates (`request.routeOptions.url`), never raw URLs.
 *
 * Five additional GUI mutations (Team invite/remove and BYOK set/clear/test)
 * deliberately stay outside this set because the independent device-key deny
 * gate already forbids them for every device credential.
 */
export const FREE_DESKTOP_ALLOWED_ROUTES: ReadonlySet<string> = new Set<string>([
  // Account, settings, organization, and saved proxies.
  'GET:/v1/account/me',
  'GET:/v1/account/me/notifications',
  'GET:/v1/account/audit-log',
  'GET:/v1/account/cost',
  'GET:/v1/account/me/organization',
  'PUT:/v1/account/me/organization',
  'POST:/v1/account/me/proxies',
  'PUT:/v1/account/me/proxies/:id',
  'DELETE:/v1/account/me/proxies/:id',
  'GET:/v1/account/me/bundled-llm-settings',
  'PATCH:/v1/account/me/bundled-llm-settings',
  'GET:/v1/account/me/bundled-llm-status',
  'GET:/v1/account/me/byok-anthropic-key',

  // Browser profiles.
  'GET:/v1/profiles',
  'POST:/v1/profiles',
  'PATCH:/v1/profiles/:id',
  'DELETE:/v1/profiles/:id',
  'GET:/v1/profiles/trash',
  'POST:/v1/profiles/:id/restore',
  'DELETE:/v1/profiles/:id/purge',
  'POST:/v1/profiles/:id/trim',
  // P-23 — the desktop app's per-profile Activity panel (read-only projection
  // of the account's own session transcripts; scoped by ownership + account).
  'GET:/v1/profiles/:id/activity',
  'GET:/v1/profiles/:id/export',
  'POST:/v1/profiles/:id/clone',
  'POST:/v1/profiles/import',

  // Direct driver sessions.
  'GET:/v1/sessions',
  'POST:/v1/sessions',
  'DELETE:/v1/sessions/:id',

  // AgentChat and Simulator account-bearer fallback.
  'GET:/v1/agent-sessions',
  'POST:/v1/agent-sessions',
  'GET:/v1/agent-sessions/:id',
  'DELETE:/v1/agent-sessions/:id',
  'POST:/v1/agent-sessions/:id/message',
  'POST:/v1/agent-sessions/:id/livekit-token',
  'GET:/v1/agent-sessions/:id/gui-control-key',
  'POST:/v1/agent-sessions/:id/transport-report',
  'GET:/v1/agent-sessions/:id/page-state',
  'GET:/v1/agent-sessions/:id/cookies',
  'POST:/v1/agent-sessions/:id/cookies/set',
  // P-17 — swapping a live session onto one of YOUR OWN stored proxies. The
  // tier check is not here: `resolveForDispatch` refuses a VPN row an
  // unentitled tier still owns, so a free desktop user can move onto their own
  // socks5 exit and no further.
  'POST:/v1/agent-sessions/:id/egress',
  'POST:/v1/agent-sessions/:id/history',
  'POST:/v1/agent-sessions/:id/files',
  'GET:/v1/agent-sessions/:id/downloads',
  'GET:/v1/agent-sessions/:id/downloads/content',
  'POST:/v1/agent-sessions/:id/mode',
  'POST:/v1/agent-sessions/:id/takeover',
  'POST:/v1/agent-sessions/:id/input-event',
  'POST:/v1/agent-sessions/:id/handback',

  // Saved tasks used by AgentChat.
  'GET:/v1/recipes',
  'GET:/v1/recipes/:id',
  'POST:/v1/recipes',

  // Team reads. Device credentials may not invite or remove members.
  'GET:/v1/team/members',
  'GET:/v1/team/invites',

  // Crypto checkout and customer receipt/history surfaces.
  'POST:/v1/billing/crypto-checkout/quote',
  'POST:/v1/billing/crypto-checkout',
  'GET:/v1/billing/crypto-orders',
  'GET:/v1/billing/crypto-orders/:order_id',
  'POST:/v1/billing/crypto-orders/:order_id/cancel',
  'GET:/v1/billing/crypto-orders/:order_id/receipt',
  'GET:/v1/billing/crypto-orders/:order_id/receipt.pdf',
  'GET:/v1/billing/crypto-orders/:order_id/receipt.txt',
]);

const DEVICE_DENIED_DETAIL =
  'This operation is not permitted with a device-provisioned key. Use a dashboard session.';
const FREE_DESKTOP_ROUTE_DETAIL =
  'This Free desktop credential cannot access this API route. Use the Driftstack desktop app or upgrade to an API-enabled tier.';

/** Let the existing global deny-gate remain the primary authority for its routes. */
export function isIndependentDeviceKeyDeniedRoute(
  method: string,
  routeTemplate: string | undefined,
): boolean {
  return routeTemplate !== undefined && DEVICE_KEY_DENY_ROUTES.has(`${method}:${routeTemplate}`);
}

/**
 * Fail closed for a Free `cli_device` request. The caller decides whether the
 * account/provenance combination is in scope; this function only compares the
 * exact authenticated request boundary.
 */
export function requireFreeDesktopRouteAccess(
  method: string,
  routeTemplate: string | undefined,
): void {
  const route = routeTemplate === undefined ? null : `${method}:${routeTemplate}`;

  // Preserve the existing device-key gate's customer-facing denial even when
  // requireAuth is invoked lazily from that global preHandler. The separate
  // global gate remains authoritative for paid device credentials too.
  if (isIndependentDeviceKeyDeniedRoute(method, routeTemplate)) {
    throw new ForbiddenError(DEVICE_DENIED_DETAIL);
  }
  if (route === null || !FREE_DESKTOP_ALLOWED_ROUTES.has(route)) {
    throw new ForbiddenError(FREE_DESKTOP_ROUTE_DETAIL);
  }
}
