// A frame refused for its size is logged once — not again by its caller.
//
// When a control-plane → device frame is larger than the device reads, the
// device frame guard refuses it before the socket and logs ONE WARN line with
// the frame's type, its size, the limit, the device and the session. The frame
// is never sent. The callers that send fire-and-forget frames (sessionAssign,
// sessionEnd, resumeSession, controlCommand) each also had their own generic
// "send failed" WARN, written for closed sockets and full queues, so a refusal
// used to come out as two WARN lines for one event.
//
// Each arm drives a real caller over a real FleetControlRegistry whose device
// has advertised a small `maxInboundFrameBytes`, with the guard and the caller
// logging into the same place, and checks that the refusal is the only WARN.
// The callers keep their WARN for every other failure — the arms that make the
// raw socket throw check that.

import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import type { Logger } from '../../src/lib/logger.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import {
  dispatchResumeSession,
  dispatchSessionAssignOnCreate,
  dispatchSessionEndOnClose,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { reconcileWorkerReportedOrphans } from '../../src/services/cp-daemon-reconcile.js';
import {
  FleetControlRegistry,
  type FleetControlConnection,
} from '../../src/services/fleet-control-registry.js';
import { serializeSessionEnd } from '../../src/services/harness-control-codec.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-dev-001';
const NODE_UUID = '11111111-1111-4111-8111-111111111111';
/** The 64 KiB margin the guard takes off every advertised value. */
const MARGIN = 64 * 1024;

const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'regular',
  initialUrl: 'https://example.com',
  proxy: { host: '127.0.0.1', port: 1080, udp_associate: true, require_remote_dns: false },
};

interface Line {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
  readonly msg: string;
}

