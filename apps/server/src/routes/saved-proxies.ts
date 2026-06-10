// EG-API-1.3 — POST + GET + DELETE /v1/proxies (saved reusable
// customer proxy configs). EG-API-1.7 adds the reachability-test verb.
//
// Planning 133 §"Cross-agent split" Agent 2 scope:
//   - POST   /v1/proxies         — store reusable proxy config
//   - GET    /v1/proxies         — list caller's saved configs
//   - POST   /v1/proxies/{id}/test — reachability + UDP-ASSOCIATE check
//                                    (runs from a Mac-fleet node; EG-API-1.7)
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
import type { AccountAuditService } from '../services/account-audit.js';
import { FeatureUnavailableError, NotFoundError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface SavedProxiesRoutesDeps {
  service: SessionEgressService;
  /** 2026-05-20 — customer audit-log writer. Wired here so that when
   *  EG-API-1.6 lands the storage backend, the emit point is ALREADY
   *  in place — landing the storage layer doesn't have to also land
   *  an audit-log Class-A schema migration. Payload carries
   *  proxy_id + label + type; NEVER the secret material. */
  accountAudit?: AccountAuditService;
}

export function registerSavedProxiesRoutes(
  app: FastifyInstance,
  deps: SavedProxiesRoutesDeps,
): void {
  const { service: _service } = deps;
  const accountAudit = deps.accountAudit;

  // Suppress unused-warn pending EG-API-1.6 backend wire. The helper
  // is referenced inside the POST + DELETE emit-call sites below.
  void accountAudit;

  app.post(
    '/v1/proxies',
    // W491 — write-scope: a read-only key can't create proxies (least-privilege).
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      const parsed = SavedProxyConfigSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // EG-API-1.6 propagation slice wires the storage layer
      // (saved_proxy_configs table + AES envelope). Until then the
      // route surface returns 503 FeatureUnavailable.
      //
      // When the storage layer lands, emit:
      //   await accountAudit?.record({
      //     accountId: ctx.account.id,
      //     actorType: 'customer',
      //     action: 'proxy.created',
      //     targetResourceId: `proxy_${created.id}`,
      //     payload: { proxy_id: created.id, label: parsed.data.label, type: parsed.data.type },
      //     ipAddress: readClientIp(req),
      //   });
      //
      // Audit enum values + dashboard labels already exist
      // (2026-05-20). No follow-up needed beyond uncommenting the
      // emit call after the storage insert succeeds.
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

  // EG-API-1.7 — reachability + UDP-ASSOCIATE test. The dashboard
  // create-profile + /proxies surfaces expose a "Test proxy" button;
  // the real check runs from a Mac-fleet node (authentic egress path,
  // not the control-plane host) and reports DNS / UDP-ASSOCIATE /
  // latency. Until the fleet-side runner lands the endpoint returns
  // 503 FeatureUnavailable so the dashboard surfaces the "scheduled,
  // runs from a Mac node" message consistently rather than a 404.
  app.post<{ Params: { id: string } }>(
    '/v1/proxies/:id/test',
    // W491 — write-scope: proxy reachability test is a write-class action.
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      throw new FeatureUnavailableError(
        'Proxy reachability testing is not yet wired on this server. The check ' +
          'runs from a Mac-fleet node (DNS + UDP-ASSOCIATE + latency); EG-API-1.7 ' +
          'wires the fleet-side runner.',
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/proxies/:id',
    // W491 — write-scope: a read-only key can't delete proxies (least-privilege).
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    (req): never => {
      requireCtx(req);
      // No saved proxies exist yet → every id is 404.
      //
      // When the storage layer lands, emit AFTER successful delete:
      //   await accountAudit?.record({
      //     accountId: ctx.account.id,
      //     actorType: 'customer',
      //     action: 'proxy.deleted',
      //     targetResourceId: `proxy_${req.params.id}`,
      //     payload: { proxy_id: req.params.id, label: deleted.label, type: deleted.type },
      //     ipAddress: readClientIp(req),
      //   });
      throw new NotFoundError(`Saved proxy ${req.params.id} not found.`);
    },
  );

  // Suppress unused-warn on readClientIp until the emit calls land.
  void readClientIp;
}

// Disabled-stub variant for the no-backend posture. Symmetric with
// `registerSessionProxyDisabledRoutes` (EG-API-1.2). Returns 503
// FeatureUnavailable on POST + DELETE; GET returns 200 + empty list
// for the same dashboard-rendering reason described above.
export function registerSavedProxiesDisabledRoutes(app: FastifyInstance): void {
  // Customer-facing detail. "planning file 133" is internal
  // nomenclature; customers don't have access. Drop the internal
  // reference and surface the Phase 1 SOCKS5 roadmap framing in
  // customer-readable terms.
  const detail =
    'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is not yet ' +
    'shipped. Phase 1 SOCKS5 support is on the roadmap; until then sessions ' +
    "route through Driftstack's default egress.";
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/proxies', stub);
  app.get('/v1/proxies', () => ({
    data: [] as Array<{ id: string; label: string; type: string }>,
  }));
  app.post('/v1/proxies/:id/test', stub);
  app.delete('/v1/proxies/:id', stub);
}
