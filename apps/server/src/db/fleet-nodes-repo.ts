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

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { fleetNodes } from './schema.js';
import type { FleetNodePublicKey, FleetNodesRepo } from '../services/fleet-node-auth.js';

export interface FleetNodeDetail {
  id: string;
  publicKeyBase64Url: string;
  displayName: string;
  region: string;
  hardwareClass: string;
  registeredAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
}

export interface RegisterFleetNodeArgs {
  publicKeyBase64Url: string;
  displayName: string;
  region: string;
  hardwareClass: string;
  registeredAt?: Date;
}

export class DrizzleFleetNodesRepo implements FleetNodesRepo {
  constructor(private readonly database: Database) {}

  async getPublicKey(nodeId: string): Promise<FleetNodePublicKey | null> {
    const rows = await this.database.db
      .select({
        publicKeyBase64Url: fleetNodes.publicKeyBase64Url,
        registeredAt: fleetNodes.registeredAt,
        revokedAt: fleetNodes.revokedAt,
      })
      .from(fleetNodes)
      .where(eq(fleetNodes.id, nodeId))
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

  async getDetail(nodeId: string): Promise<FleetNodeDetail | null> {
    const rows = await this.database.db
      .select()
      .from(fleetNodes)
      .where(eq(fleetNodes.id, nodeId))
      .limit(1);
    const row = rows[0];
    return row ? rowToDetail(row) : null;
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
    publicKeyBase64Url: row.publicKeyBase64Url,
    displayName: row.displayName,
    region: row.region,
    hardwareClass: row.hardwareClass,
    registeredAt: row.registeredAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
  };
}
