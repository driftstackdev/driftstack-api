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

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { fleetNodes } from './schema.js';
import type { FleetNodePublicKey, FleetNodesRepo } from '../services/fleet-node-auth.js';

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
 *  boot. apiSecretCiphertextBase64 is the base64-encoded
 *  [IV | tag | ciphertext] blob produced by encryptLivekitSecret(). */
export interface SetFleetNodeLivekitArgs {
  nodeId: string;
  apiKey: string;
  apiSecretCiphertextBase64: string;
  wsUrl: string;
  registeredAt?: Date;
}

export class DrizzleFleetNodesRepo implements FleetNodesRepo {
  constructor(private readonly database: Database) {}

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
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(
        and(isNull(fleetNodes.revokedAt), or(eq(fleetNodes.nodeId, key), eq(fleetNodes.id, key))),
      )
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
