// V-531.B — LiveKit access-token mint route.
//
//   POST /v1/sessions/:id/livekit-token  { role: 'publisher' | 'subscriber' }
//
// The route hands a short-lived HS256 JWT + the WS URL back to the
// caller. The token grants connect-to-room rights scoped to the
// session id (one room per session). Publisher tokens are issued for
// the Mac-mini-side capture process; subscriber tokens for the
// customer-dashboard's live-preview surface.
//
// Posture: wire-ready. lib/app.ts registers this route only when
// config.livekit is fully populated (apiKey + apiSecret + wsUrl). When
// any of the three are absent the route stays unregistered; the
// client gets a 404 and falls back to the HTTP polling plane. Same
// "stub-until-keyed" posture as V-487 NowPayments + V-665 Postmark.
//
// Ownership: the caller must own the session. The route delegates the
// ownership check to a `requireSessionOwnership` callback supplied by
// the wiring layer so this file stays decoupled from the sessions
// service surface (which is privileged in ways we don't need here).
// Cross-account session ids 404 (anti-enumeration; same posture as
// the rest of the customer-facing surface).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mintLivekitToken } from '../lib/livekit-token.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export interface RegisterLivekitTokenRouteDeps {
  /** `config.livekit.apiKey` */
  apiKey: string;
  /** `config.livekit.apiSecret` */
  apiSecret: string;
  /** `config.livekit.wsUrl` — handed back so clients don't need a separate config probe. */
  wsUrl: string;
  /**
   * Resolve whether the supplied session id belongs to the calling
   * account. Returns true on a match, false otherwise. Throwing is
   * reserved for infrastructure errors (db down, etc.).
   *
   * Wiring layer typically passes:
   *   (accountId, sessionId) => sessionRepo.findSession(sessionId, accountId).then(r => r !== null)
   */
  isSessionOwned: (accountId: string, sessionId: string) => Promise<boolean>;
  /**
   * Token TTL in seconds. Default 600 (10 min). The customer-dashboard
   * keeps the WS connection alive past expiry — LiveKit's spec is that
   * the token is checked at handshake, not heartbeats. Reasonable
   * floor: 60s; reasonable ceiling: 1h.
   */
  ttlSeconds?: number;
}

const BodySchema = z.object({
  role: z.enum(['publisher', 'subscriber']),
});

const SESSION_ID_RE = /^sess_[0-9a-f]{8,}$/;

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!req.account) throw new Error('account context missing after requireAuth');
  return req.account;
}

export function registerLivekitTokenRoute(
  app: FastifyInstance,
  deps: RegisterLivekitTokenRouteDeps,
): void {
  app.post<{ Params: { id: string }; Body: { role: 'publisher' | 'subscriber' } }>(
    '/v1/sessions/:id/livekit-token',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const sessionId = req.params.id;
      // Cheap shape-check rejects obvious junk before the db hit.
      if (!SESSION_ID_RE.test(sessionId)) {
        throw new NotFoundError(`Session "${sessionId}" not found.`);
      }
      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const owned = await deps.isSessionOwned(ctx.account.id, sessionId);
      if (!owned) throw new NotFoundError(`Session "${sessionId}" not found.`);

      const token = mintLivekitToken({
        apiKey: deps.apiKey,
        apiSecret: deps.apiSecret,
        identity: sessionId,
        ttlSeconds: deps.ttlSeconds ?? 600,
        video: {
          room: sessionId,
          roomJoin: true,
          canPublish: parsed.data.role === 'publisher',
          canSubscribe: parsed.data.role === 'subscriber',
        },
      });

      return reply.code(200).send({
        token,
        ws_url: deps.wsUrl,
        room: sessionId,
        role: parsed.data.role,
        ttl_seconds: deps.ttlSeconds ?? 600,
      });
    },
  );
}
