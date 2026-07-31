// LK.3 — POST /v1/agent-sessions/:id/livekit-token
//
// Mint a per-Mac LiveKit JWT for the gui-client (or any other
// LiveKit-aware subscriber) to connect to the room hosting this
// agent session's video stream.
//
// Flow:
//   1. Verify the agent session exists + belongs to the caller.
//   2. Pick a Mac with LiveKit credentials registered (LK.2's
//      output). v1.0: picks the most-recently-registered Mac.
//      Per-session Mac assignment is a follow-up; once the
//      session-create flow assigns a Mac, this route reads the
//      specific Mac from agent_sessions instead.
//   3. Decrypt the per-Mac api_secret (MFA_ENCRYPTION_KEY).
//   4. Mint a JWT scoped to the agent_session.id (used as the
//      LiveKit room name) with canSubscribe+canPublishData grants.
//   5. Return ws_url + room + token + participant_identity + expires_at.
//
// Token TTL: 24h to match the gui_control_key TTL. The room name
// is the agent_session id (one room per session); the participant
// identity is `customer-<account-id>` so the SFU can dedupe joins.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import { callerCanAccessAgentSession } from './agent-sessions.js';
import { mintLivekitToken, resolveSessionPublisherNode } from '../lib/livekit-token.js';
import { decryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { FeatureUnavailableError } from '../lib/errors.js';
import { GUI_CONTROL_KEY_HEADER, validateGuiControlKey } from '../lib/agent-session-control-key.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { consumeEffectiveOwnerRateLimit } from '../middleware/rate-limit.js';

const AGENT_SESSION_ID_RE = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Token TTL — 24h matches gui_control_key + the agent-session
 *  lifecycle. LiveKit's max is 6h, but the SFU re-checks at
 *  handshake only, so post-handshake long-lived connections survive
 *  the token expiry. Customer reconnects re-mint via this route. */
export const LIVEKIT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface RegisterAgentSessionsLivekitTokenRouteDeps {
  fleetNodesRepo: DrizzleFleetNodesRepo;
  agentSessionsRepo: AgentSessionsRepo;
  /** MFA_ENCRYPTION_KEY (base64-encoded 32-byte AES-256 key). */
  encryptionKey: string;
  /**
   * MFA_ENCRYPTION_KEY (base64) used to decrypt the per-session
   * gui_control_key. When wired, the Simulator app — which holds ONLY the
   * per-session control key, not the account API key — can re-mint a LiveKit
   * token on reconnect via that key (mirrors the `controlKeyOrAccountAuth`
   * path on the other agent-session control routes). Absent → control-key
   * auth is disabled and only the account path is accepted.
   */
  guiControlKeyEncryptionKey?: string;
  /** Now-provider (test-injectable). Defaults to `() => Date.now()`. */
  nowMs?: () => number;
  /** Optional metrics registry — when wired, every mint outcome
   *  bumps `driftstack_livekit_token_mint_total{role,outcome}`
   *  with role='subscriber' (the agent-sessions surface is
   *  subscriber-only — the Mac publishes the video stream). */
  metrics?: MetricsRegistry;
}

export function registerAgentSessionsLivekitTokenRoute(
  app: FastifyInstance,
  deps: RegisterAgentSessionsLivekitTokenRouteDeps,
): void {
  const { fleetNodesRepo, agentSessionsRepo, encryptionKey } = deps;
  const guiControlKeyEncryptionKey = deps.guiControlKeyEncryptionKey;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const metrics = deps.metrics;
  const bump = (outcome: string): void => {
    try {
      metrics?.inc(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome,
      });
    } catch {
      // Swallow; metrics are best-effort.
    }
  };

  // Auth path (b): a valid per-session gui_control_key re-mints a token for
  // THIS `:id` session. The Simulator app holds only this key (never the
  // account API key), so reconnect would otherwise be unable to re-mint. When
  // the control key validates, requireAuth/requireScope('write') are SKIPPED
  // (the key is already a write-equivalent control credential, bound to this
  // one session) and the owning account is stashed for rate-limiting + the
  // handler. Mirrors controlKeyOrAccountAuth in routes/agent-sessions.ts.
  const controlKeyOrAccountAuth = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const headerRaw = req.headers[GUI_CONTROL_KEY_HEADER];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (header !== undefined && header.length > 0) {
      // A control key was presented; validateGuiControlKey throws a hard 401 on
      // any failure (never falls through to the account path).
      const sessionId = (req.params as { id?: string }).id ?? '';
      const session = await agentSessionsRepo.get(sessionId);
      const result = validateGuiControlKey({
        headerRaw,
        session,
        encryptionKey: guiControlKeyEncryptionKey,
        nowMs,
      });
      if (result.authorized) {
        req.guiControlKeyAuthorized = true;
        // rateLimit() keys off request.account (absent here); charge the owner.
        req.guiControlKeyRateLimitAccountId = result.ownerAccountId;
        return;
      }
    }
    // No control key → normal account auth chain (requireScope('write') because
    // the token carries canPublishData:true — a control credential).
    await app.requireAuth(req, reply);
    await app.requireScope('write')(req, reply);
  };

  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/livekit-token',
    {
      // requireScope('write'): this mints a token with canPublishData:true — a
      // CONTROL credential (the DataChannel drives mouse/keyboard InputEvents to
      // the Mac). A read-only key minting one could DRIVE the session, so the mint
      // is write-equivalent (same posture as the gui-control-key route). The
      // control-key path is the alternative for the Simulator's reconnect.
      preHandler: [controlKeyOrAccountAuth, app.rateLimit('global')],
    },
    async (req, reply) => {
      const sessionId = req.params.id;
      const controlKeyAuthorized = req.guiControlKeyAuthorized === true;
      const ctx = req.account;
      if (!controlKeyAuthorized && !ctx) {
        throw new Error('account context missing after requireAuth');
      }

      // Cheap shape-check — junk ids fail before the db hit.
      if (!AGENT_SESSION_ID_RE.test(sessionId)) {
        bump('not_found');
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }

      const session = await agentSessionsRepo.get(sessionId);
      if (session === null) {
        bump('not_found');
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }
      // Account path: enforce access is a 404 for a caller who can't reach this
      // session (anti-enumeration; same posture as /v1/sessions/:id). Access =
      // self OR a TEAM ADMIN of the owning account — a team admin who launched the
      // session on the owner's behalf must be able to mint its token. Use the
      // canonical callerCanAccessAgentSession (the same helper all sibling
      // agent-session routes use), NOT a raw owner-equality (which 404'd a
      // legitimate team admin). Control-key path: the key was already
      // decrypt-matched against THIS session in the preHandler, so it is
      // authorized for this one session and skips the ownership check.
      if (!controlKeyAuthorized && (!ctx || !callerCanAccessAgentSession(ctx, session.accountId))) {
        bump('not_found');
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }
      await consumeEffectiveOwnerRateLimit(app, req, reply, session.accountId, 'global');
      if (session.status !== 'active') {
        // 403 rather than 404 — the customer DID own this session,
        // they just can't mint a token for a closed one. Matches the
        // existing pair-mode-action posture.
        bump('forbidden');
        throw new ForbiddenError(`Cannot mint LiveKit token for ${session.status} agent session.`);
      }

      // The owning account id drives the participant identity (SFU join-dedupe)
      // and the LiveKit room scoping — it's session.accountId either way (on the
      // account path it's the owner the caller is authorized against; on the
      // control-key path it's the owner the key validated against). Region is only
      // used for the publisher-node FALLBACK (a NULL/legacy node_id); an active,
      // already-dispatched session has a bound node_id so the fallback isn't
      // exercised. Use the caller's region ONLY when the caller IS the owner — a
      // team admin's region is NOT the owner's and we don't hold the owner's here,
      // so pass null (same as the control-key path). Passing a team member's
      // region could otherwise resolve a wrong-region node in the rare fallback.
      const ownerAccountId = session.accountId;
      const isOwnerCaller =
        !controlKeyAuthorized && ctx != null && session.accountId === ctx.account.id;
      const region = isOwnerCaller ? (ctx?.account.region ?? null) : null;

      // Bind the token to the Mac that ACTUALLY publishes this session's stream
      // (agent_sessions.node_id, set at dispatch) — NOT the region's
      // most-recently-LiveKit-registered Mac (findNearestWithLivekit). Once a region
      // has >=2 LiveKit boxes, the latter resolves the WRONG Mac → the viewer joins
      // an empty room on that box (black screen) and the input DataChannel never
      // reaches the publishing Mac. resolveSessionPublisherNode falls back to the
      // region-nearest node only for a NULL/legacy node_id or a bound node that lost
      // its creds (logged). Mirrors the close path's node binding.
      const mac = await resolveSessionPublisherNode(
        fleetNodesRepo,
        session.nodeId,
        region,
        req.log,
      );
      if (mac === null || mac.livekit === null) {
        bump('no_mac');
        throw new FeatureUnavailableError(
          'No Mac in the fleet has registered LiveKit credentials yet. ' +
            'POST /v1/mac-nodes/register must run for at least one Mac before ' +
            'tokens can be minted.',
        );
      }

      let apiSecret: string;
      try {
        apiSecret = decryptLivekitSecret(mac.livekit.apiSecretCiphertextBase64, encryptionKey, {
          nodeId: mac.id,
          apiKey: mac.livekit.apiKey,
          wsUrl: mac.livekit.wsUrl,
        });
      } catch {
        // Decryption failure = catastrophic: either the secret is
        // corrupted or the key has rotated without re-registering
        // Macs. Surface as 503 + ops alert (the throw lands in
        // Sentry via the error-handler).
        bump('secret_unreadable');
        // Customer-facing 503 — keep it generic. The node id + underlying crypto
        // error are ops detail (captured in Sentry via the error handler), not
        // something to leak to an authenticated customer.
        throw new FeatureUnavailableError(
          'Session media credentials are temporarily unavailable — please retry in a moment.',
        );
      }

      const ttlSeconds = LIVEKIT_TOKEN_TTL_SECONDS;
      const tokenNowMs = nowMs();
      const token = mintLivekitToken({
        apiKey: mac.livekit.apiKey,
        apiSecret,
        identity: `customer-${ownerAccountId}`,
        ttlSeconds,
        nowMs: tokenNowMs,
        video: {
          room: sessionId,
          roomJoin: true,
          // gui-client is a subscriber FOR TRACKS (Mac-side BrowserController
          // is the publisher, provisioned out-of-band on the Mac) — but it
          // publishes DATA: the floating-iPhone simulator's input-capture sends
          // mouse/keyboard InputEvents over the DataChannel to the Mac-side
          // CGEvent decoder. canPublishData:true is set EXPLICITLY (not left to
          // LiveKit's default) so manual control works; canPublish stays false
          // so the customer still can't inject a video track.
          canPublish: false,
          canSubscribe: true,
          canPublishData: true,
        },
      });

      bump('ok');
      const expiresAt = new Date(tokenNowMs + ttlSeconds * 1000).toISOString();
      return reply.code(200).send({
        ws_url: mac.livekit.wsUrl,
        room: sessionId,
        token,
        participant_identity: `customer-${ownerAccountId}`,
        expires_at: expiresAt,
      });
    },
  );
}
