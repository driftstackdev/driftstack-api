// Arc 7 obs.16 — `driftstack_mac_node_livekit_register_total{outcome}`
// counter emitted by POST /v1/mac-nodes/register. Sweeps the 4 typed
// outcome paths (ok / validation / not_found / encryption_error)
// against a real Fastify instance + stub repo so the bump-call lands
// at the correct point in the route flow.
//
// Companion to lk2-mac-nodes-register-audit-emit.test.ts which pins
// the audit-row emission on the success path. This file pins the
// per-call metric counter independently — the two surfaces increment
// on different conditions (audit fires only on `ok`; metric fires on
// every outcome).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { METRIC_NAMES, MetricsRegistry } from '../../src/services/metrics-registry.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.macNodeLivekitRegisterTotal, 'LK.2 register outcomes', [
    'outcome',
  ]);
  return m;
}

function fakeRepo(): { repo: DrizzleFleetNodesRepo; nodeId: string } {
  const nodeId = randomUUID();
  const repo = {
    setLivekitCredentials: (args: {
      nodeId: string;
      apiKey: string;
      apiSecretCiphertextBase64: string;
      wsUrl: string;
      registeredAt: Date;
    }) => {
      if (args.nodeId !== nodeId) return Promise.resolve(null);
      return Promise.resolve({
        id: args.nodeId,
        publicKeyBase64Url: 'pk_test',
        displayName: 'Mac mini test',
        region: 'eu-central',
        hardwareClass: 'mac_mini_m4',
        registeredAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: null,
        revokedAt: null,
        revocationReason: null,
        livekit: {
          apiKey: args.apiKey,
          apiSecretCiphertextBase64: args.apiSecretCiphertextBase64,
          wsUrl: args.wsUrl,
          registeredAt: args.registeredAt,
        },
      });
    },
  } as unknown as DrizzleFleetNodesRepo;
  return { repo, nodeId };
}

async function buildHarness(opts: {
  repo: DrizzleFleetNodesRepo;
  metrics: MetricsRegistry;
  encryptionKey?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = {
      account: { id: 'acc_test' },
      apiKey: { id: 'apk_test' },
    };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerMacNodesRoutes(app, {
    repo: opts.repo,
    encryptionKey: opts.encryptionKey ?? ENCRYPTION_KEY,
    metrics: opts.metrics,
  });
  await app.ready();
  return app;
}

function readCount(metrics: MetricsRegistry, outcome: string): number {
  const lines = metrics.render().split('\n');
  const match = lines.find((line) =>
    line.startsWith(`${METRIC_NAMES.macNodeLivekitRegisterTotal}{outcome="${outcome}"}`),
  );
  if (!match) return 0;
  const parts = match.split(' ');
  return Number(parts[parts.length - 1]) || 0;
}

describe('Arc 7 obs.16 — mac_node_livekit_register_total counter', () => {
  it('outcome="ok" on a successful register', async () => {
    const metrics = makeRegistry();
    const { repo, nodeId } = fakeRepo();
    const app = await buildHarness({ repo, metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-100.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(readCount(metrics, 'ok')).toBe(1);
    // None of the reject paths should have fired.
    expect(readCount(metrics, 'validation')).toBe(0);
    expect(readCount(metrics, 'not_found')).toBe(0);
    expect(readCount(metrics, 'encryption_error')).toBe(0);
    await app.close();
  });

  it('outcome="validation" when body fails the Zod parse', async () => {
    const metrics = makeRegistry();
    const { repo } = fakeRepo();
    const app = await buildHarness({ repo, metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        // missing required mac_node_id → ValidationError
        livekit: { api_key: 'x', api_secret: 'y', ws_url: 'wss://m.example/' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(readCount(metrics, 'validation')).toBe(1);
    expect(readCount(metrics, 'ok')).toBe(0);
    await app.close();
  });

  it('outcome="not_found" when mac_node_id is well-formed but not in fleet_nodes', async () => {
    const metrics = makeRegistry();
    const { repo } = fakeRepo();
    const app = await buildHarness({ repo, metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        // Different UUID from the one the fake repo accepts → null → 404.
        mac_node_id: randomUUID(),
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-101.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(readCount(metrics, 'not_found')).toBe(1);
    expect(readCount(metrics, 'ok')).toBe(0);
    await app.close();
  });

  it('outcome="encryption_error" when the encryption key is malformed (wrong length)', async () => {
    const metrics = makeRegistry();
    const { repo, nodeId } = fakeRepo();
    // 16-byte key instead of 32-byte AES-256 — encryptLivekitSecret throws.
    const app = await buildHarness({
      repo,
      metrics,
      encryptionKey: Buffer.alloc(16, 0).toString('base64'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-102.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(readCount(metrics, 'encryption_error')).toBe(1);
    expect(readCount(metrics, 'ok')).toBe(0);
    await app.close();
  });

  it('counter bumps are independent — three calls land three increments', async () => {
    const metrics = makeRegistry();
    const { repo, nodeId } = fakeRepo();
    const app = await buildHarness({ repo, metrics });
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/mac-nodes/register',
        headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
        payload: {
          mac_node_id: nodeId,
          livekit: {
            api_key: 'APItest123',
            api_secret: 'secrettest456',
            ws_url: `wss://mac-103-${i.toString()}.driftstack.dev:8443`,
          },
        },
      });
    }
    expect(readCount(metrics, 'ok')).toBe(3);
    await app.close();
  });
});
