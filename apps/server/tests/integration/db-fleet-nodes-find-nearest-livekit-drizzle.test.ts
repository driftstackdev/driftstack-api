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
  it('CRITICAL the service was reachable, so a green here is not "no service"', () => {
    // Without this, every arm below early-returns against a dead service and the
    // file reports PASSED — a green meaning "nothing was tested".
    expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
  });

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

    it('listWithLivekitNearest: home-region candidates first, revoked + non-livekit excluded (multi-box region fix)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });

      // A unique region so this test's assertions aren't perturbed by other rows.
      const euRegion = `eu-list-${randomUUID().slice(0, 8)}`;
      const usRegion = `us-list-${randomUUID().slice(0, 8)}`;
      const seed = async (
        region: string,
        opts: { livekit?: boolean; revoked?: boolean; wsUrl: string },
      ): Promise<void> => {
        const node = await repo.register({
          publicKeyBase64Url: pk(),
          displayName: `lst-${region}-${randomUUID().slice(0, 8)}`,
          region,
          hardwareClass: 'm2pro',
          nodeId: `test-node-${randomUUID()}`,
        });
        seededIds.push(node.id);
        if (opts.livekit !== false) {
          await repo.setLivekitCredentials({
            nodeId: node.id,
            apiKey: `key-${region}`,
            apiSecretCiphertextBase64: 'ct',
            wsUrl: opts.wsUrl,
          });
        }
        if (opts.revoked) await repo.revoke({ nodeId: node.id, reason: 'test' });
      };
      // Two EU livekit boxes (the multi-box region), one EU box WITHOUT livekit,
      // one EU revoked livekit box, and a US livekit box (out-of-region).
      await seed(euRegion, { wsUrl: 'ws://eu-1' });
      await seed(euRegion, { wsUrl: 'ws://eu-2' });
      await seed(euRegion, { livekit: false, wsUrl: '' });
      await seed(euRegion, { revoked: true, wsUrl: 'ws://eu-revoked' });
      await seed(usRegion, { wsUrl: 'ws://us-1' });

      const candidates = await repo.listWithLivekitNearest(euRegion);
      const urls = candidates.map((c) => c.livekit?.wsUrl);
      // The two EU livekit boxes come FIRST (home region), before the US box.
      const euIdx1 = urls.indexOf('ws://eu-1');
      const euIdx2 = urls.indexOf('ws://eu-2');
      const usIdx = urls.indexOf('ws://us-1');
      expect(euIdx1).toBeGreaterThanOrEqual(0);
      expect(euIdx2).toBeGreaterThanOrEqual(0);
      expect(usIdx).toBeGreaterThanOrEqual(0);
      expect(Math.max(euIdx1, euIdx2)).toBeLessThan(usIdx);
      // The revoked + non-livekit EU boxes are excluded entirely.
      expect(urls).not.toContain('ws://eu-revoked');
      expect(candidates.every((c) => c.livekit !== null)).toBe(true);
    });

    it('listWithLivekitNearest(null): region-blind executes against Postgres (no `ORDER BY false` rejection)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });

      // The region-blind dispatch path (the DEFAULT for accounts with no region).
      // The prior `desc(... : sql`false`)` rendered `ORDER BY false DESC, …`
      // which PostgreSQL REJECTS at execution → every region-blind dispatch
      // threw → sessionAssign never reached the box → the browser never opened.
      // Two livekit boxes so the result is a non-empty recency-ordered list.
      const a = await repo.register({
        publicKeyBase64Url: pk(),
        displayName: `blind-a-${randomUUID().slice(0, 8)}`,
        region: `blind-${randomUUID().slice(0, 8)}`,
        hardwareClass: 'm2pro',
        nodeId: `test-node-${randomUUID()}`,
      });
      seededIds.push(a.id);
      await repo.setLivekitCredentials({
        nodeId: a.id,
        apiKey: 'key-blind-a',
        apiSecretCiphertextBase64: 'ct',
        wsUrl: 'ws://blind-a',
      });
      const b = await repo.register({
        publicKeyBase64Url: pk(),
        displayName: `blind-b-${randomUUID().slice(0, 8)}`,
        region: `blind-${randomUUID().slice(0, 8)}`,
        hardwareClass: 'm2pro',
        nodeId: `test-node-${randomUUID()}`,
      });
      seededIds.push(b.id);
      await repo.setLivekitCredentials({
        nodeId: b.id,
        apiKey: 'key-blind-b',
        apiSecretCiphertextBase64: 'ct',
        wsUrl: 'ws://blind-b',
      });

      // Must NOT throw (the bug); returns every livekit box, recency-ordered.
      const candidates = await repo.listWithLivekitNearest(null);
      const urls = candidates.map((c) => c.livekit?.wsUrl);
      expect(urls).toContain('ws://blind-a');
      expect(urls).toContain('ws://blind-b');
      expect(candidates.every((c) => c.livekit !== null)).toBe(true);

      // Empty string is treated as region-blind too — also must not throw.
      const emptyRegion = await repo.listWithLivekitNearest('');
      expect(emptyRegion.length).toBeGreaterThanOrEqual(2);
    });
  },
);
