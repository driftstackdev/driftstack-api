// LK.2 — empirical proof that POST /v1/mac-nodes/register emits
// the `mac_node.livekit_registered` admin-audit row.
//
// Rule L — drift guards (`lk2-mac-nodes-audit-parity.test.ts`) pin
// the WIRING. This unit test pins the BEHAVIOUR: when an operator
// registers credentials, the AdminAuditService.record() call lands
// with the LK.2 action + the non-sensitive payload (ws_url +
// mac_node_id only; never api_key / api_secret / ciphertext).
//
// We don't go through the build-test-app fixture because the LK.2
// route is gated on `drizzleFleetNodesRepo !== undefined` in app.ts
// and the fixture intentionally uses InMemoryFleetNodesRepo. Direct
// route registration against a stub Fastify with a fake repo +
// stub auth decorators exercises the route handler in isolation,
// which is the surface we care about.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { AdminAuditService, NewAdminAuditLogInput } from '../../src/services/admin-audit.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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

function fakeAuditCollector(): {
  audit: AdminAuditService;
  records: NewAdminAuditLogInput[];
} {
  const records: NewAdminAuditLogInput[] = [];
  const audit = {
    record: (input: NewAdminAuditLogInput) => {
      records.push(input);
      return Promise.resolve({
        id: 'aal_test',
        adminAccountId: input.adminAccountId,
        adminKeyId: input.adminKeyId,
        action: input.action,
        targetAccountId: input.targetAccountId ?? null,
        targetResourceId: input.targetResourceId ?? null,
        inputPayload: input.inputPayload ?? null,
        result: input.result,
        ipAddress: input.ipAddress ?? null,
        timestamp: new Date('2026-05-18T00:00:00Z'),
      });
    },
    list: () => Promise.resolve({ items: [], nextCursor: null }),
  } as unknown as AdminAuditService;
  return { audit, records };
}

