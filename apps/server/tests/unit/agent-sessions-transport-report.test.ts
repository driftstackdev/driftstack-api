// ICE.T — POST /v1/agent-sessions/:id/transport-report unit tests.
// Sweeps the auth + ownership + validation paths against a stubbed
// Fastify instance — no Drizzle DB required. Mirrors the livekit-token
// route tests' harness (stub auth plugin, onRequest ctx with teams:[]).
//
// The route STRUCTURED-LOGS the report (no DB, no table); a capturing
// logger asserts the `ice-transport-telemetry` line is emitted with the
// parsed fields on the happy path.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes } from 'node:crypto';
import {
  registerAgentSessionsTransportReportRoute,
  transportReportBodySchema,
} from '../../src/routes/agent-sessions-transport-report.js';
import { encryptGuiControlKey } from '../../src/lib/gui-control-key-encryption.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';

const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

const ACCOUNT_ID = 'acc_icet_owner';
const OTHER_ACCOUNT_ID = 'acc_other';
const SESSION_ID = 'agt_11111111-2222-3333-4444-555555555555';
const CONTROL_KEY = 'gck_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

function makeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    driftstackSessionId: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 99_000,
    closedReason: null,
    idempotencyKey: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: null,
    profileId: null,
    createdAt: new Date('2026-05-18T12:00:00Z'),
    updatedAt: new Date('2026-05-18T12:00:00Z'),
    ...overrides,
  };
}

function makeStubAgentSessionsRepo(session: AgentSessionRecord | null): AgentSessionsRepo {
  return {
    get: () => Promise.resolve(session),
  } as unknown as AgentSessionsRepo;
}

interface CapturedLog {
  obj: Record<string, unknown>;
  msg: string;
}

async function buildApp(args: {
  session: AgentSessionRecord | null;
  callerAccountId?: string;
  teams?: Array<{ ownerAccountId: string; role: 'member' | 'admin' }>;
  /** Scopes on the caller's stub API key — defaults to read:sessions granted. */
  scopes?: string[];
  /** When set, control-key auth is enabled with this encryption key. */
  guiControlKeyEncryptionKey?: string;
  /** Captured structured-log lines (route logs via req.log.info). */
  logs?: CapturedLog[];
}) {
  const app = Fastify();
  const grantedScopes = args.scopes ?? ['read', 'read:sessions'];
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: args.callerAccountId ?? ACCOUNT_ID, tier: 'starter' },
      apiKey: { id: 'key_icet', scopes: grantedScopes },
      teams: args.teams ?? [],
    };
    // Route logs via req.log.info({...}, 'msg') — capture into the array so the
    // happy-path test can assert the ice-transport-telemetry line was emitted.
    if (args.logs !== undefined) {
      const capture = args.logs;
      const stubLog = {
        info: (obj: Record<string, unknown>, msg: string): void => {
          capture.push({ obj, msg });
        },
      };
      (req as { log: typeof stubLog }).log = stubLog;
    }
    done();
  });
  await app.register(stubAuthPlugin);
  app.decorate('rateLimit', () => async () => {});
  app.decorate('requireAuth', async () => {});
  // requireScope stub: the route floors the account path at read:sessions.
  // Enforce it against the granted scopes so the least-privilege test bites.
  app.decorate('requireScope', (scope: string) => (req: FastifyRequest) => {
    const acct = (req as { account: { apiKey: { scopes: string[] } } | null }).account;
    if (acct !== null && !acct.apiKey.scopes.includes(scope)) {
      const err = new Error(`missing scope ${scope}`) as Error & { status: number };
      err.status = 403;
      throw err;
    }
  });
  registerAgentSessionsTransportReportRoute(app, {
    agentSessionsRepo: makeStubAgentSessionsRepo(args.session),
    ...(args.guiControlKeyEncryptionKey !== undefined
      ? { guiControlKeyEncryptionKey: args.guiControlKeyEncryptionKey }
      : {}),
  });
  await app.ready();
  return app;
}

const VALID_BODY = {
  transport: 'udp',
  relayed: false,
  rtt_ms: 42,
  packet_loss_recent_pct: 0.3,
  jitter_ms: 5,
  decode_fps: 30,
  freeze_count: 0,
} as const;

