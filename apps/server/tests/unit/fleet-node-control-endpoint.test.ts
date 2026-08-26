// Fleet-admin (§A5) — POST /v1/mac-nodes/:id/control. Admin-scoped node control
// (cordon/uncordon/drain/restart) delivered over the node's WSS via the
// controlCommand frame. Direct route registration against a stub Fastify with a
// fake repo + fake control registry (the prod path is gated on a Drizzle repo).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import type { AdminAuditService, NewAdminAuditLogInput } from '../../src/services/admin-audit.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeRepo(opts?: { unknownNode?: boolean }): DrizzleFleetNodesRepo {
  return {
    getDetail: (nodeId: string) =>
      Promise.resolve(opts?.unknownNode === true ? null : { id: nodeId, nodeId: 'mac-node-01' }),
  } as unknown as DrizzleFleetNodesRepo;
}

function fakeRegistry(opts?: { connected?: boolean }): {
  registry: FleetControlRegistry;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const conn = { sendControlCommand: (cmd: unknown) => sent.push(cmd) };
  const registry = {
    get: () => (opts?.connected === false ? undefined : conn),
  } as unknown as FleetControlRegistry;
  return { registry, sent };
}

async function buildHarness(deps: {
  repo: DrizzleFleetNodesRepo;
  controlRegistry?: FleetControlRegistry;
  adminAudit?: AdminAuditService;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = { account: { id: 'acc_test' }, apiKey: { id: 'apk_test' } };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerMacNodesRoutes(app, {
    repo: deps.repo,
    encryptionKey: ENCRYPTION_KEY,
    now: () => new Date('2026-05-18T12:00:00Z'),
    ...(deps.controlRegistry !== undefined ? { controlRegistry: deps.controlRegistry } : {}),
    ...(deps.adminAudit !== undefined ? { adminAudit: deps.adminAudit } : {}),
  });
  await app.ready();
  return app;
}

const NODE = randomUUID();

describe('POST /v1/mac-nodes/:id/control — fleet-admin node control', () => {
  it('delivers the controlCommand frame to the connected node → 202', async () => {
    const { registry, sent } = fakeRegistry();
    const app = await buildHarness({ repo: fakeRepo(), controlRegistry: registry });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'drain', reason: 'rolling restart' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ command: string; accepted: boolean }>()).toMatchObject({
      command: 'drain',
      accepted: true,
    });
    expect(sent).toEqual([{ type: 'controlCommand', command: 'drain', reason: 'rolling restart' }]);
    await app.close();
  });

  it('records a mac_node.control admin-audit row (command + reason, never a secret)', async () => {
    const { registry } = fakeRegistry();
    const records: NewAdminAuditLogInput[] = [];
    const adminAudit = {
      record: (input: NewAdminAuditLogInput) => {
        records.push(input);
        return Promise.resolve({ id: 'aal_t' } as never);
      },
      list: () => Promise.resolve({ items: [], nextCursor: null }),
    } as unknown as AdminAuditService;
    const app = await buildHarness({ repo: fakeRepo(), controlRegistry: registry, adminAudit });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'drain', reason: 'maintenance' },
    });
    expect(res.statusCode).toBe(202);
    expect(records).toHaveLength(1);
    const row = records[0]!;
    expect(row.action).toBe('mac_node.control');
    expect(row.targetResourceId).toBe(`mac_node_${NODE}`);
    expect(row.inputPayload).toEqual({ command: 'drain', reason: 'maintenance' });
    expect(row.result).toBe('success');
    await app.close();
  });

  it('503 when the control plane is not enabled (no registry)', async () => {
    const app = await buildHarness({ repo: fakeRepo() }); // no controlRegistry
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'cordon' },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('404 for an unknown node', async () => {
    const { registry } = fakeRegistry();
    const app = await buildHarness({
      repo: fakeRepo({ unknownNode: true }),
      controlRegistry: registry,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'cordon' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('409 when the node has no live connection', async () => {
    const { registry } = fakeRegistry({ connected: false });
    const app = await buildHarness({ repo: fakeRepo(), controlRegistry: registry });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'restart' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  // V-1722 — the OTHER way delivery fails, and the one that used to answer 5xx.
  // `registry.get()` proving a connection existed does not prove the send will
  // land: the socket can close in the window since, and `sendFleetFrame` refuses
  // outright once the outbound buffer passes FLEET_WS_MAX_BUFFERED_BYTES. Both
  // are the node being unreachable — the same condition the arm above answers
  // 409 for — and an unreachable worker is not this server erroring. The throw
  // used to escape to Fastify, so an admin saw 500 for a 409 situation.
  it('409, not 500, when the connection exists but the transport send refuses', async () => {
    const registry = {
      get: () => ({
        sendControlCommand: () => {
          throw new Error('fleet control socket outbound buffer capacity exceeded');
        },
      }),
    } as unknown as FleetControlRegistry;
    const app = await buildHarness({ repo: fakeRepo(), controlRegistry: registry });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'restart' },
    });
    expect(res.statusCode, 'a node that cannot be reached is not a server error').toBe(409);
    await app.close();
  });

  it('400 on an unknown command + on a non-uuid id', async () => {
    const { registry } = fakeRegistry();
    const app = await buildHarness({ repo: fakeRepo(), controlRegistry: registry });
    const badCmd = await app.inject({
      method: 'POST',
      url: `/v1/mac-nodes/${NODE}/control`,
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'nuke' },
    });
    expect(badCmd.statusCode).toBe(400);
    const badId = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/not-a-uuid/control',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: { command: 'cordon' },
    });
    expect(badId.statusCode).toBe(400);
    await app.close();
  });
});