async function buildHarness(opts: {
  repo: DrizzleFleetNodesRepo;
  adminAudit?: AdminAuditService;
  authedAccountId?: string;
  authedApiKeyId?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  // Fake auth decorators — accept any caller + populate req.account
  // with a deterministic test context. The route's audit-emit guard
  // checks `req.account` truthiness; a real requireAuth would set
  // this via authResolve in the prod path.
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = {
      account: { id: opts.authedAccountId ?? 'acc_test' },
      apiKey: { id: opts.authedApiKeyId ?? 'apk_test' },
    };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerMacNodesRoutes(app, {
    repo: opts.repo,
    encryptionKey: ENCRYPTION_KEY,
    now: () => new Date('2026-05-18T12:00:00Z'),
    ...(opts.adminAudit !== undefined ? { adminAudit: opts.adminAudit } : {}),
  });
  await app.ready();
  return app;
}

describe('LK.2 POST /v1/mac-nodes/register — admin-audit emission', () => {
  it('emits mac_node.livekit_registered row on successful register', async () => {
    const { repo, nodeId } = fakeRepo();
    const { audit, records } = fakeAuditCollector();
    const app = await buildHarness({ repo, adminAudit: audit });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-001.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(records).toHaveLength(1);
    const row = records[0]!;
    expect(row.action).toBe('mac_node.livekit_registered');
    expect(row.adminAccountId).toBe('acc_test');
    expect(row.adminKeyId).toBe('apk_test');
    expect(row.targetResourceId).toBe(`mac_node_${nodeId}`);
    expect(row.result).toBe('success');
    await app.close();
  });

  it('audit payload carries ws_url but NEVER the api_key / api_secret / ciphertext', async () => {
    const { repo, nodeId } = fakeRepo();
    const { audit, records } = fakeAuditCollector();
    const app = await buildHarness({ repo, adminAudit: audit });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APIkey_must_not_leak',
          api_secret: 'APIsecret_must_not_leak',
          ws_url: 'wss://mac-002.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const row = records[0]!;
    expect(row.inputPayload).toEqual({ ws_url: 'wss://mac-002.driftstack.dev:8443' });
    // Belt-and-suspenders: the full audit-row JSON serialisation
    // must NOT contain the plaintext secret material anywhere
    // (including stringified ciphertext envelopes).
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('APIkey_must_not_leak');
    expect(serialised).not.toContain('APIsecret_must_not_leak');
  });

  // The response twin of the arm above. The audit row was guarded; the HTTP
  // body was not — no test asserted this route's 200 body at all (the
  // activation-gate file only exercises 404s, and the metrics/audit files read
  // counters and audit rows). The route's own comment states the contract:
  //
  //   Response is intentionally minimal — never echoes the api_key
  //   (treated as secret-equivalent per the orchestrator brief)
  //   and obviously never echoes the api_secret.
  //
  // The credentials arrive in the REQUEST, so echoing them back is the easy
  // regression: any move to reply with the accepted body, or with the stored
  // node record, hands a live LiveKit key straight back over the wire and into
  // whatever logs that response. Pinning the exact key set is what catches a
  // field arriving that nobody deliberately added.
  it('the 200 response is minimal and echoes neither the api_key nor the api_secret', async () => {
    const { repo, nodeId } = fakeRepo();
    const app = await buildHarness({ repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APIkey_must_not_leak',
          api_secret: 'APIsecret_must_not_leak',
          ws_url: 'wss://mac-003.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.body,
      'the register response echoed the LiveKit api_key back to the caller — it is treated as ' +
        'secret-equivalent, and a response is exactly what ends up in proxy and client logs',
    ).not.toContain('APIkey_must_not_leak');
    expect(res.body, 'the register response echoed the LiveKit api_secret').not.toContain(
      'APIsecret_must_not_leak',
    );
    expect(
      Object.keys(res.json<Record<string, unknown>>()).sort(),
      'the response grew a field the route was not written to return',
    ).toEqual(['livekit_registered_at', 'mac_node_id', 'ws_url']);
    await app.close();
  });

  it('NO audit emission when adminAudit dep is absent (back-compat)', async () => {
    const { repo, nodeId } = fakeRepo();
    const app = await buildHarness({ repo }); // no adminAudit
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-003.driftstack.dev:8443',
        },
      },
    });
    // The route still succeeds — credentials are persisted even
    // without audit wiring (best-effort emission is a soft layer).
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('audit emission is swallowed when AdminAuditService.record throws (best-effort)', async () => {
    const { repo, nodeId } = fakeRepo();
    const records: NewAdminAuditLogInput[] = [];
    const throwingAudit = {
      record: (input: NewAdminAuditLogInput) => {
        records.push(input); // we still observe the call
        return Promise.reject(new Error('audit db unavailable'));
      },
      list: () => Promise.resolve({ items: [], nextCursor: null }),
    } as unknown as AdminAuditService;
    const app = await buildHarness({ repo, adminAudit: throwingAudit });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-004.driftstack.dev:8443',
        },
      },
    });
    // Best-effort guarantee: a failing audit insert does NOT revert
    // the already-persisted credentials nor 5xx the route. The
    // operator gets a 200 + the row is in the DB; audit-replay can
    // be re-emitted from the credential timestamps if needed.
    expect(res.statusCode).toBe(200);
    expect(records).toHaveLength(1); // attempted exactly once
    await app.close();
  });

  it('mac_node not found → 404 + NO audit emission (no targetResource exists)', async () => {
    const { repo } = fakeRepo();
    const { audit, records } = fakeAuditCollector();
    const app = await buildHarness({ repo, adminAudit: audit });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        // Different UUID from the one the fake repo accepts → null
        // result → route throws NotFoundError → 404. The audit emit
        // sits AFTER the null check, so it should NOT fire.
        mac_node_id: randomUUID(),
        livekit: {
          api_key: 'APItest123',
          api_secret: 'secrettest456',
          ws_url: 'wss://mac-005.driftstack.dev:8443',
        },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(records).toHaveLength(0);
    await app.close();
  });
});