describe('ICE.T — POST /v1/agent-sessions/:id/transport-report', () => {
  let logs: CapturedLog[];
  beforeEach(() => {
    logs = [];
  });

  it('204 — valid report → structured-logged (no DB), no body', async () => {
    const app = await buildApp({ session: makeSession(), logs });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    // The ice-transport-telemetry line carries the parsed fields.
    const line = logs.find((l) => l.obj.component === 'ice-transport-telemetry');
    expect(line).toBeDefined();
    expect(line?.msg).toBe('agent-session transport report');
    expect(line?.obj.session_id).toBe(SESSION_ID);
    expect(line?.obj.account_id).toBe(ACCOUNT_ID);
    expect(line?.obj.transport).toBe('udp');
    expect(line?.obj.relayed).toBe(false);
    expect(line?.obj.rtt_ms).toBe(42);
    expect(line?.obj.packet_loss_recent_pct).toBe(0.3);
    expect(line?.obj.jitter_ms).toBe(5);
    expect(line?.obj.decode_fps).toBe(30);
    expect(line?.obj.freeze_count).toBe(0);
    await app.close();
  });

  it('204 — null transport/relayed/rtt (client not yet resolved) still accepted', async () => {
    const app = await buildApp({ session: makeSession(), logs });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { transport: null, relayed: null, rtt_ms: null, packet_loss_recent_pct: null },
    });
    expect(res.statusCode).toBe(204);
    const line = logs.find((l) => l.obj.component === 'ice-transport-telemetry');
    expect(line?.obj.transport).toBeNull();
    // Omitted optional fields log as null (not-reported-this-tick).
    expect(line?.obj.jitter_ms).toBeNull();
    expect(line?.obj.decode_fps).toBeNull();
    expect(line?.obj.freeze_count).toBeNull();
    await app.close();
  });

  it('204 — the softer per-frame fields are optional (older client omits them)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { transport: 'tcp', relayed: true, rtt_ms: 620, packet_loss_recent_pct: 2.1 },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('400 — unknown transport enum value', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { ...VALID_BODY, transport: 'quic' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 — rtt_ms out of bounds (negative)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { ...VALID_BODY, rtt_ms: -1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 — rtt_ms out of bounds (over max)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { ...VALID_BODY, rtt_ms: 60001 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 — packet_loss_recent_pct over 100', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { ...VALID_BODY, packet_loss_recent_pct: 100.1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 — additional (unknown) property rejected (.strict, no extra fields logged)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { ...VALID_BODY, evil: 'x'.repeat(10_000) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 — required field missing (transport)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { relayed: false, rtt_ms: 10, packet_loss_recent_pct: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('404 — malformed agent_session id (anti-enumeration cheap reject)', async () => {
    const app = await buildApp({ session: makeSession() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/not-a-valid-id/transport-report',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 — unknown session id (repo returns null)', async () => {
    const app = await buildApp({ session: null });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 — cross-account access (caller does not own the session)', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('204 — team ADMIN of the owning account can post (team-RBAC, not raw owner-equality)', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
      teams: [{ ownerAccountId: OTHER_ACCOUNT_ID, role: 'admin' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('404 — team MEMBER (non-admin) of the owning account cannot post', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
      teams: [{ ownerAccountId: OTHER_ACCOUNT_ID, role: 'member' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('403 — account path without read:sessions scope (least-privilege floor)', async () => {
    const app = await buildApp({
      session: makeSession(),
      scopes: ['read'], // no read:sessions
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('204 — valid gui_control_key authorizes the report (control-key path bypasses scope)', async () => {
    const key = makeKey();
    const session = makeSession({
      // Cross-account owner: proves the control-key path does NOT run the
      // account ownership check (the key IS the per-session credential).
      accountId: OTHER_ACCOUNT_ID,
      guiControlKeyCiphertext: encryptGuiControlKey(CONTROL_KEY, key),
      guiControlKeyExpiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildApp({
      session,
      guiControlKeyEncryptionKey: key,
      // The caller ctx would 404 on the account path (cross-account), so a 204
      // proves the control key alone authorized it.
      callerAccountId: ACCOUNT_ID,
      logs,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      headers: { 'x-driftstack-gui-control-key': CONTROL_KEY },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(204);
    const line = logs.find((l) => l.obj.component === 'ice-transport-telemetry');
    expect(line?.obj.account_id).toBe(OTHER_ACCOUNT_ID);
    await app.close();
  });

  it('401 — a PRESENTED-but-wrong gui_control_key hard-fails (never falls through to account auth)', async () => {
    const key = makeKey();
    const session = makeSession({
      guiControlKeyCiphertext: encryptGuiControlKey(CONTROL_KEY, key),
      guiControlKeyExpiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildApp({ session, guiControlKeyEncryptionKey: key });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      headers: { 'x-driftstack-gui-control-key': 'gck_WRONGWRONGWRONGWRONGWRONGWRONG12' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400 — a malformed body is rejected even before the session lookup (never logged)', async () => {
    // Unknown session AND bad body → the validation 400 wins (we validate the
    // body before the null-session 404), so a hostile client can't probe
    // session existence via the report shape.
    const app = await buildApp({ session: null, logs });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/transport-report`,
      payload: { transport: 'quic' },
    });
    expect(res.statusCode).toBe(400);
    expect(logs.find((l) => l.obj.component === 'ice-transport-telemetry')).toBeUndefined();
    await app.close();
  });

  it('schema: bounds are exactly as documented (unit-level guard on the zod shape)', () => {
    expect(transportReportBodySchema.safeParse(VALID_BODY).success).toBe(true);
    expect(transportReportBodySchema.safeParse({ ...VALID_BODY, rtt_ms: 1.5 }).success).toBe(false); // int only
    expect(transportReportBodySchema.safeParse({ ...VALID_BODY, decode_fps: 1001 }).success).toBe(
      false,
    );
    expect(transportReportBodySchema.safeParse({ ...VALID_BODY, freeze_count: -1 }).success).toBe(
      false,
    );
  });
});
