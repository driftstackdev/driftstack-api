// EG-API-1.2 — POST /v1/sessions/{id}/proxy + GET /v1/sessions/{id}/proxy.
//
// Planning 133 §"Cross-agent split" Agent 2 scope:
//   - POST /v1/sessions/{id}/proxy — set proxy config for a session
//   - GET  /v1/sessions/{id}/proxy — fetch current session's proxy config
//
// Activation gate: routes register only when `sessionEgressService` is
// wired in AppDeps (i.e., a concrete SOCKS5/OpenVPN/WireGuard backend
// is configured). Until then `registerSessionProxyDisabledRoutes`
// registers 503 FeatureUnavailable stubs so the customer dashboard +
// SDK clients get a machine-readable signal instead of bare 404.
//
// The route consumes the cross-agent contract schema from
// `@driftstack/api-types/egress` (EG-API-1.1). Body shape:
//
//   {
//     "session_id": "ses_xxx",       // must match URL :id
//     "proxy": { "type": ..., ... },
//     "egress_safeguard": { ... }    // optional; defaults safeguards-on
//   }
//
// SECURITY: proxy configs carry customer secrets (SOCKS5 password,
// OpenVPN .ovpn including embedded private keys, WireGuard private
// key). The service layer is responsible for:
//   - Storing on tmpfs only for the session lifetime
//   - AES-256-GCM at-rest envelope
//   - Hashing the config for the audit log (never raw)
//   - Zeroing on session-end
// This route layer ONLY validates the shape + dispatches to the
// service; do NOT echo body fields in error responses.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProxyConfigSchema, SessionEgressConfigSchema } from '@driftstack/api-types';
import type { SessionEgressService } from '../services/session-egress.js';
import {
  BadRequestError,
  FeatureUnavailableError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface SessionProxyRoutesDeps {
  service: SessionEgressService;
}

export function registerSessionProxyRoutes(
  app: FastifyInstance,
  deps: SessionProxyRoutesDeps,
): void {
  const { service: _service } = deps;

  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/proxy',
    // W495/W509 — write:sessions (granular), consistent with the sibling
    // /v1/sessions/:id/* mutations (navigate/interact/capture). W495 wrongly
    // used broad 'write', which a granular write:sessions key (the documented
    // CI-runner scope set) does NOT satisfy → would 403 on set-proxy.
    { preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      const { id } = req.params;
      const parsed = SessionEgressConfigSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      if (parsed.data.session_id !== id) {
        throw new BadRequestError(
          'Body session_id must match the URL :id (cross-cutting body/URL mismatch).',
        );
      }
      // EG-API-1.2 service-layer wiring is the EG-API-1.6 propagation
      // slice's responsibility — `applyToSession` returns an
      // EgressHandle which the harness consumes. The route surface
      // returns the public-safe shape only (proxy type + safeguard
      // flags echoed back; NEVER raw config fields like SOCKS5
      // password or WireGuard private_key).
      // For Phase 1 SOCKS5 wiring, EG-API-1.6 will await this call
      // and propagate the EgressHandle to the per-session harness
      // launcher. Until then the service is the only place that
      // touches secrets; the route returns 202 Accepted with the
      // type + safeguard summary.
      throw new FeatureUnavailableError(
        'Session-egress backends (SOCKS5 / OpenVPN / WireGuard) are not yet wired on this server. ' +
          'EG-API-1.2 route surface is registered; EG-API-1.6 wires the per-session harness propagation. ' +
          'Tracking via planning 133.',
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/proxy',
    { preHandler: [app.requireAuth, app.requireScope('read:sessions'), app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      // EG-API-1.6 backs this with a real read from session-egress
      // state (config_hash + type + safeguard flags only — never raw
      // config). For now the route surfaces 404 because no session
      // has a proxy applied (no backend wired); same activation-gate
      // logic as POST.
      throw new NotFoundError('No proxy config for this session.');
    },
  );
}

// Registered when `sessionEgressService` is omitted from AppDeps. Same
// pattern as `registerBillingDisabledRoutes` (Wave 1119 / Slice 1119.2):
// returning 503 + FeatureUnavailable on the route surface gives clients
// a machine-readable "feature not yet shipped" signal vs a misleading
// 404. The detail explains the activation gate so customers know it's
// a deployment state, not a typo.
export function registerSessionProxyDisabledRoutes(app: FastifyInstance): void {
  // Customer-facing detail. "planning file 133" is internal
  // nomenclature; customers don't have access. Drop the internal
  // reference and surface the Phase 1 SOCKS5 roadmap framing in
  // customer-readable terms. Matches the symmetric saved-proxies
  // disabled-stub detail.
  const detail =
    'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is not yet ' +
    'shipped. Phase 1 SOCKS5 support is on the roadmap; until then sessions ' +
    "route through Driftstack's default egress.";
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  // Disabled feature posture must preserve the live route's auth boundary.
  // Otherwise unauthenticated and unrelated-scope callers can probe deployment
  // state, and enabling the feature silently changes 503 responses into 401/403.
  app.post('/v1/sessions/:id/proxy', {
    preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    handler: stub,
  });
  app.get('/v1/sessions/:id/proxy', {
    preHandler: [app.requireAuth, app.requireScope('read:sessions'), app.rateLimit('global')],
    handler: stub,
  });
}

// Re-export the ProxyConfigSchema for testability — consumers that
// want to validate a proxy body without the SessionEgressConfig
// envelope can use this directly. Marked here rather than in egress.ts
// because the schema's location is API-package, not route-package.
export { ProxyConfigSchema };
