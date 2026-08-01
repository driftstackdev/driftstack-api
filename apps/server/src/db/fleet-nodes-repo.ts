// V-820 — Drizzle implementation of FleetNodesRepo (migration 0043).
// Production wires this; the InMemoryFleetNodesRepo in
// services/fleet-node-auth.ts continues to back tests + dev mode.
//
// The shipped `FleetNodesRepo` interface is `getPublicKey(nodeId)`.
// This impl adds `register` / `revoke` / `touchLastSeen` /
// `getDetail` / `listActive` methods on the class (not the interface)
// because the future operator routes
// (POST /v1/admin/fleet-nodes, /revoke, GET list, GET detail) consume
// the concrete class. Adding them to the interface would require the
// InMemory variant to grow too; the operator routes only run against
// the Drizzle path so this asymmetry is intentional.

import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';
import { and, asc, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { fleetNodes } from './schema.js';
import type { FleetNodePublicKey, FleetNodesRepo } from '../services/fleet-node-auth.js';
import {
  decryptLegacyLivekitSecret,
  decryptLivekitSecret,
  encryptLivekitSecret,
  LIVEKIT_SECRET_V2_PREFIX,
} from '../lib/livekit-secret-encryption.js';

/** Canonical uuid shape — used to guard a uuid-only column comparison against a
 *  caller-supplied key that may be a human node_id (which would otherwise force
 *  a Postgres uuid cast and raise 22P02, failing the whole query). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIVEKIT_SECRET_MIGRATION_BATCH = 500;

function livekitSecretIsLegacy() {
  return sql`${fleetNodes.livekitApiSecretCiphertext} IS NOT NULL
    AND ${fleetNodes.livekitApiSecretCiphertext} NOT LIKE ${`${LIVEKIT_SECRET_V2_PREFIX}%`}`;
}

function livekitSecretIsV2() {
  return sql`${fleetNodes.livekitApiSecretCiphertext} LIKE ${`${LIVEKIT_SECRET_V2_PREFIX}%`}`;
}

/**
 * Latest per-node telemetry snapshot (migration 0083), persisted from the
 * heartbeat and overwritten each beat for the admin Fleet panel (file-48 §A5).
 * Stored as jsonb on fleet_nodes.last_heartbeat. Mirrors the harness Heartbeat
 * telemetry fields (optional ones absent when the node doesn't emit them).
 */
export interface FleetNodeHeartbeatSnapshot {
  /** The node's own beat timestamp (ISO) — distinct from last_seen_at (CP receipt). */
  beatAt: string;
  cpuPercent: number;
  memoryPercent: number;
  activeSessionCount: number;
  maxConcurrent?: number;
  uptimeSeconds?: number;
  drainState?: string;
  sessionOutcomeCounts?: Record<string, number>;
  thermalState?: string;
  memoryPressureLevel?: string;
  busiestCorePercent?: number;
  diskFreePercent?: number;
  harnessVersion?: string;
}

export interface FleetNodeDetail {
  id: string;
  /** Human node identity (migration 0085) — the harness JWT `iss`
   *  (DRIFTSTACK_MAC_NODE_ID). Auth + heartbeat key by this. Null for
   *  identity-less rows (pre-0085). */
  nodeId: string | null;
  publicKeyBase64Url: string;
  displayName: string;
  region: string;
  hardwareClass: string;
  registeredAt: Date;
  lastSeenAt: Date | null;
  /** Latest telemetry snapshot (migration 0083); null until the first beat. */
  lastHeartbeat: FleetNodeHeartbeatSnapshot | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  /** LK.1 — per-Mac LiveKit credentials. All four fields are set
   *  together (CHECK constraint) or all four are NULL (pre-LK.2). */
  livekit: {
    apiKey: string;
    apiSecretCiphertextBase64: string;
    wsUrl: string;
    registeredAt: Date;
  } | null;
}

export interface RegisterFleetNodeArgs {
  publicKeyBase64Url: string;
  displayName: string;
  region: string;
  hardwareClass: string;
  /** Human node identity (migration 0085) — the harness JWT `iss`. Optional for
   *  back-compat with identity-less callers; required for a CP-connecting node. */
  nodeId?: string;
  registeredAt?: Date;
}

/** LK.2 — credentials the Mac harness POSTs to the control plane on
 *  boot. apiSecretCiphertextBase64 is the explicit versioned,
 *  record-bound envelope produced by encryptLivekitSecret(). */
export interface SetFleetNodeLivekitArgs {
  nodeId: string;
  apiKey: string;
  apiSecretCiphertextBase64: string;
  wsUrl: string;
  registeredAt?: Date;
}

export class DrizzleFleetNodesRepo implements FleetNodesRepo {
  constructor(private readonly database: Database) {}

  /**
   * Bootstrap-only no-DDL conversion from the context-free LiveKit envelope
   * to purpose/node/credential-bound v2. A page is fully authenticated before
   * its first write, and each rewrite compares the complete old tuple while
   * deliberately preserving livekit_registered_at.
   */
  async migrateLivekitSecretEnvelopes(
    keyBase64: string,
    limit = MAX_LIVEKIT_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIVEKIT_SECRET_MIGRATION_BATCH) {
      throw new Error(
        `LiveKit secret migration limit must be an integer from 1 to ${MAX_LIVEKIT_SECRET_MIGRATION_BATCH.toString()}.`,
      );
    }

    // Successor boots authenticate one already-bound row first. A wrong
    // operator key therefore fails before any legacy rewrite is attempted.
    const [v2Probe] = await this.database.db
      .select({
        id: fleetNodes.id,
        apiKey: fleetNodes.livekitApiKey,
        ciphertext: fleetNodes.livekitApiSecretCiphertext,
        wsUrl: fleetNodes.livekitWsUrl,
      })
      .from(fleetNodes)
      .where(livekitSecretIsV2())
      .orderBy(asc(fleetNodes.id))
      .limit(1);
    if (v2Probe !== undefined) {
      if (v2Probe.apiKey === null || v2Probe.ciphertext === null || v2Probe.wsUrl === null) {
        throw new Error(`Fleet node ${v2Probe.id} has an incomplete LiveKit credential tuple.`);
      }
      // Structural check above keeps its own message; only the DECRYPT is
      // wrapped. Locals carry the narrowing the closure would otherwise lose.
      const probeCiphertext = v2Probe.ciphertext;
      const probeApiKey = v2Probe.apiKey;
      const probeWsUrl = v2Probe.wsUrl;
      verifyBootEncryptionKey('Fleet node LiveKit secrets', 'MFA_ENCRYPTION_KEY', () => {
        decryptLivekitSecret(probeCiphertext, keyBase64, {
          nodeId: v2Probe.id,
          apiKey: probeApiKey,
          wsUrl: probeWsUrl,
        });
      });
    }

    const rows = await this.database.db
      .select({
        id: fleetNodes.id,
        apiKey: fleetNodes.livekitApiKey,
        ciphertext: fleetNodes.livekitApiSecretCiphertext,
        wsUrl: fleetNodes.livekitWsUrl,
        registeredAt: fleetNodes.livekitRegisteredAt,
      })
      .from(fleetNodes)
      .where(livekitSecretIsLegacy())
      .orderBy(asc(fleetNodes.id))
      .limit(limit);

    // Decode/authenticate the whole page before its first UPDATE. The schema's
    // all-or-null CHECK should make these fields complete; retain the explicit
    // fail-closed assertion for drifted or manually corrupted databases.
    const prepared = rows.map((row) => {
      if (
        row.apiKey === null ||
        row.ciphertext === null ||
        row.wsUrl === null ||
        row.registeredAt === null
      ) {
        throw new Error(`Fleet node ${row.id} has an incomplete LiveKit credential tuple.`);
      }
      const plaintext = decryptLegacyLivekitSecret(row.ciphertext, keyBase64);
      const next = encryptLivekitSecret(plaintext, keyBase64, {
        nodeId: row.id,
        apiKey: row.apiKey,
        wsUrl: row.wsUrl,
      });
      return {
        id: row.id,
        apiKey: row.apiKey,
        ciphertext: row.ciphertext,
        wsUrl: row.wsUrl,
        registeredAt: row.registeredAt,
        next,
      };
    });

    let converted = 0;
    for (const row of prepared) {
      const updated = await this.database.db
        .update(fleetNodes)
        .set({
          livekitApiSecretCiphertext: row.next,
          // Do not change livekitRegisteredAt: it controls fleet-node
          // selection order and is the operational credential revision.
        })
        .where(
          and(
            eq(fleetNodes.id, row.id),
            eq(fleetNodes.livekitApiKey, row.apiKey),
            eq(fleetNodes.livekitApiSecretCiphertext, row.ciphertext),
            eq(fleetNodes.livekitWsUrl, row.wsUrl),
            eq(fleetNodes.livekitRegisteredAt, row.registeredAt),
          ),
        )
        .returning({ id: fleetNodes.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(fleetNodes)
      .where(livekitSecretIsLegacy());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

  async getPublicKey(nodeId: string): Promise<FleetNodePublicKey | null> {
    // migration 0085 — `nodeId` here is the harness JWT `iss` = the human
    // DRIFTSTACK_MAC_NODE_ID (e.g. "mac-macstadium-us-001"), so resolve by the
    // `node_id` column, NOT the uuid `id` (a non-uuid iss would error against
    // the uuid column — the W2203b mismatch). The uuid `id` stays the internal
    // pk used by getDetail / setLivekitCredentials.
    const rows = await this.database.db
      .select({
        publicKeyBase64Url: fleetNodes.publicKeyBase64Url,
        registeredAt: fleetNodes.registeredAt,
        revokedAt: fleetNodes.revokedAt,
      })
      .from(fleetNodes)
      .where(eq(fleetNodes.nodeId, nodeId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      publicKeyBase64Url: row.publicKeyBase64Url,
      registeredAt: row.registeredAt,
      revokedAt: row.revokedAt,
    };
  }

  async register(args: RegisterFleetNodeArgs): Promise<FleetNodeDetail> {
    const inserted = await this.database.db
      .insert(fleetNodes)
      .values({
        publicKeyBase64Url: args.publicKeyBase64Url,
        displayName: args.displayName,
        region: args.region,
        hardwareClass: args.hardwareClass,
        ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
        ...(args.registeredAt !== undefined ? { registeredAt: args.registeredAt } : {}),
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('fleet_nodes insert returned no rows');
    }
    return rowToDetail(row);
  }

  async revoke(args: { nodeId: string; reason: string; revokedAt?: Date }): Promise<void> {
    await this.database.db
      .update(fleetNodes)
      .set({
        revokedAt: args.revokedAt ?? new Date(),
        revocationReason: args.reason,
      })
      .where(eq(fleetNodes.id, args.nodeId));
  }

  async touchLastSeen(nodeId: string, now: Date = new Date()): Promise<void> {
    await this.database.db
      .update(fleetNodes)
      .set({ lastSeenAt: now })
      .where(eq(fleetNodes.id, nodeId));
  }

  /**
   * Fleet-admin panel (migration 0083): bump last_seen_at AND store the latest
   * telemetry snapshot in one UPDATE-by-id (no-op for an unregistered node, so a
   * self-seeded/unknown beat is harmless). Called per heartbeat from the
   * fleet-control-registry consumer (the macNodeId↔JWT check runs first).
   */
  async recordHeartbeat(
    nodeId: string,
    snapshot: FleetNodeHeartbeatSnapshot,
    now: Date = new Date(),
  ): Promise<void> {
    // migration 0085 — `nodeId` is the heartbeat's macNodeId = the human
    // DRIFTSTACK_MAC_NODE_ID (== the JWT iss the connection authed with), so
    // update by the `node_id` column (no-op for an unregistered/identity-less
    // node — a self-seeded/unknown beat is harmless).
    await this.database.db
      .update(fleetNodes)
      .set({ lastSeenAt: now, lastHeartbeat: snapshot })
      .where(eq(fleetNodes.nodeId, nodeId));
  }

  /** LK.2 — set / rotate per-Mac LiveKit credentials on an existing
   *  fleet_node row. Returns the updated detail, or null when the
   *  nodeId doesn't match a row (caller maps to 404). */
  async setLivekitCredentials(args: SetFleetNodeLivekitArgs): Promise<FleetNodeDetail | null> {
    const updated = await this.database.db
      .update(fleetNodes)
      .set({
        livekitApiKey: args.apiKey,
        livekitApiSecretCiphertext: args.apiSecretCiphertextBase64,
        livekitWsUrl: args.wsUrl,
        livekitRegisteredAt: args.registeredAt ?? new Date(),
      })
      .where(eq(fleetNodes.id, args.nodeId))
      .returning();
    const row = updated[0];
    return row ? rowToDetail(row) : null;
  }

  async getDetail(nodeId: string): Promise<FleetNodeDetail | null> {
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(eq(fleetNodes.id, nodeId))
      .limit(1);
    const row = rows[0];
    return row ? rowToDetail(row) : null;
  }

  /** Resolve a NON-REVOKED node by the value persisted in agent_sessions.node_id.
   *  Dispatch writes that column as `mac.nodeId ?? mac.id` — the human node_id for
   *  a registered Mac, or the uuid PK as a legacy fallback — so this matches EITHER
   *  column. Used to bind a session's LiveKit token to the Mac that ACTUALLY
   *  publishes its stream (the token must not re-pick "most-recently-registered"
   *  via findNearestWithLivekit, which returns the wrong Mac the instant a region
   *  has >=2 LiveKit boxes). Returns null when neither column matches a live row. */
  async getDetailByNodeIdOrId(key: string): Promise<FleetNodeDetail | null> {
    // `fleetNodes.id` is a Postgres `uuid` column. `key` is the value persisted in
    // agent_sessions.node_id = `mac.nodeId ?? mac.id`, so it is USUALLY a human
    // node_id ("mac-macstadium-us-001"), NOT a uuid. Including `eq(id, key)` for a
    // non-uuid key makes Postgres cast the string to uuid and raise 22P02
    // (`invalid input syntax for type uuid`), which fails the ENTIRE query — that
    // bug silently killed LiveKit minting on every dispatched session (the route's
    // mint catch swallowed it → no `livekit` block → GUI polling fallback). Only
    // OR-in the uuid PK comparison when `key` is actually uuid-shaped.
    const matchKey = UUID_RE.test(key)
      ? or(eq(fleetNodes.nodeId, key), eq(fleetNodes.id, key))
      : eq(fleetNodes.nodeId, key);
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(and(isNull(fleetNodes.revokedAt), matchKey))
      .orderBy(desc(fleetNodes.livekitRegisteredAt))
      .limit(1);
    const row = rows[0];
    return row ? rowToDetail(row) : null;
  }

  /** LK.3 — pick any non-revoked Mac that has LiveKit credentials
   *  registered. v1.0 returns the most-recently-LiveKit-registered
   *  match; per-session Mac assignment is a follow-up slice. Returns
   *  null when no Mac in the fleet has registered LiveKit yet
   *  (caller surfaces 503). */
  async findAnyWithLivekit(): Promise<FleetNodeDetail | null> {
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(
        and(
          isNull(fleetNodes.revokedAt),
          // `IS NOT NULL` predicate on the api_key column — drizzle
          // doesn't have a direct helper, so we use a sql template.
          sql`${fleetNodes.livekitApiKey} IS NOT NULL`,
        ),
      )
      .orderBy(desc(fleetNodes.livekitRegisteredAt))
      .limit(1);
    const row = rows[0];
    return row ? rowToDetail(row) : null;
  }

  /** Region-aware variant of findAnyWithLivekit: prefer a non-revoked node WITH
   *  LiveKit in the caller's home region, falling back to ANY livekit node when
   *  the home region has none (so a single-region fleet, or a regional outage,
   *  never fails a session — a far box beats no box). `region` null/empty →
   *  straight to any. The data (accounts.region + fleet_nodes.region) already
   *  exists; this is the SELECTION that uses it so an EU box actually serves EU
   *  customers (vs findAnyWithLivekit, which is region-blind). */
  async findNearestWithLivekit(region: string | null | undefined): Promise<FleetNodeDetail | null> {
    if (region != null && region !== '') {
      const rows = await this.database.db
        .select()
        .from(fleetNodes)
        .where(
          and(
            isNull(fleetNodes.revokedAt),
            eq(fleetNodes.region, region),
            sql`${fleetNodes.livekitApiKey} IS NOT NULL`,
          ),
        )
        .orderBy(desc(fleetNodes.livekitRegisteredAt))
        .limit(1);
      const row = rows[0];
      if (row) return rowToDetail(row);
    }
    // No home-region livekit node (or no region given) → any livekit node.
    return this.findAnyWithLivekit();
  }

  /** Connectivity-aware dispatch helper: the FULL set of non-revoked LiveKit
   *  nodes, ordered so the caller can pick the first that is ALSO present in the
   *  control-WSS registry — home-region first (so an EU session prefers an EU
   *  box), then most-recently-LiveKit-registered. `findNearestWithLivekit`
   *  returns only the single top candidate; in a >=2-box region, if that one
   *  box's control-WSS happens to be offline the caller would black-screen even
   *  though a sibling box in the region is online and could serve. This lets the
   *  caller iterate candidates and bind the viewer token + publisher dispatch to
   *  the SAME live box. `region` null/empty → region-blind recency order. */
  async listWithLivekitNearest(
    region: string | null | undefined,
  ): Promise<ReadonlyArray<FleetNodeDetail>> {
    const hasRegion = region != null && region !== '';
    // Home-region rows first (boolean DESC → true before false), then
    // most-recently-LiveKit-registered. A NULL/empty region degrades to PURE
    // recency: the region term is OMITTED entirely (not rendered as a constant),
    // because PostgreSQL rejects `ORDER BY <boolean-literal>` (e.g. `ORDER BY
    // false DESC`) at execution — a region-blind dispatch must NOT throw.
    const orderTerms = hasRegion
      ? [desc(eq(fleetNodes.region, region)), desc(fleetNodes.livekitRegisteredAt)]
      : [desc(fleetNodes.livekitRegisteredAt)];
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(and(isNull(fleetNodes.revokedAt), sql`${fleetNodes.livekitApiKey} IS NOT NULL`))
      .orderBy(...orderTerms);
    return rows.map(rowToDetail);
  }

  /** Operator-dashboard list: non-revoked nodes, most-recently-seen
   *  first. Uses the partial index on `last_seen_at WHERE revoked_at
   *  IS NULL`. */
  async listActive(): Promise<ReadonlyArray<FleetNodeDetail>> {
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(isNull(fleetNodes.revokedAt))
      .orderBy(desc(fleetNodes.lastSeenAt));
    return rows.map(rowToDetail);
  }

  /** Operator-dashboard region filter: non-revoked nodes in a given
   *  region. Uses the partial index on `region WHERE revoked_at IS
   *  NULL`. */
  async listActiveByRegion(region: string): Promise<ReadonlyArray<FleetNodeDetail>> {
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(and(eq(fleetNodes.region, region), isNull(fleetNodes.revokedAt)))
      .orderBy(desc(fleetNodes.lastSeenAt));
    return rows.map(rowToDetail);
  }
}

function rowToDetail(row: typeof fleetNodes.$inferSelect): FleetNodeDetail {
  return {
    id: row.id,
    nodeId: row.nodeId,
    publicKeyBase64Url: row.publicKeyBase64Url,
    displayName: row.displayName,
    region: row.region,
    hardwareClass: row.hardwareClass,
    registeredAt: row.registeredAt,
    lastSeenAt: row.lastSeenAt,
    lastHeartbeat: (row.lastHeartbeat as FleetNodeHeartbeatSnapshot | null) ?? null,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
    livekit:
      row.livekitApiKey !== null &&
      row.livekitApiSecretCiphertext !== null &&
      row.livekitWsUrl !== null &&
      row.livekitRegisteredAt !== null
        ? {
            apiKey: row.livekitApiKey,
            apiSecretCiphertextBase64: row.livekitApiSecretCiphertext,
            wsUrl: row.livekitWsUrl,
            registeredAt: row.livekitRegisteredAt,
          }
        : null,
  };
}
