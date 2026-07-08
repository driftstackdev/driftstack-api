// C1 — device-key deny-gate.
//
// A key minted by the CLI/GUI device-code (cli-authorize) flow carries
// `provenance === 'cli_device'` (see db/schema.ts). Such a key still
// holds `account_owner` so the live desktop client keeps working
// (it drives sessions, profiles, crypto-checkout, and edits its own
// account settings), but a PHISHED device key must not be able to take
// over or drain the account. This central preHandler bars device keys
// from the account-takeover / persistence / exfiltration operations.
//
// Why a route-TEMPLATE hook and not a requireScope wrapper: the sharpest
// vectors are `requireAuth`-only routes that enforce `account_owner`
// *inside the service*, so a requireScope preHandler never fires on them
// — customer API-key mint/rotate/revoke (routes/admin.ts) and every
// webhook WRITE (routes/webhooks.ts). Webhook creation is the decisive
// one: a device key could stand up an attacker webhook endpoint that
// keeps delivering the victim's event stream even AFTER the 'Desktop
// client' key is revoked (revocation-surviving exfil). Keying on the
// matched Fastify route template covers every route uniformly regardless
// of how it authenticates, with a single global registration and zero
// per-route edits.
//
// The deny-set is DISJOINT from the gui-client's device-need routes
// (agent-sessions/profiles/crypto-checkout/account-settings/etc.); the
// coverage-invariant test pins both that every template resolves to a
// registered route (a typo'd template silently fails OPEN) and that the
// set never overlaps a known device-need route.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../lib/errors.js';

/**
 * Exact `METHOD:template` strings (Fastify `request.routeOptions.url`,
 * i.e. the registered path WITH its `:param` placeholders). Frozen so a
 * stray push can't widen it at runtime.
 */
export const DEVICE_KEY_DENY_ROUTES: ReadonlySet<string> = new Set<string>([
  // API-key lifecycle — minting a fresh key is the persistence vector;
  // revoking/rotating lets a phished key lock the owner out.
  'POST:/v1/api-keys',
  'DELETE:/v1/api-keys/:id',
  'POST:/v1/api-keys/:id/rotate',
  // The device-authorize bind itself — belt-and-suspenders with the
  // web-session-only guard in routes/auth-cli.ts (no key-authed bind).
  'POST:/v1/auth/cli-authorize/bind',
  // MFA — a device key must not enroll/disable/regenerate the human
  // second factor or its recovery codes.
  'POST:/v1/account/mfa/enroll',
  'POST:/v1/account/mfa/verify',
  'DELETE:/v1/account/mfa',
  'POST:/v1/account/mfa/disable',
  'POST:/v1/account/mfa/recovery-codes/regenerate',
  // Team — inviting a member or removing one is an account-takeover /
  // lockout move.
  'POST:/v1/team/invites',
  'DELETE:/v1/team/members/:id',
  // Stripe billing — starting a checkout / opening the billing portal
  // are subscription-change actions.
  'POST:/v1/billing/checkout-session',
  'POST:/v1/billing/portal-session',
  'GET:/v1/account/me/billing-portal',
  // Webhook WRITES — the revocation-surviving exfil vector (decisive).
  'POST:/v1/webhooks',
  'PATCH:/v1/webhooks/:id',
  'DELETE:/v1/webhooks/:id',
  'POST:/v1/webhooks/:id/rotate-secret',
  'POST:/v1/webhook-deliveries/:deliveryId/replay',
  // BYOK — writing/removing/testing the account's Anthropic key.
  'PUT:/v1/account/me/byok-anthropic-key',
  'DELETE:/v1/account/me/byok-anthropic-key',
  'POST:/v1/account/me/byok-anthropic-key/test',
  // Web-session nuke — a device key must not sign the human out
  // everywhere (a lockout / cover-tracks move).
  'DELETE:/v1/account/web-sessions',
  'DELETE:/v1/account/web-sessions/:id',
]);

/**
 * Register the deny-gate as a single global preHandler. It fires only on
 * the deny-set routes; every other route hits the early return and is
 * untouched (public routes are never force-authed).
 */
export function registerDeviceKeyDenyGate(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.routeOptions?.url;
    if (url === undefined) return; // 404 / unrouted — nothing to gate.
    if (!DEVICE_KEY_DENY_ROUTES.has(`${request.method}:${url}`)) return;

    // A global preHandler runs BEFORE the route's own requireAuth, so
    // request.account is usually still null here. Lazy-auth so the gate
    // can read the caller's provenance (idempotent — the route's
    // requireAuth re-runs on a warm cache hit).
    //
    // The gate is purely ADDITIVE: it only ever adds a 403 for a
    // positively-identified device key. If auth fails here — an absent /
    // bad token, or a feature-disabled STUB route that carries no
    // requireAuth of its own (e.g. billing-disabled → 503) — swallow it
    // and defer to the route: an authed route re-runs requireAuth and
    // returns its own 401, a stub returns its 503. The caller isn't
    // authenticated, so it cannot be a device key, and the gate never
    // needs to be the primary authenticator.
    if (request.account === null) {
      try {
        await app.requireAuth(request, reply);
      } catch {
        return;
      }
    }
    if (request.account?.apiKey.provenance === 'cli_device') {
      throw new ForbiddenError(
        'This operation is not permitted with a device-provisioned key. Use a dashboard session.',
      );
    }
  });
}
