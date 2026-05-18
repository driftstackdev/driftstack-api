// LK.2 — POST /v1/mac-nodes/register
//
// Each Mac mini in the fleet stores its own LiveKit API key + secret
// (provisioned by Agent 1's launchd LiveKit Server install) and
// POSTs them to the control plane on harness boot. The control
// plane stores them encrypted under MFA_ENCRYPTION_KEY so the JWT
// mint path (LK.3 — POST /v1/agent-sessions/:id/livekit-token) can
// decrypt + sign without any RPC back to the Mac.
//
// Auth posture (v1.0): admin scope. The Mac side is operator-
// provisioned via SSH for the foreseeable future; the eventual
// Mac-self-signs-via-Ed25519 path is a separate slice once the
// V-820 fleet handshake lands.
//
// Naming: the URL surface uses /v1/mac-nodes/ matching the
// orchestrator-brief terminology; the underlying table is
// fleet_nodes (LK.1's note explains the alignment). The route
// validates the mac_node_id against the existing fleet_nodes row.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import { encryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import { BadRequestError, NotFoundError, ValidationError } from '../lib/errors.js';

const RegisterBodySchema = z.object({
  mac_node_id: z.string().uuid('mac_node_id must be a UUID matching an existing fleet_nodes row.'),
  livekit: z.object({
    api_key: z.string().min(1).max(256),
    api_secret: z.string().min(1).max(1024),
    // Wide URL bound — accepts wss://mac-NNN.driftstack.dev:8443
    // form per the orchestrator brief.
    ws_url: z.string().url(),
  }),
});

export interface RegisterMacNodesRoutesDeps {
  repo: DrizzleFleetNodesRepo;
  /** MFA_ENCRYPTION_KEY (base64-encoded 32-byte AES-256 key). */
  encryptionKey: string;
  /** Now-provider (test-injectable). Defaults to `new Date()`. */
  now?: () => Date;
}

export function registerMacNodesRoutes(
  app: FastifyInstance,
  deps: RegisterMacNodesRoutesDeps,
): void {
  const { repo, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  app.post(
    '/v1/mac-nodes/register',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('driftstack_internal_admin'),
        app.rateLimit('global'),
      ],
    },
    async (req, reply) => {
      const parsed = RegisterBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const body = parsed.data;

      // Encrypt the plaintext secret immediately. The plaintext does
      // NOT leave this scope — never written to logs, never echoed
      // in the response.
      let ciphertextBase64: string;
      try {
        ciphertextBase64 = encryptLivekitSecret(body.livekit.api_secret, encryptionKey);
      } catch (err) {
        throw new BadRequestError(
          `Failed to encrypt LiveKit API secret: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }

      const updated = await repo.setLivekitCredentials({
        nodeId: body.mac_node_id,
        apiKey: body.livekit.api_key,
        apiSecretCiphertextBase64: ciphertextBase64,
        wsUrl: body.livekit.ws_url,
        registeredAt: now(),
      });

      if (updated === null) {
        throw new NotFoundError(
          `Mac node ${body.mac_node_id} not found in fleet_nodes. ` +
            'The node must already be registered via the V-820 fleet-node provisioning path.',
        );
      }

      // Response is intentionally minimal — never echoes the api_key
      // (treated as secret-equivalent per the orchestrator brief)
      // and obviously never echoes the api_secret.
      return reply.code(200).send({
        mac_node_id: updated.id,
        livekit_registered_at: updated.livekit?.registeredAt.toISOString() ?? now().toISOString(),
        ws_url: updated.livekit?.wsUrl ?? body.livekit.ws_url,
      });
    },
  );
}
