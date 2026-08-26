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
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import {
  BadRequestError,
  ConflictError,
  FeatureUnavailableError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import { serializeControlCommand } from '../services/harness-control-codec.js';
import { CONTROL_COMMANDS } from '../schemas/harness-control-protocol.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { readClientIp } from '../lib/client-ip.js';

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

// V-820 fleet-node IDENTITY registration body. Distinct from the LiveKit-creds
// RegisterBodySchema above: this CREATES the fleet_nodes row (mints the uuid) by
// the node's Ed25519 public key, so the CP can auth the node's WSS handshake
// (FleetNodeAuth.getPublicKey lookup). public_key_base64url is the base64url
// (no-padding) 32-byte Ed25519 public key — 43 chars; bounded loosely so a valid
// key is never rejected on a strict length assumption.
const RegisterNodeBodySchema = z.object({
  // node_id (migration 0085) — the human identity the harness signs its JWT as
  // (DRIFTSTACK_MAC_NODE_ID, e.g. "mac-macstadium-us-001"). Auth resolves the
  // node by this, so it MUST equal the daemon's DRIFTSTACK_MAC_NODE_ID.
  node_id: z.string().min(1).max(128),
  // 43 base64url chars + a single '=' — the form the fleet_nodes
  // `fleet_nodes_public_key_format` CHECK requires (32-byte Ed25519 key). The
  // node mints standard base64 (node.pub.b64); convert +/→-_ and KEEP the '='.
  public_key_base64url: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{43}=$/,
      'public_key_base64url must be 43 base64url chars + "=" (a 32-byte Ed25519 key)',
    ),
  display_name: z.string().min(1).max(128),
  region: z.string().min(1).max(64),
  hardware_class: z.string().min(1).max(64),
});

// Fleet-admin (§A5) node control body — POST /v1/mac-nodes/:id/control.
// command is the node-level action; reason is operator free text (logged on the
// node + carried for the audit trail). The frame itself is built by
// serializeControlCommand and pushed over the node's WSS.
const ControlNodeBodySchema = z.object({
  command: z.enum(CONTROL_COMMANDS),
  reason: z.string().min(1).max(512).optional(),
});

export interface RegisterMacNodesRoutesDeps {
  repo: DrizzleFleetNodesRepo;
  /** MFA_ENCRYPTION_KEY (base64-encoded 32-byte AES-256 key). */
  encryptionKey: string;
  /** Now-provider (test-injectable). Defaults to `new Date()`. */
  now?: () => Date;
  /** Optional admin-audit emitter. When wired, every successful
   *  registration writes an `mac_node.livekit_registered` row
   *  attributing the operator. Secret material (api_key + api_secret)
   *  is NEVER payloaded into the audit row — only mac_node_id +
   *  ws_url, which are non-sensitive. Failures are swallowed so a
   *  metric/db hiccup doesn't break credential persistence. */
  adminAudit?: AdminAuditService;
  /** Arc 7 obs.16 — when wired, the route increments
   *  `driftstack_mac_node_livekit_register_total{outcome}` per call.
   *  Outcome labels: ok / validation / encryption_error / not_found /
   *  unknown. Failures to .inc() are swallowed (best-effort). */
  metrics?: MetricsRegistry;
  /** W628 — when wired (FLEET_CONTROL_PLANE_ENABLED), the GET-list
   *  endpoint reports per-node `connected` (a live control-plane
   *  connection in the registry). Without it, `connected` is null —
   *  the server can't know connection state. This is the field that
   *  makes the worker bring-up debuggable: a node can be registered +
   *  have LiveKit yet not be connected, which is exactly when dispatch
   *  logs "fleet node not connected". */
  controlRegistry?: FleetControlRegistry;
}

