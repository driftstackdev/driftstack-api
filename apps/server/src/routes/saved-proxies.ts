// EG-API-1.3 — POST + GET + DELETE /v1/proxies (saved reusable
// customer proxy configs).
//
// Planning 133 §"Cross-agent split" Agent 2 scope:
//   - POST   /v1/proxies         — store reusable proxy config
//   - GET    /v1/proxies         — list caller's saved configs
//   - DELETE /v1/proxies/{id}    — remove a saved config
//
// Activation gate matches the per-session proxy routes (EG-API-1.2):
// `sessionEgressService` undefined → `registerSavedProxiesDisabledRoutes`
// registers 503 FeatureUnavailable stubs. When a backend lands the
// service-layer storage shape is the SavedProxyConfigSchema envelope
// (label + proxy) from @driftstack/api-types (EG-API-1.1).
//
// SECURITY: saved configs carry the same secret material as per-session
// configs (SOCKS5 password, OpenVPN .ovpn, WireGuard private key). The
// storage layer must apply the same protections as session-egress:
// AES-256-GCM at-rest envelope, never logged, never echoed back in
// list/get responses (only label + type + masked summary surfaces to
// the dashboard; the customer can't re-read their own raw key after
// save — they have to re-enter to update).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SavedProxyConfigSchema } from '@driftstack/api-types';
import type { SessionEgressService } from '../services/session-egress.js';
import { FeatureUnavailableError, NotFoundError, ValidationError } from '../lib/errors.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface SavedProxiesRoutesDeps {
  service: SessionEgressService;
}

export function registerSavedProxiesRoutes(
  app: FastifyInstance,
  deps: SavedProxiesRoutesDeps,
): void {
  const { service: _service } = deps;

  app.post(
    '/v1/proxies',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      const parsed = SavedProxyConfigSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // EG-API-1.6 propagation slice wires the storage layer
      // (saved_proxy_configs table + AES envelope). Until then the
      // route surface returns 503 FeatureUnavailable with the same
      // planning-133 pointer as the per-session route.
      throw new FeatureUnavailableError(
        'Saved-proxy storage is not yet wired on this server. EG-API-1.6 wires the backend.',
      );
    },
  );

  app.get('/v1/proxies', { preHandler: [app.requireAuth, app.rateLimit('global')] }, (req) => {
    requireCtx(req);
    // List returns 200 with empty data even pre-backend so the
    // dashboard's "no saved proxies yet" empty state renders the
    // same as a customer with no saved configs. This avoids a
    // confusing 503 on what's a read-only listing.
    return { data: [] as Array<{ id: string; label: string; type: string }> };
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/proxies/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      // No saved proxies exist yet → every id is 404.
      throw new NotFoundError(`Saved proxy ${req.params.id} not found.`);
    },
  );
}

// Disabled-stub variant for the no-backend posture. Symmetric with
// `registerSessionProxyDisabledRoutes` (EG-API-1.2). Returns 503
// FeatureUnavailable on POST + DELETE; GET returns 200 + empty list
// for the same dashboard-rendering reason described above.
export function registerSavedProxiesDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is not yet shipped. ' +
    'See planning file 133 for the Phase 1 SOCKS5 roadmap.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/proxies', stub);
  app.get('/v1/proxies', () => ({
    data: [] as Array<{ id: string; label: string; type: string }>,
  }));
  app.delete('/v1/proxies/:id', stub);
}
