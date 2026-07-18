// W383 — drift guard for the agent-session transcript SSE backpressure cap.
//
// The transcript stream (GET /v1/agent-sessions/:id/transcript) hijacks
// the reply and writes live transcript events to the raw socket. Without a cap,
// a STALLED client (TCP window full) lets events buffer unboundedly in
// reply.raw.writableLength → server OOM. The guard closes the stream past a
// generous high-water mark; the client's EventSource auto-reconnects with
// Last-Event-ID and the replay loop resumes it (no transcript entry lost).
//
// The handler hijacks the reply (raw sockets) so it isn't unit-test-injectable;
// this content-parity guard pins the protection so it can't be silently removed.

import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import { AgentSessionEventBus } from '../../src/services/agent-session-event-bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

interface CapturedRequest {
  params: { id: string };
  headers: { 'last-event-id'?: string; origin?: string };
  raw: EventEmitter;
  account: {
    account: { id: string };
    teams: Array<{ ownerAccountId: string; role: 'admin' | 'member' }>;
  };
}

interface CapturedReplyRaw {
  writableLength: number;
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: () => void;
}

interface CapturedReply {
  raw: CapturedReplyRaw;
  hijack: () => void;
}

type CapturedHandler = (request: CapturedRequest, reply: CapturedReply) => Promise<void>;

function captureTranscriptHandler(
  opts: {
    heartbeatMs?: number;
    maxStreams?: number;
    authCheck?: () => void | Promise<void>;
    scopeCheck?: () => void | Promise<void>;
    cors?: {
      permissiveCors?: boolean;
      dashboardOrigin?: string;
      corsAllowedOrigins?: string[];
    };
  } = {},
): {
  handler: CapturedHandler;
  bus: AgentSessionEventBus;
  authCheck: ReturnType<typeof vi.fn>;
  scopeCheck: ReturnType<typeof vi.fn>;
} {
  let handler: CapturedHandler | undefined;
  const authCheck = vi.fn(opts.authCheck ?? (() => undefined));
  const scopeCheck = vi.fn(opts.scopeCheck ?? (() => undefined));
  const noRoute = (): void => {};
  const app = {
    get(path: string, ...args: unknown[]): void {
      if (path === '/v1/agent-sessions/:id/transcript') {
        handler = args.at(-1) as CapturedHandler;
      }
    },
    post: noRoute,
    delete: noRoute,
    requireAuth: vi.fn(),
    requireAuthEventSource: authCheck,
    requireScope: vi.fn(() => scopeCheck),
    rateLimit: vi.fn(() => vi.fn()),
  };
  const bus = new AgentSessionEventBus();
  registerAgentSessionsRoutes(app as unknown as FastifyInstance, {
    runtime: {} as never,
    sessions: {
      get: () =>
        Promise.resolve({
          id: 'agt_test',
          accountId: 'acc_owner',
          transcript: [
            { at: '2026-07-15T00:00:00.000Z', role: 'user', body: 'first' },
            { at: '2026-07-15T00:00:01.000Z', role: 'agent', body: 'second' },
          ],
        }),
    } as never,
    transcriptEventBus: bus,
    transcriptHeartbeatMs: opts.heartbeatMs ?? 30_000,
    transcriptMaxStreamsPerAccount: opts.maxStreams ?? 10,
    cors: opts.cors ?? {},
  });
  if (handler === undefined) throw new Error('transcript handler was not registered');
  return { handler, bus, authCheck, scopeCheck };
}

