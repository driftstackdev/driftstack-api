// Region-aware dispatch (2026-06-21) — DrizzleFleetNodesRepo.findNearestWithLivekit
// against a REAL Postgres. Proves the selection that makes an EU box actually serve
// EU customers: prefer a non-revoked livekit node in the caller's region, fall back
// to ANY livekit node when the home region has none (single-region fleet / outage →
// a far box still beats no box). Region-blind callers (null) get any node.
//
// Run scope:
//   - CI: build-test job has postgres at localhost:5432 (migrated); runs here.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type * as schema from '../../src/db/schema.js';

/** A public key matching the fleet_nodes_public_key_format check (43 base64url
 *  chars + '='), i.e. a base64url-encoded 32-byte ed25519 key. */
function pk(): string {
  return `${randomBytes(32).toString('base64url')}=`;
}

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededIds: string[] = [];

beforeAll(async () => {
  client = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await client`SELECT 1 FROM fleet_nodes LIMIT 0`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const id of seededIds) {
      await client`DELETE FROM fleet_nodes WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleFleetNodesRepo.findNearestWithLivekit — region-aware selection (Drizzle path against real Postgres)',
  () => {
    it('prefers the home-region livekit node; falls back to any when the region has none', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });

      // Seed a US livekit node, an EU livekit node, and an APAC node WITHOUT
      // livekit (proves the within-region livekit filter + fallback).
      const seed = async (region: string, withLivekit: boolean, wsUrl: string): Promise<void> => {
        const node = await repo.register({
          publicKeyBase64Url: pk(),
          displayName: `test-${region}-${randomUUID().slice(0, 8)}`,
          region,
          hardwareClass: 'm2pro',
          nodeId: `test-node-${randomUUID()}`,
        });
        seededIds.push(node.id);
        if (withLivekit) {
          await repo.setLivekitCredentials({
            nodeId: node.id,
            apiKey: `key-${region}`,
            apiSecretCiphertextBase64: 'ct',
            wsUrl,
          });
        }
      };
      await seed('us', true, 'ws://us-box');
      await seed('eu', true, 'ws://eu-box');
      await seed('apac', false, ''); // apac region exists but has NO livekit

      // EU viewer → the EU box.
      const eu = await repo.findNearestWithLivekit('eu');
      expect(eu?.livekit?.wsUrl).toBe('ws://eu-box');

      // US viewer → the US box.
      const us = await repo.findNearestWithLivekit('us');
      expect(us?.livekit?.wsUrl).toBe('ws://us-box');

      // APAC viewer: the apac node has no livekit → fall back to ANY livekit
      // node (a far box beats no box). Must be one of the two livekit boxes.
      const apac = await repo.findNearestWithLivekit('apac');
      expect(apac).not.toBeNull();
      expect(apac?.livekit).not.toBeNull();
      expect(['ws://us-box', 'ws://eu-box']).toContain(apac?.livekit?.wsUrl);

      // Region-blind (null) → any livekit node (today's behavior).
      const any = await repo.findNearestWithLivekit(null);
      expect(any?.livekit).not.toBeNull();
    });

    it('a revoked home-region node is skipped → falls back to a live node', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });

      // A US livekit node (live) + a UK... use a distinct region with a REVOKED
      // livekit node: findNearest(region) must not return the revoked one.
      const live = await repo.register({
        publicKeyBase64Url: pk(),
        displayName: `live-us-${randomUUID().slice(0, 8)}`,
        region: 'us',
        hardwareClass: 'm2pro',
        nodeId: `test-node-${randomUUID()}`,
      });
      seededIds.push(live.id);
      await repo.setLivekitCredentials({
        nodeId: live.id,
        apiKey: 'key-us-live',
        apiSecretCiphertextBase64: 'ct',
        wsUrl: 'ws://us-live',
      });

      const revokedRegion = `eu-rev-${randomUUID().slice(0, 8)}`;
      const revoked = await repo.register({
        publicKeyBase64Url: pk(),
        displayName: `revoked-${randomUUID().slice(0, 8)}`,
        region: revokedRegion,
        hardwareClass: 'm2pro',
        nodeId: `test-node-${randomUUID()}`,
      });
      seededIds.push(revoked.id);
      await repo.setLivekitCredentials({
        nodeId: revoked.id,
        apiKey: 'key-revoked',
        apiSecretCiphertextBase64: 'ct',
        wsUrl: 'ws://revoked',
      });
      await repo.revoke({ nodeId: revoked.id, reason: 'test' });

      // A viewer in the revoked node's region must NOT get the revoked node —
      // it falls back to a live livekit node elsewhere.
      const got = await repo.findNearestWithLivekit(revokedRegion);
      expect(got).not.toBeNull();
      expect(got?.livekit?.wsUrl).not.toBe('ws://revoked');
    });
  },
);