/** One log sink for the guard (through the registry) and the caller alike. */
function sink(): { lines: Line[]; logger: Logger } {
  const lines: Line[] = [];
  const record =
    (level: Line['level']) =>
    (fields: unknown, msg?: unknown): void => {
      lines.push({
        level,
        fields: (typeof fields === 'object' && fields !== null ? fields : {}) as Record<
          string,
          unknown
        >,
        msg: typeof msg === 'string' ? msg : '',
      });
    };
  const noop = (): void => {};
  const logger = {
    level: 'info',
    info: record('info'),
    warn: record('warn'),
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  return { lines, logger: logger as unknown as Logger };
}

const warns = (lines: readonly Line[]): Line[] => lines.filter((l) => l.level === 'warn');
const refusals = (lines: readonly Line[]): Line[] =>
  warns(lines).filter((l) => l.fields.event === 'outbound_frame_refused');
/** Each WARN as its event name, or its message when it has none. */
const warnings = (lines: readonly Line[]): unknown[] =>
  warns(lines).map((l) => l.fields.event ?? l.msg);

function registryLoggingTo(logger: Logger): FleetControlRegistry {
  return new FleetControlRegistry(
    undefined, // onProfileSaved
    undefined, // onChallengeDetected
    undefined, // onPageState
    undefined, // onProfileSaveFailed
    undefined, // onHeartbeat
    undefined, // onNodeRegistered
    undefined, // onNodeDisconnected
    undefined, // onSessionStatus
    logger,
  );
}

/** The device's heartbeat, advertising what it reads. */
function advertise(conn: FleetControlConnection, nodeId: string, maxInboundFrameBytes: number) {
  conn.handleInbound(
    JSON.stringify({
      type: 'heartbeat',
      macNodeId: nodeId,
      timestamp: '2026-09-25T00:00:00Z',
      cpuPercent: 1,
      memoryPercent: 1,
      activeSessionCount: 0,
      maxInboundFrameBytes,
    }),
  );
}

function macWithLivekit() {
  const apiKey = 'devkey';
  const wsUrl = 'ws://localhost:7880';
  return {
    id: NODE_UUID,
    nodeId: NODE_ID,
    publicKeyBase64Url: 'pk',
    registeredAt: new Date(),
    revokedAt: null,
    livekit: {
      apiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret('secret', KEY, {
        nodeId: NODE_UUID,
        apiKey,
        wsUrl,
      }),
      wsUrl,
      registeredAt: new Date(),
    },
  };
}

function nodesRepo(): DrizzleFleetNodesRepo {
  const mac = macWithLivekit();
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
    findNearestWithLivekit: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;
}

const frameType = (data: string): string => (JSON.parse(data) as { type: string }).type;

describe('a frame refused for its size is logged once, not again by its caller', () => {
  it('CRITICAL a refused sessionAssign: the guard’s line names the session, and the dispatch adds no WARN of its own', async () => {
    const { lines, logger } = sink();
    const sent: string[] = [];
    const registry = registryLoggingTo(logger);
    const conn = registry.register(NODE_ID, (data) => sent.push(data));
    // Room for a sessionEnd (~70 bytes) but not for an assign (a LiveKit token alone is more).
    advertise(conn, NODE_ID, MARGIN + 256);
    const sessions = new InMemoryAgentSessionsRepo();
    const created = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });

    await dispatchSessionAssignOnCreate({
      ownerTier: 'api_builder',
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: nodesRepo(),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      agentSessions: sessions,
      logger,
    });

    expect(sent.map(frameType), 'the assign was refused; the teardown was not').toEqual([
      'sessionEnd',
    ]);
    expect(warnings(lines), 'the refusal was logged more than once').toEqual([
      'outbound_frame_refused',
    ]);
    expect(refusals(lines)[0]?.fields).toMatchObject({
      frameType: 'sessionAssign',
      nodeId: NODE_ID,
      sessionId: created.id,
      limitBytes: 256,
    });
    expect(await sessions.get(created.id)).toMatchObject({
      status: 'closed',
      closedReason: 'dispatch_failed',
    });
  });

  it('CRITICAL a refused dispatch-failure teardown adds no WARN beyond the guard’s — and stays queued for the reconnect', async () => {
    const { lines, logger } = sink();
    const registry = registryLoggingTo(logger);
    const conn: FleetControlConnection = registry.register(NODE_ID, (data) => {
      if (frameType(data) === 'sessionAssign') {
        // The device's limit drops to nothing between the assign and its teardown.
        advertise(conn, NODE_ID, MARGIN);
        throw new Error('socket write failed after ambiguous delivery');
      }
    });
    const sessions = new InMemoryAgentSessionsRepo();
    const created = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });

    await dispatchSessionAssignOnCreate({
      ownerTier: 'api_builder',
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: nodesRepo(),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      agentSessions: sessions,
      logger,
    });

    expect(refusals(lines).map((l) => l.fields.frameType)).toEqual(['sessionEnd']);
    expect(
      warns(lines).map((l) => l.msg),
      'the refused teardown was logged twice',
    ).not.toContain(
      'immediate dispatch-failure teardown failed; queued bounded sessionEnd for reconnect',
    );
    // The socket's own failure is not a refusal, and keeps its WARN.
    expect(warns(lines).map((l) => l.msg)).toContain(
      'sessionAssign dispatch failed (session create unaffected)',
    );
    expect(warns(lines)).toHaveLength(2);
    expect(registry.pendingTeardownCount(NODE_ID)).toBe(1);
  });

  it('CRITICAL a refused sessionEnd on close adds no WARN beyond the guard’s — and stays queued for the reconnect', async () => {
    const { lines, logger } = sink();
    const registry = registryLoggingTo(logger);
    const conn = registry.register(NODE_ID, () => undefined);
    advertise(conn, NODE_ID, MARGIN);

    await dispatchSessionEndOnClose({
      sessionId: 'agt_close_refused',
      nodeId: NODE_ID,
      fleetControlRegistry: registry,
      fleetNodesRepo: nodesRepo(),
      logger,
    });

    expect(refusals(lines).map((l) => l.fields.frameType)).toEqual(['sessionEnd']);
    expect(warnings(lines), 'the refusal was logged more than once').toEqual([
      'outbound_frame_refused',
    ]);
    expect(registry.pendingTeardownCount(NODE_ID)).toBe(1);
  });

  it('a sessionEnd the socket itself refuses still gets the caller’s WARN', async () => {
    const { lines, logger } = sink();
    const registry = registryLoggingTo(logger);
    registry.register(NODE_ID, () => {
      throw new Error('socket not open');
    });

    await dispatchSessionEndOnClose({
      sessionId: 'agt_close_closed',
      nodeId: NODE_ID,
      fleetControlRegistry: registry,
      fleetNodesRepo: nodesRepo(),
      logger,
    });

    expect(refusals(lines)).toEqual([]);
    expect(warns(lines).map((l) => l.msg)).toEqual([
      'sessionEnd dispatch failed (session close unaffected)',
    ]);
  });

  it('CRITICAL a refused resumeSession adds no WARN beyond the guard’s', async () => {
    const { lines, logger } = sink();
    const registry = registryLoggingTo(logger);
    const conn = registry.register(NODE_ID, () => undefined);
    advertise(conn, NODE_ID, MARGIN);

    await dispatchResumeSession({
      sessionId: 'agt_resume_refused',
      nodeId: NODE_ID,
      fleetControlRegistry: registry,
      fleetNodesRepo: nodesRepo(),
      logger,
    });

    expect(refusals(lines).map((l) => l.fields.frameType)).toEqual(['resumeSession']);
    expect(warnings(lines), 'the refusal was logged more than once').toEqual([
      'outbound_frame_refused',
    ]);
  });

  it('CRITICAL a refused orphan sessionEnd adds no WARN beyond the guard’s', async () => {
    const { lines, logger } = sink();
    const registry = registryLoggingTo(logger);
    const conn = registry.register(NODE_ID, () => undefined);
    advertise(conn, NODE_ID, MARGIN);
    const agentSessions = {
      get: () => Promise.resolve({ id: 'agt_orphan', status: 'closed' }),
    } as unknown as AgentSessionsRepo;

    await reconcileWorkerReportedOrphans({
      agentSessions,
      activeSessionStates: { agt_orphan: 'running' },
      macNodeId: NODE_ID,
      sendSessionEnd: (sessionId) => conn.sendSessionEnd(serializeSessionEnd(sessionId)),
      logger,
    });

    expect(refusals(lines).map((l) => l.fields.frameType)).toEqual(['sessionEnd']);
    expect(warnings(lines), 'the refusal was logged more than once').toEqual([
      'outbound_frame_refused',
    ]);
  });

  describe('POST /v1/mac-nodes/:id/control', () => {
    async function harness(logger: Logger, registry: FleetControlRegistry) {
      const app = Fastify({ loggerInstance: logger as never }) as unknown as FastifyInstance;
      registerErrorHandler(app);
      app.decorate('requireAuth', (req: { account?: unknown }) => {
        req.account = { account: { id: 'acc_test' }, apiKey: { id: 'apk_test' } };
        return Promise.resolve();
      });
      app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
      app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
      registerMacNodesRoutes(app, {
        repo: {
          getDetail: (id: string) => Promise.resolve({ id, nodeId: NODE_ID }),
        } as unknown as DrizzleFleetNodesRepo,
        encryptionKey: KEY,
        now: () => new Date('2026-09-25T00:00:00Z'),
        controlRegistry: registry,
      });
      await app.ready();
      return app;
    }

    it('CRITICAL a refused controlCommand answers 409 and adds no WARN beyond the guard’s', async () => {
      const { lines, logger } = sink();
      const registry = registryLoggingTo(logger);
      const sent: string[] = [];
      const conn = registry.register(NODE_ID, (data) => sent.push(data));
      advertise(conn, NODE_ID, MARGIN);
      const app = await harness(logger, registry);
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/v1/mac-nodes/${randomUUID()}/control`,
          headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
          payload: { command: 'cordon' },
        });
        expect(res.statusCode).toBe(409);
      } finally {
        await app.close();
      }
      expect(sent).toEqual([]);
      expect(refusals(lines).map((l) => l.fields.frameType)).toEqual(['controlCommand']);
      // The error handler's one line per 4xx answer is about the HTTP answer, not
      // the frame, and every 409 has it.
      expect(
        warnings(lines).filter((w) => w !== 'request rejected: 4xx'),
        'the refusal was logged more than once',
      ).toEqual(['outbound_frame_refused']);
    });
  });
});