function makeConnection(
  opts: {
    accountId?: string;
    ownerTeamRole?: 'admin' | 'member';
    lastEventId?: string;
    writableLength?: number;
    failWriteHead?: boolean;
    origin?: string;
  } = {},
): {
  request: CapturedRequest;
  reply: CapturedReply;
  writes: string[];
  readonly endCount: number;
  readonly hijackCount: number;
  readonly status: number | undefined;
  readonly headers: Record<string, string> | undefined;
} {
  const writes: string[] = [];
  let endCount = 0;
  let hijackCount = 0;
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  const accountId = opts.accountId ?? 'acc_owner';
  const requestHeaders: CapturedRequest['headers'] = {};
  if (opts.lastEventId !== undefined) requestHeaders['last-event-id'] = opts.lastEventId;
  if (opts.origin !== undefined) requestHeaders.origin = opts.origin;
  const request: CapturedRequest = {
    params: { id: 'agt_test' },
    headers: requestHeaders,
    raw: new EventEmitter(),
    account: {
      account: { id: accountId },
      teams:
        opts.ownerTeamRole === undefined
          ? []
          : [{ ownerAccountId: 'acc_owner', role: opts.ownerTeamRole }],
    },
  };
  const raw: CapturedReplyRaw = {
    writableLength: opts.writableLength ?? 0,
    writeHead: (nextStatus, nextHeaders) => {
      if (opts.failWriteHead === true) throw new Error('synthetic setup failure');
      status = nextStatus;
      headers = nextHeaders;
    },
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    end: () => {
      endCount += 1;
    },
  };
  return {
    request,
    reply: {
      raw,
      hijack: () => {
        hijackCount += 1;
      },
    },
    writes,
    get endCount() {
      return endCount;
    },
    get hijackCount() {
      return hijackCount;
    },
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('W383 agent-session transcript SSE backpressure guard content parity', () => {
  const body = read(ROUTE);

  it('file exists at canonical path', () => {
    expect(existsSync(ROUTE)).toBe(true);
  });

  it('generous high-water mark constant pinned (4MB)', () => {
    expect(body).toMatch(/const MAX_SSE_BUFFER_BYTES = 4_000_000;/);
  });

  it('live-event write path closes the stream when the socket buffer exceeds the mark (backpressure)', () => {
    expect(body).toMatch(/if \(reply\.raw\.writableLength > MAX_SSE_BUFFER_BYTES\) cleanup\(\);/);
    expect(body).toMatch(/closeIfBackpressured\(\);/);
  });

  it('cleanup is idempotent (guard + close + error can all invoke it without double-end/unsubscribe)', () => {
    expect(body).toMatch(/let closed = false;/);
    expect(body).toMatch(/if \(closed\) return;\s*\n?\s*closed = true;/);
    expect(body).toMatch(/if \(heartbeat !== undefined\) clearInterval\(heartbeat\);/);
    expect(body).toMatch(/unsubscribe\(\);/);
    expect(body).toMatch(/reply\.raw\.end\(\);/);
  });

  it('pins private no-store streaming cache policy and origin-specific raw CORS', () => {
    expect(body).toMatch(/'cache-control': 'no-cache, no-store, private, no-transform'/);
    expect(body).toMatch(/\.\.\.sseCorsHeaders\(req\.headers\.origin, deps\.cors \?\? \{\}\)/);
  });

  it('requires the granular session-read scope after EventSource authentication', () => {
    expect(body).toMatch(/const requireTranscriptRead = app\.requireScope\('read:sessions'\);/);
    expect(body).toMatch(
      /app\.requireAuthEventSource,\s*\n?\s*requireTranscriptRead,\s*\n?\s*app\.rateLimit\('global'\)/,
    );
    expect(body).toMatch(
      /await app\.requireAuthEventSource\(req, reply\);[\s\S]*?await requireTranscriptRead\(req, reply\);/,
    );
  });

  it('projects both replayed and live entries through the shared secret redactor', () => {
    expect(body).toMatch(/entry: publicTranscriptEntry\(entry\)/);
    expect(body).toMatch(/entry: publicTranscriptEntry\(event\.entry\)/);
  });

  it('projects both plan and nested result intents in the message response', () => {
    expect(body).toMatch(/intents: plan\.intents\.map\(publicAgentIntent\)/);
    expect(body).toMatch(/results: result\.executor\.results\.map\(publicIntentResult\)/);
  });
});

describe('agent transcript SSE captured lifecycle', () => {
  it('reflects an allowed origin with Vary and omits CORS for a disallowed origin', async () => {
    const { handler } = captureTranscriptHandler();
    const allowed = makeConnection({ origin: 'https://app.driftstack.dev' });
    await handler(allowed.request, allowed.reply);
    expect(allowed.status).toBe(200);
    expect(allowed.headers).toMatchObject({
      'cache-control': 'no-cache, no-store, private, no-transform',
      'access-control-allow-origin': 'https://app.driftstack.dev',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    });

    const disallowed = makeConnection({ origin: 'https://cross-account.invalid' });
    await handler(disallowed.request, disallowed.reply);
    expect(disallowed.headers?.['cache-control']).toBe('no-cache, no-store, private, no-transform');
    expect(disallowed.headers).not.toHaveProperty('access-control-allow-origin');
    expect(disallowed.headers).not.toHaveProperty('access-control-allow-credentials');
    expect(disallowed.headers).not.toHaveProperty('vary');

    allowed.request.raw.emit('close');
    disallowed.request.raw.emit('close');
  });

  it('caps one authenticated account at ten streams, isolates another account, and reuses a released slot', async () => {
    const { handler, bus } = captureTranscriptHandler();
    const ownerConnections = Array.from({ length: 10 }, () => makeConnection());
    for (const connection of ownerConnections) {
      await handler(connection.request, connection.reply);
    }
    expect(ownerConnections.every((connection) => connection.hijackCount === 1)).toBe(true);
    expect(bus.subscriberCount('agt_test')).toBe(10);

    const denied = makeConnection();
    await expect(handler(denied.request, denied.reply)).rejects.toMatchObject({ status: 429 });
    expect(denied.hijackCount).toBe(0);

    const teamAdmin = makeConnection({ accountId: 'acc_team_admin', ownerTeamRole: 'admin' });
    await handler(teamAdmin.request, teamAdmin.reply);
    expect(teamAdmin.hijackCount).toBe(1);

    ownerConnections[0]!.request.raw.emit('close');
    const replacement = makeConnection();
    await handler(replacement.request, replacement.reply);
    expect(replacement.hijackCount).toBe(1);

    for (const connection of ownerConnections.slice(1)) connection.request.raw.emit('close');
    teamAdmin.request.raw.emit('close');
    replacement.request.raw.emit('close');
    expect(bus.subscriberCount('agt_test')).toBe(0);
  });

  it('does not consume capacity when synchronous stream setup fails', async () => {
    const { handler, bus } = captureTranscriptHandler({ maxStreams: 1 });
    const failed = makeConnection({ failWriteHead: true });
    await expect(handler(failed.request, failed.reply)).rejects.toThrow('synthetic setup failure');
    expect(failed.endCount).toBe(1);
    expect(bus.subscriberCount('agt_test')).toBe(0);

    const next = makeConnection();
    await handler(next.request, next.reply);
    expect(next.hijackCount).toBe(1);
    next.request.raw.emit('close');
  });

  it('revalidates auth and granular scope on heartbeat, then releases a revoked stream slot', async () => {
    vi.useFakeTimers();
    let authAllowed = true;
    let scopeAllowed = true;
    const { handler, bus, authCheck, scopeCheck } = captureTranscriptHandler({
      heartbeatMs: 10,
      maxStreams: 1,
      authCheck: () => {
        if (!authAllowed) throw new Error('revoked');
      },
      scopeCheck: () => {
        if (!scopeAllowed) throw new Error('scope narrowed');
      },
    });
    const connection = makeConnection();
    await handler(connection.request, connection.reply);
    authAllowed = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).not.toHaveBeenCalled();
    expect(connection.endCount).toBe(1);
    expect(bus.subscriberCount('agt_test')).toBe(0);

    authAllowed = true;
    const replacement = makeConnection();
    await handler(replacement.request, replacement.reply);
    expect(replacement.hijackCount).toBe(1);
    scopeAllowed = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(authCheck).toHaveBeenCalledTimes(2);
    expect(scopeCheck).toHaveBeenCalledTimes(1);
    expect(replacement.endCount).toBe(1);
    expect(bus.subscriberCount('agt_test')).toBe(0);

    scopeAllowed = true;
    const finalReplacement = makeConnection();
    await handler(finalReplacement.request, finalReplacement.reply);
    expect(finalReplacement.hijackCount).toBe(1);
    finalReplacement.request.raw.emit('close');
  });

  it('closes when refreshed team-admin access is removed', async () => {
    vi.useFakeTimers();
    const { handler, bus, authCheck, scopeCheck } = captureTranscriptHandler({ heartbeatMs: 10 });
    const connection = makeConnection({ accountId: 'acc_team_admin', ownerTeamRole: 'admin' });
    await handler(connection.request, connection.reply);
    connection.request.account.teams = [];
    await vi.advanceTimersByTimeAsync(10);
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).toHaveBeenCalledTimes(1);
    expect(connection.endCount).toBe(1);
    expect(bus.subscriberCount('agt_test')).toBe(0);
  });

  it('tears down event and heartbeat backlog exactly once', async () => {
    vi.useFakeTimers();
    const eventFixture = captureTranscriptHandler({ heartbeatMs: 10 });
    const eventConnection = makeConnection();
    await eventFixture.handler(eventConnection.request, eventConnection.reply);
    eventConnection.reply.raw.writableLength = 4_000_001;
    eventFixture.bus.publish({
      agentSessionId: 'agt_test',
      index: 2,
      entry: { at: '2026-07-15T00:00:02.000Z', role: 'agent', body: 'live' },
    });
    eventConnection.request.raw.emit('error', new Error('late socket error'));
    expect(eventConnection.endCount).toBe(1);
    expect(eventFixture.bus.subscriberCount('agt_test')).toBe(0);

    const heartbeatFixture = captureTranscriptHandler({ heartbeatMs: 10 });
    const heartbeatConnection = makeConnection({ writableLength: 4_000_001 });
    await heartbeatFixture.handler(heartbeatConnection.request, heartbeatConnection.reply);
    await vi.advanceTimersByTimeAsync(10);
    heartbeatConnection.request.raw.emit('close');
    expect(heartbeatFixture.authCheck).toHaveBeenCalledTimes(1);
    expect(heartbeatFixture.scopeCheck).toHaveBeenCalledTimes(1);
    expect(heartbeatConnection.endCount).toBe(1);
    expect(heartbeatFixture.bus.subscriberCount('agt_test')).toBe(0);
  });

  it('preserves exclusive Last-Event-ID replay and healthy live framing', async () => {
    const { handler, bus } = captureTranscriptHandler();
    const connection = makeConnection({ lastEventId: '0' });
    await handler(connection.request, connection.reply);
    expect(connection.writes).toContain(': stream open\n\n');
    expect(connection.writes).not.toContain('id: 0\n');
    expect(connection.writes).toContain('id: 1\n');
    expect(connection.writes).toContain('event: transcript.entry\n');
    expect(connection.writes.some((chunk) => chunk.includes('"index":1'))).toBe(true);

    bus.publish({
      agentSessionId: 'agt_test',
      index: 2,
      entry: { at: '2026-07-15T00:00:02.000Z', role: 'agent', body: 'live' },
    });
    expect(connection.writes).toContain('id: 2\n');
    expect(connection.writes.some((chunk) => chunk.includes('"index":2'))).toBe(true);
    expect(connection.endCount).toBe(0);
    connection.request.raw.emit('close');
  });
});