export function registerMacNodesRoutes(
  app: FastifyInstance,
  deps: RegisterMacNodesRoutesDeps,
): void {
  const { repo, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  /** Arc 7 obs.16 — bounded-cardinality outcome bump. Swallow metric
   *  failures so a counter hiccup can't 5xx the route. */
  function bumpOutcome(outcome: string): void {
    try {
      deps.metrics?.inc(METRIC_NAMES.macNodeLivekitRegisterTotal, { outcome });
    } catch {
      // Swallow.
    }
  }

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
      if (!parsed.success) {
        bumpOutcome('validation');
        throw new ValidationError(parsed.error.flatten());
      }
      const body = parsed.data;

      // Encrypt the plaintext secret immediately. The plaintext does
      // NOT leave this scope — never written to logs, never echoed
      // in the response.
      let ciphertextBase64: string;
      try {
        ciphertextBase64 = encryptLivekitSecret(body.livekit.api_secret, encryptionKey, {
          nodeId: body.mac_node_id,
          apiKey: body.livekit.api_key,
          wsUrl: body.livekit.ws_url,
        });
      } catch {
        bumpOutcome('encryption_error');
        // A config-time failure (e.g. a misconfigured MFA_ENCRYPTION_KEY) — not
        // the caller's fault, so 500 not 400, and don't echo the key-shape
        // internals from err.message into the response. The cause lands in
        // Sentry via the error handler.
        throw new InternalError('Failed to encrypt the LiveKit API secret.');
      }

      const updated = await repo.setLivekitCredentials({
        nodeId: body.mac_node_id,
        apiKey: body.livekit.api_key,
        apiSecretCiphertextBase64: ciphertextBase64,
        wsUrl: body.livekit.ws_url,
        registeredAt: now(),
      });

      if (updated === null) {
        bumpOutcome('not_found');
        throw new NotFoundError(
          `Mac node ${body.mac_node_id} not found in fleet_nodes. ` +
            'The node must already be registered via the V-820 fleet-node provisioning path.',
        );
      }
      bumpOutcome('ok');

      // #128 regression guard — a node pointed at a HOSTED LiveKit Cloud SFU
      // (*.livekit.cloud) relays media box → remote DC → client (2 WAN hops), the
      // exact "middleman" latency the founder hit for 18 days before it was caught.
      // A co-located box-local SFU is the fast path. Cloud stays a VALID fallback
      // (kept as rollback), so this WARNs loudly rather than rejects — turning a
      // silent regression into an immediately-visible signal at the registration site.
      try {
        if (/\.livekit\.cloud$/i.test(new URL(body.livekit.ws_url).hostname)) {
          req.log.warn(
            {
              component: 'mac-node-livekit-register',
              macNodeId: body.mac_node_id,
              wsHost: new URL(body.livekit.ws_url).hostname,
            },
            'fleet node registered a REMOTE LiveKit Cloud SFU (middleman) — streaming takes 2 WAN hops; prefer a co-located box-local SFU (#128 Option A)',
          );
        }
      } catch {
        // ws_url was already .url()-validated; a parse failure here is impossible,
        // but a bad-URL edge must never break a successful registration.
      }

      // LK.2 audit emission — operators provisioning Macs is exactly
      // the kind of event the admin audit log exists to capture.
      // Best-effort: a failure here cannot revert the persisted
      // credentials, so swallow + carry on. The audit payload carries
      // ONLY non-sensitive metadata (ws_url + mac_node_id); the
      // api_key + api_secret never leave the encrypt scope above.
      if (deps.adminAudit !== undefined) {
        const ctx = req.account;
        if (ctx) {
          try {
            await deps.adminAudit.record({
              adminAccountId: ctx.account.id,
              adminKeyId: ctx.apiKey.id,
              action: 'mac_node.livekit_registered',
              targetResourceId: `mac_node_${body.mac_node_id}`,
              inputPayload: { ws_url: body.livekit.ws_url },
              result: 'success',
              ipAddress: readClientIp(req),
            });
          } catch {
            // Swallow — best-effort. Credentials are already persisted.
          }
        }
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

  // V-820 fleet-node IDENTITY registration — the prod path the
  // worker-cp-connect-readiness §2 blocker calls for (was: only a local seed
  // script / raw SQL). Admin-scoped: an operator POSTs the box's Ed25519 public
  // key + metadata, this mints the fleet_nodes row, and the response returns the
  // minted uuid → set it as DRIFTSTACK_MAC_NODE_ID on the daemon (its JWT
  // iss/sub must equal this uuid for the FleetNodeAuth.getPublicKey lookup; the
  // human display_name is NOT the node id — see A2-A3-BUS W2203b). LiveKit creds
  // are set separately via POST /v1/mac-nodes/register once identity exists.
  app.post(
    '/v1/mac-nodes',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('driftstack_internal_admin'),
        app.rateLimit('global'),
      ],
    },
    async (req, reply) => {
      const parsed = RegisterNodeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.flatten());
      }
      const b = parsed.data;
      let node;
      try {
        node = await repo.register({
          nodeId: b.node_id,
          publicKeyBase64Url: b.public_key_base64url,
          displayName: b.display_name,
          region: b.region,
          hardwareClass: b.hardware_class,
          registeredAt: now(),
        });
      } catch (err) {
        // Unique-violation → this node_id (fleet_nodes_node_id_unique) or
        // public key (fleet_nodes_public_key_unique) is already registered.
        // Surface as a 400 so a re-run is a clear client error, not a 500.
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          throw new BadRequestError(
            'A fleet node with this node_id or public key is already registered.',
          );
        }
        throw err;
      }
      // Response carries the uuid pk + the human node_id + the stored metadata.
      // The public key is echoed back (it is public, not a secret) for
      // operator confirmation.
      return reply.code(201).send({
        mac_node_id: node.id,
        node_id: node.nodeId,
        public_key_base64url: node.publicKeyBase64Url,
        display_name: node.displayName,
        region: node.region,
        hardware_class: node.hardwareClass,
        registered_at: node.registeredAt.toISOString(),
      });
    },
  );

  // W628 — GET /v1/mac-nodes: operator visibility into the fleet. The
  // repo's `listActive()` was documented as the operator-dashboard list
  // but was never wired to a route, so there was NO way to see whether a
  // worker had registered, when it was last seen, whether it carries
  // LiveKit credentials, or whether it's actually CONNECTED — the exact
  // facts needed to debug why a launch shows an empty stream room. This
  // is the read-only window onto that. Secret-safe: maps `livekit` to a
  // boolean `has_livekit`; the api_key / api_secret never appear.
  app.get(
    '/v1/mac-nodes',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('driftstack_internal_admin'),
        app.rateLimit('global'),
      ],
    },
    async (_req, reply) => {
      const nodes = await repo.listActive();
      return reply.code(200).send({
        data: nodes.map((n) => ({
          id: n.id,
          display_name: n.displayName,
          region: n.region,
          hardware_class: n.hardwareClass,
          registered_at: n.registeredAt.toISOString(),
          last_seen_at: n.lastSeenAt?.toISOString() ?? null,
          // Latest telemetry snapshot (migration 0083) for the admin Fleet
          // panel's resource/capacity/uptime/drain columns; null until the node
          // has sent its first heartbeat.
          last_heartbeat: n.lastHeartbeat ?? null,
          has_livekit: n.livekit !== null,
          // null when the control registry isn't wired (the server can't
          // know connection state); else whether a live control-plane
          // connection exists for this node.
          connected:
            deps.controlRegistry === undefined
              ? null
              : n.nodeId !== null && deps.controlRegistry.get(n.nodeId) !== undefined,
        })),
      });
    },
  );

  // Fleet-admin (§A5) node control — POST /v1/mac-nodes/:id/control. Admin-scoped
  // operator action (cordon / uncordon / drain / restart) pushed to the node over
  // its live WSS connection via the controlCommand frame (A2-A3-BUS W2203). v1
  // RBAC: driftstack_internal_admin (there is no finer staff operator/admin split
  // yet; admin-only is the conservative choice — the §A5 operator/admin tiering is
  // a later slice once a staff-role surface exists). 503 when the control plane is
  // off (no registry); 404 unknown node; 409 when the node has no live connection
  // (can't deliver). 202 on accepted — the harness applies it asynchronously and
  // reflects the result via heartbeat (drainState) / reconnect (restart).
  app.post(
    '/v1/mac-nodes/:id/control',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('driftstack_internal_admin'),
        app.rateLimit('global'),
      ],
    },
    async (req, reply) => {
      if (deps.controlRegistry === undefined) {
        throw new FeatureUnavailableError('Fleet control plane is not enabled.');
      }
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) {
        throw new BadRequestError('mac node id must be a UUID.');
      }
      const parsed = ControlNodeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.flatten());
      }
      const nodeId = params.data.id;
      // 404 an unknown node BEFORE checking the connection (clearer than a bare
      // "not connected" for an id that was never registered).
      const detail = await repo.getDetail(nodeId);
      if (detail === null) {
        throw new NotFoundError(`Fleet node ${nodeId} not found.`);
      }
      // The registry is keyed by the node's human node_id (migration 0085 — the
      // JWT iss the connection authed with), NOT the uuid pk. Resolve the
      // connection by detail.nodeId; a node with no node_id can't be connected.
      const conn = detail.nodeId !== null ? deps.controlRegistry.get(detail.nodeId) : undefined;
      if (conn === undefined) {
        throw new ConflictError(
          `Fleet node ${nodeId} has no live control-plane connection — cannot deliver the command.`,
        );
      }
      // V-1722 — the send is the second way this route fails to deliver, and it
      // used to be the only one that answered 5xx. `registry.get()` proves a
      // connection EXISTED; `sendControlCommand` refuses if the socket closed in
      // the window since, or if the outbound buffer is over
      // FLEET_WS_MAX_BUFFERED_BYTES. Both are the node being unreachable — the
      // same customer-facing condition the line above answers 409 for — and an
      // unreachable worker is not this server erroring.
      //
      // Converted at the boundary rather than narrowed by message: at this point
      // the command demonstrably did not reach the node whatever the cause, which
      // is what the caller needs to know. The original is logged so a genuine
      // defect here stays diagnosable instead of being flattened into a 409.
      try {
        conn.sendControlCommand(
          serializeControlCommand({
            command: parsed.data.command,
            ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
          }),
        );
      } catch (err) {
        req.log?.warn(
          {
            component: 'fleet-node-control',
            nodeId,
            command: parsed.data.command,
            err: err instanceof Error ? err.message : String(err),
          },
          'controlCommand transport send failed; answering 409 rather than 500',
        );
        throw new ConflictError(
          `Fleet node ${nodeId} could not be reached — the command was not delivered.`,
        );
      }
      // Audit: a node-control action changes a production worker's
      // availability, so record WHO issued WHICH command against WHICH node.
      // Best-effort (mirrors the LK.2 emit) — a failed audit insert must not
      // revert the already-sent command nor 5xx the route. Payload carries
      // only non-sensitive metadata (command + reason); never a secret.
      if (deps.adminAudit !== undefined) {
        const ctx = req.account;
        if (ctx) {
          try {
            await deps.adminAudit.record({
              adminAccountId: ctx.account.id,
              adminKeyId: ctx.apiKey.id,
              action: 'mac_node.control',
              targetResourceId: `mac_node_${nodeId}`,
              inputPayload: {
                command: parsed.data.command,
                ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
              },
              result: 'success',
              ipAddress: readClientIp(req),
            });
          } catch {
            // Swallow — best-effort. The command was already delivered.
          }
        }
      }
      return reply.code(202).send({
        mac_node_id: nodeId,
        command: parsed.data.command,
        accepted: true,
      });
    },
  );
}
