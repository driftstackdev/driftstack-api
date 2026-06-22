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

import type { FastifyInstance } from 'fastify';
import type { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import { mintLivekitToken } from '../lib/livekit-token.js';
import { decryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { FeatureUnavailableError } from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

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

  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/livekit-token',
    {
      // requireScope('write'): this mints a token with canPublishData:true — a
      // CONTROL credential (the DataChannel drives mouse/keyboard InputEvents to
      // the Mac). A read-only key minting one could DRIVE the session, so the mint
      // is write-equivalent (same posture as the gui-control-key route).
      preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')],
    },
    async (req, reply) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const sessionId = req.params.id;

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
      // Cross-account access is a 404 (anti-enumeration; same posture
      // as /v1/sessions/:id and the rest of the customer-facing surface).
      if (session.accountId !== ctx.account.id) {
        bump('not_found');
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }
      if (session.status !== 'active') {
        // 403 rather than 404 — the customer DID own this session,
        // they just can't mint a token for a closed one. Matches the
        // existing pair-mode-action posture.
        bump('forbidden');
        throw new ForbiddenError(`Cannot mint LiveKit token for ${session.status} agent session.`);
      }

      // Region-aware Mac selection — parity with session-create
      // (findNearestWithLivekit(accountRegion)). Prefer a node in the customer's
      // region so a token RE-MINT doesn't pin e.g. an EU viewer to a far (US) box
      // and add a needless transatlantic media hop. Falls back to any node when
      // there's no regional match (single-region fleet → unchanged).
      // Per-session Mac assignment is a follow-up slice; once agent_sessions tracks
      // the assigned Mac this becomes getDetail(session.assignedMacNodeId).
      const mac = await fleetNodesRepo.findNearestWithLivekit(ctx.account.region);
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
        apiSecret = decryptLivekitSecret(mac.livekit.apiSecretCiphertextBase64, encryptionKey);
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
        identity: `customer-${ctx.account.id}`,
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
        participant_identity: `customer-${ctx.account.id}`,
        expires_at: expiresAt,
      });
    },
  );
}
