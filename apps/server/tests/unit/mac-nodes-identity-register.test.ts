// V-820 fleet-node IDENTITY registration — POST /v1/mac-nodes. The prod path
// the worker-cp-connect-readiness §2 blocker calls for (was: only a local seed
// script). Admin-scoped; mints the fleet_nodes row by the node's Ed25519 public
// key and returns the minted uuid (→ DRIFTSTACK_MAC_NODE_ID on the daemon).
//
// Mirrors lk2-mac-nodes-register-audit-emit.test.ts: direct route registration
// against a stub Fastify with a fake repo + stub auth decorators (the prod path
// is gated on a Drizzle repo).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const VALID_PUBKEY = 'A'.repeat(43) + '='; // 43 base64url chars + '=' (matches the DB CHECK)

function fakeRepo(opts?: { duplicate?: boolean }): {
  repo: DrizzleFleetNodesRepo;
  mintedId: string;
} {
  const mintedId = randomUUID();
  const repo = {
    register: (args: {
      nodeId?: string;
      publicKeyBase64Url: string;
      displayName: string;
      region: string;
      hardwareClass: string;
    }) => {
      if (opts?.duplicate) {
        const err = new Error('duplicate key value violates unique constraint') as Error & {
          code?: string;
        };
        err.code = '23505';
        return Promise.reject(err);
      }
      return Promise.resolve({
        id: mintedId,
        nodeId: args.nodeId ?? null,
        publicKeyBase64Url: args.publicKeyBase64Url,
        displayName: args.displayName,
        region: args.region,
        hardwareClass: args.hardwareClass,
        registeredAt: new Date('2026-05-18T12:00:00Z'),
        lastSeenAt: null,
        lastHeartbeat: null,
        revokedAt: null,
        revocationReason: null,
        livekit: null,
      });
    },
  } as unknown as DrizzleFleetNodesRepo;
  return { repo, mintedId };
}

async function buildHarness(repo: DrizzleFleetNodesRepo): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = { account: { id: 'acc_test' }, apiKey: { id: 'apk_test' } };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerMacNodesRoutes(app, {
    repo,
    encryptionKey: ENCRYPTION_KEY,
    now: () => new Date('2026-05-18T12:00:00Z'),
  });
  await app.ready();
  return app;
}

describe('V-820 POST /v1/mac-nodes — fleet-node identity registration', () => {
  it('mints the fleet_nodes row + returns the minted uuid (→ DRIFTSTACK_MAC_NODE_ID)', async () => {
    const { repo, mintedId } = fakeRepo();
    const app = await buildHarness(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        node_id: 'mac-macstadium-us-001',
        public_key_base64url: VALID_PUBKEY,
        display_name: 'mac-macstadium-us-001',
        region: 'us-east-1',
        hardware_class: 'mac-mini-m2pro',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      mac_node_id: string;
      node_id: string;
      public_key_base64url: string;
      display_name: string;
      region: string;
      hardware_class: string;
      registered_at: string;
    }>();
    expect(body.mac_node_id).toBe(mintedId);
    expect(body.node_id).toBe('mac-macstadium-us-001');
    expect(body.public_key_base64url).toBe(VALID_PUBKEY);
    expect(body.display_name).toBe('mac-macstadium-us-001');
    expect(body.region).toBe('us-east-1');
    expect(body.hardware_class).toBe('mac-mini-m2pro');
    expect(typeof body.registered_at).toBe('string');
    await app.close();
  });

  it('duplicate public key (unique-violation 23505) → 400, not 500', async () => {
    const { repo } = fakeRepo({ duplicate: true });
    const app = await buildHarness(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        node_id: 'mac-macstadium-us-001',
        public_key_base64url: VALID_PUBKEY,
        display_name: 'dup',
        region: 'us-east-1',
        hardware_class: 'mac-mini-m2pro',
      },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json<{ detail?: string; message?: string }>();
    expect(err.detail ?? err.message ?? '').toMatch(/already registered/i);
    await app.close();
  });

  it('invalid public key (not base64url) → 400 validation, never reaches the repo', async () => {
    const { repo } = fakeRepo();
    const app = await buildHarness(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        node_id: 'mac-macstadium-us-001',
        public_key_base64url: 'not valid base64url!!',
        display_name: 'x',
        region: 'us-east-1',
        hardware_class: 'mac-mini-m2pro',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
