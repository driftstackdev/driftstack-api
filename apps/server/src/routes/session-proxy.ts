// EG-API-1.2 — POST /v1/sessions/{id}/proxy + GET /v1/sessions/{id}/proxy.
//
// Planning 133 §"Cross-agent split" Agent 2 scope:
//   - POST /v1/sessions/{id}/proxy — set proxy config for a session
//   - GET  /v1/sessions/{id}/proxy — fetch current session's proxy config
//
// Activation gate: routes register only when `sessionEgressService` is
// wired in AppDeps (i.e., a concrete SOCKS5/OpenVPN/WireGuard backend
// is configured). Otherwise `registerSessionProxyDisabledRoutes`
// registers 503 FeatureUnavailable stubs so the customer dashboard +
// SDK clients get a machine-readable signal instead of bare 404.
//
// V-823 — READ THIS BEFORE DEBUGGING A 503 HERE. Both registrars are
// stubs today. `bootstrap.ts` constructs `new SocksProxyBackend()`
// unconditionally, so in every real deployment the ACTIVE registrar is
// the one that runs — and it destructures the service as `_service` and
// never calls it. `applyToSession()` and `releaseFromSession()` have no
// callers anywhere in the server. The two registrars differ only in the
// GET status (404 here, 503 there).
//
// So the 503 a customer sees is NOT a deployment-configuration state. It
// is an unfinished route-to-service edge. An operator who reads the
// comments below as written goes hunting through env vars for a backend
// that is already there and correctly built.
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
      // The route layer is not wired to the egress service yet — this throws
      // unconditionally, including when a backend IS present (V-823; it always
      // is, see bootstrap). Keep the public error limited to current
      // availability and impact; never surface internal implementation or
      // planning identifiers. The customer-facing wording is deliberately
      // about availability, which stays accurate either way.
      throw new FeatureUnavailableError(
        'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is unavailable on this deployment. ' +
          "Sessions continue through Driftstack's default egress.",
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
      // config). For now the route surfaces 404 because no session can
      // have a proxy applied: POST above never reaches the backend, so
      // nothing ever writes the state this would read (V-823 — this said
      // "no backend wired", which is not the reason; one is wired).
      throw new NotFoundError('No proxy config for this session.');
    },
  );
}

// Registered when `sessionEgressService` is omitted from AppDeps. Same
// pattern as `registerBillingDisabledRoutes` (Wave 1119 / Slice 1119.2):
// returning 503 + FeatureUnavailable on the route surface gives clients
// a machine-readable deployment-state signal instead of a misleading 404.
export function registerSessionProxyDisabledRoutes(app: FastifyInstance): void {
  // Customer-facing detail: state current availability and impact without
  // leaking internal implementation plans.
  const detail =
    'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is unavailable on this deployment. ' +
    "Sessions continue through Driftstack's default egress.";
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
