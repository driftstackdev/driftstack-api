// 2026-05-20 — drift guard for apps/server/src/routes/account-
// notifications.ts. Pins the SSE-stream shape so a refactor can't
// silently break customer-visible framing (event headers, heartbeat
// cadence, cleanup-on-disconnect contract).
//
//   • Opt-in registration: route lives behind a notificationBus
//     dep — when omitted, NO route registered (mirrors transcript
//     stream pattern).
//   • Per-accountId scope via requireAuthEventSource + ctx.account.id
//     (SSE route — accepts the bearer token via ?ds_token= since
//     EventSource can't set an Authorization header).
//   • SSE headers: text/event-stream + private no-store/no-cache/no-transform +
//     keep-alive + x-accel-buffering: no + origin-specific CORS.
//   • Frame shape: `event: <kind>` + `data: <JSON>` + double-LF.
//   • Heartbeat at 25s default (overridable for tests).
//   • Cleanup: clearInterval + unsubscribe + reply.raw.end() on
//     req.raw 'close' + 'error'.

import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAccountNotificationsRoutes } from '../../src/routes/account-notifications.js';
import { NotificationEventBus } from '../../src/services/notification-event-bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-notifications.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

interface CapturedRequest {
  headers: { origin?: string };
  raw: EventEmitter;
  account: { account: { id: string } };
}

interface CapturedReplyRaw {
  writableLength: number;
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: () => void;
  destroy: () => void;
}

interface CapturedReply {
  raw: CapturedReplyRaw;
  hijack: () => void;
}

type CapturedHandler = (request: CapturedRequest, reply: CapturedReply) => void;

function captureNotificationsHandler(
  opts: {
    heartbeatMs?: number;
    maxStreams?: number;
    authCheck?: () => void | Promise<void>;
    scopeCheck?: () => void | Promise<void>;
  } = {},
): {
  handler: CapturedHandler;
  bus: NotificationEventBus;
  authCheck: ReturnType<typeof vi.fn>;
  scopeCheck: ReturnType<typeof vi.fn>;
} {
  let handler: CapturedHandler | undefined;
  const authCheck = vi.fn(opts.authCheck ?? (() => undefined));
  const scopeCheck = vi.fn(opts.scopeCheck ?? (() => undefined));
  const app = {
    get(path: string, ...args: unknown[]): void {
      if (path === '/v1/account/me/notifications') {
        handler = args.at(-1) as CapturedHandler;
      }
    },
    requireAuthEventSource: authCheck,
    requireScope: vi.fn(() => scopeCheck),
    rateLimit: vi.fn(() => vi.fn()),
  };
  const bus = new NotificationEventBus();
  registerAccountNotificationsRoutes(app as unknown as FastifyInstance, {
    notificationBus: bus,
    heartbeatMs: opts.heartbeatMs ?? 30_000,
    maxStreamsPerAccount: opts.maxStreams ?? 10,
  });
  if (handler === undefined) throw new Error('notification handler was not registered');
  return { handler, bus, authCheck, scopeCheck };
}

function makeConnection(
  opts: { accountId?: string; writableLength?: number; origin?: string } = {},
): {
  request: CapturedRequest;
  reply: CapturedReply;
  writes: string[];
  readonly writesAfterEnd: number;
  readonly endCount: number;
  readonly destroyCount: number;
  readonly hijackCount: number;
  readonly status: number | undefined;
  readonly headers: Record<string, string> | undefined;
} {
  const writes: string[] = [];
  let ended = false;
  let writesAfterEnd = 0;
  let endCount = 0;
  let destroyCount = 0;
  let hijackCount = 0;
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  const request: CapturedRequest = {
    headers: opts.origin === undefined ? {} : { origin: opts.origin },
    raw: new EventEmitter(),
    account: { account: { id: opts.accountId ?? 'acc_test' } },
  };
  const raw: CapturedReplyRaw = {
    writableLength: opts.writableLength ?? 0,
    writeHead: (nextStatus, nextHeaders) => {
      status = nextStatus;
      headers = nextHeaders;
    },
    write: (chunk) => {
      if (ended) writesAfterEnd += 1;
      writes.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
      endCount += 1;
    },
    destroy: () => {
      destroyCount += 1;
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
    get writesAfterEnd() {
      return writesAfterEnd;
    },
    get endCount() {
      return endCount;
    },
    get destroyCount() {
      return destroyCount;
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

describe('routes/account-notifications.ts content parity', () => {
  const body = read(LIB);

  it('opt-in registration: returns early when notificationBus is undefined (no route registered)', () => {
    expect(body).toMatch(/const bus = opts\.notificationBus;/);
    expect(body).toMatch(/if \(bus === undefined\) return;/);
  });

  it("route at GET /v1/account/me/notifications + EventSource auth + broad read scope + rateLimit('global')", () => {
    expect(body).toMatch(/'\/v1\/account\/me\/notifications',/);
    // SSE route: EventSource can't set headers, so auth accepts the
    // bearer token via ?ds_token= (requireAuthEventSource). Drift back
    // to plain requireAuth would 401 every browser EventSource connect.
    expect(body).toMatch(/const requireNotificationRead = app\.requireScope\('read'\);/);
    expect(body).toMatch(
      /preHandler: \[app\.requireAuthEventSource, requireNotificationRead, app\.rateLimit\('global'\)\]/,
    );
  });

  it('per-accountId scope: ctx.account.id from requireCtx drives bus.subscribe key', () => {
    expect(body).toMatch(/const ctx = requireCtx\(req\);/);
    expect(body).toMatch(/const accountId = ctx\.account\.id;/);
    expect(body).toMatch(/bus\.subscribe\(accountId,/);
  });

  it('SSE headers pinned: text/event-stream + private no-store/no-cache/no-transform + keep-alive + x-accel-buffering: no', () => {
    expect(body).toMatch(/'content-type': 'text\/event-stream; charset=utf-8'/);
    expect(body).toMatch(/'cache-control': 'no-cache, no-store, private, no-transform'/);
    expect(body).toMatch(/connection: 'keep-alive'/);
    expect(body).toMatch(/'x-accel-buffering': 'no'/);
  });

  it('SSE frame shape: `event: <kind>` discriminator + `data: <JSON>` + double-LF; preamble `: stream open\\n\\n`', () => {
    expect(body).toMatch(/reply\.raw\.write\(': stream open\\n\\n'\);/);
    expect(body).toMatch(/reply\.raw\.write\(`event: \$\{event\.kind\}\\n`\);/);
    expect(body).toMatch(/reply\.raw\.write\(`data: \$\{JSON\.stringify\(event\)\}\\n\\n`\);/);
  });

  it('heartbeat at 25_000ms default; one auth check runs at a time and closed checks after each await prevent late writes', () => {
    expect(body).toMatch(/const DEFAULT_HEARTBEAT_MS = 25_000;/);
    expect(body).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? DEFAULT_HEARTBEAT_MS;/);
    expect(body).toMatch(/let heartbeatAuthInFlight = false;/);
    expect(body).toMatch(/heartbeat = setInterval\(\(\) => \{/);
    expect(body).toMatch(/if \(closed \|\| heartbeatAuthInFlight\) return;/);
    expect(body).toMatch(/heartbeatAuthInFlight = true;/);
    // Re-auth + re-authorize each tick, write on success, destroy on failure.
    expect(body).toMatch(/await app\.requireAuthEventSource\(req, reply\);/);
    expect(body).toMatch(
      /await app\.requireAuthEventSource\(req, reply\);\s*\n?\s*if \(closed\) return;/,
    );
    expect(body).toMatch(/await requireNotificationRead\(req, reply\);/);
    expect(body).toMatch(
      /await requireNotificationRead\(req, reply\);\s*\n?\s*if \(closed\) return;/,
    );
    expect(body).toMatch(/heartbeatAuthInFlight = false;/);
    expect(body).toMatch(/heartbeat\.unref\(\);/);
  });

  it('cleanup on disconnect: req.raw close + error → idempotent clearInterval + unsubscribe + per-account decrement + reply.raw.end()', () => {
    expect(body).toMatch(/req\.raw\.on\('close', cleanup\);/);
    expect(body).toMatch(/req\.raw\.on\('error', cleanup\);/);
    // L1 — cleanup is now idempotent (closed-guard) because the backpressure
    // guard can fire it concurrently with the close/error handlers.
    expect(body).toMatch(/let closed = false;/);
    expect(body).toMatch(/const cleanup = \(\): void => \{/);
    expect(body).toMatch(/if \(closed\) return;\s*\n?\s*closed = true;/);
    expect(body).toMatch(/clearInterval\(heartbeat\);/);
    expect(body).toMatch(/unsubscribe\(\);/);
    expect(body).toMatch(/reply\.raw\.end\(\);/);
    expect(body).toMatch(/reply\.hijack\(\);/);
  });

  it('L1 — shared backpressure cap closes both notification-event and heartbeat backlog', () => {
    expect(body).toMatch(/const MAX_SSE_BUFFER_BYTES = 4_000_000;/);
    expect(body).toMatch(/if \(reply\.raw\.writableLength > MAX_SSE_BUFFER_BYTES\) cleanup\(\);/);
    expect(body.match(/closeIfBackpressured\(\);/g)).toHaveLength(2);
  });

  it('heartbeat auth failure releases owned resources before destroying the socket', () => {
    expect(body).toMatch(
      /catch \{\s*\n?\s*if \(closed\) return;[\s\S]*?cleanup\(\);\s*\n?\s*reply\.raw\.destroy\(\);/,
    );
  });

  it('L1 — per-account concurrency ceiling: 429 at the cap, increment on accept, decrement in cleanup', () => {
    expect(body).toMatch(/const DEFAULT_MAX_SSE_PER_ACCOUNT = 10;/);
    expect(body).toMatch(
      /const maxStreamsPerAccount = opts\.maxStreamsPerAccount \?\? DEFAULT_MAX_SSE_PER_ACCOUNT;/,
    );
    expect(body).toMatch(/const activeByAccount = new Map<string, number>\(\);/);
    expect(body).toMatch(/if \(active >= maxStreamsPerAccount\) \{/);
    expect(body).toMatch(/throw new RateLimitedError\(/);
    expect(body).toMatch(
      /At most \$\{maxStreamsPerAccount\.toString\(\)\} concurrent notification streams/,
    );
    expect(body).not.toMatch(/\.send\(\{\s*\n?\s*error:/);
    expect(body).toMatch(/activeByAccount\.set\(accountId, active \+ 1\);/);
    expect(body).toMatch(/const remaining = \(activeByAccount\.get\(accountId\) \?\? 1\) - 1;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

describe('account notification SSE captured lifecycle', () => {
  it('keeps one heartbeat authorization check in flight and writes nothing after client close', async () => {
    vi.useFakeTimers();
    let releaseAuth!: () => void;
    const authPending = new Promise<void>((resolveAuth) => {
      releaseAuth = resolveAuth;
    });
    const { handler, bus, authCheck, scopeCheck } = captureNotificationsHandler({
      heartbeatMs: 10,
      maxStreams: 1,
      authCheck: () => authPending,
    });
    const connection = makeConnection();
    handler(connection.request, connection.reply);

    await vi.advanceTimersByTimeAsync(50);
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).not.toHaveBeenCalled();
    expect(bus.subscriberCount('acc_test')).toBe(1);

    connection.request.raw.emit('close');
    releaseAuth();
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.endCount).toBe(1);
    expect(connection.writesAfterEnd).toBe(0);
    expect(connection.writes.some((chunk) => chunk.startsWith(': heartbeat '))).toBe(false);
    expect(bus.subscriberCount('acc_test')).toBe(0);
  });

  it('tears down notification-event backlog exactly once and reuses the account slot', () => {
    const { handler, bus } = captureNotificationsHandler({ maxStreams: 1 });
    const connection = makeConnection();
    handler(connection.request, connection.reply);
    connection.reply.raw.writableLength = 4_000_001;
    bus.publish({
      kind: 'incident.broadcast',
      accountId: 'acc_test',
      incidentId: 'inc_test',
      severity: 'major',
      title: 'Synthetic event',
      at: '2026-07-15T04:00:00.000Z',
    });
    connection.request.raw.emit('error', new Error('late socket error'));
    expect(connection.endCount).toBe(1);
    expect(bus.subscriberCount('acc_test')).toBe(0);

    const replacement = makeConnection();
    handler(replacement.request, replacement.reply);
    expect(replacement.hijackCount).toBe(1);
    replacement.request.raw.emit('close');
  });

  it('tears down heartbeat backlog exactly once and reuses the account slot', async () => {
    vi.useFakeTimers();
    const { handler, bus, authCheck, scopeCheck } = captureNotificationsHandler({
      heartbeatMs: 10,
      maxStreams: 1,
    });
    const connection = makeConnection({ writableLength: 4_000_001 });
    handler(connection.request, connection.reply);
    await vi.advanceTimersByTimeAsync(10);
    connection.request.raw.emit('close');
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).toHaveBeenCalledTimes(1);
    expect(connection.endCount).toBe(1);
    expect(bus.subscriberCount('acc_test')).toBe(0);

    const replacement = makeConnection();
    handler(replacement.request, replacement.reply);
    expect(replacement.hijackCount).toBe(1);
    replacement.request.raw.emit('close');
  });

  it('releases timer, listener and capacity before destroying an auth-failed stream', async () => {
    vi.useFakeTimers();
    let authAllowed = false;
    const { handler, bus, authCheck, scopeCheck } = captureNotificationsHandler({
      heartbeatMs: 10,
      maxStreams: 1,
      authCheck: () => {
        if (!authAllowed) throw new Error('revoked');
      },
    });
    const connection = makeConnection();
    handler(connection.request, connection.reply);
    await vi.advanceTimersByTimeAsync(10);
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).not.toHaveBeenCalled();
    expect(connection.endCount).toBe(1);
    expect(connection.destroyCount).toBe(1);
    expect(bus.subscriberCount('acc_test')).toBe(0);

    authAllowed = true;
    const replacement = makeConnection();
    handler(replacement.request, replacement.reply);
    expect(replacement.hijackCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(authCheck).toHaveBeenCalledTimes(2);
    expect(scopeCheck).toHaveBeenCalledTimes(1);
    replacement.request.raw.emit('close');
  });

  it('preserves healthy CORS, event framing, heartbeat framing and open-stream lifecycle', async () => {
    vi.useFakeTimers();
    const { handler, bus, authCheck, scopeCheck } = captureNotificationsHandler({
      heartbeatMs: 10,
    });
    const connection = makeConnection({ origin: 'https://app.driftstack.dev' });
    handler(connection.request, connection.reply);
    bus.publish({
      kind: 'session.errored',
      accountId: 'acc_test',
      sessionId: 'ses_test',
      errorClass: 'synthetic',
      at: '2026-07-15T04:00:00.000Z',
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(connection.status).toBe(200);
    expect(connection.headers?.['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(connection.headers?.['cache-control']).toBe('no-cache, no-store, private, no-transform');
    expect(connection.headers).toMatchObject({
      'access-control-allow-origin': 'https://app.driftstack.dev',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    });
    expect(connection.writes).toContain(': stream open\n\n');
    expect(connection.writes).toContain('event: session.errored\n');
    expect(connection.writes.some((chunk) => chunk.includes('"sessionId":"ses_test"'))).toBe(true);
    expect(connection.writes.some((chunk) => chunk.startsWith(': heartbeat '))).toBe(true);
    expect(authCheck).toHaveBeenCalledTimes(1);
    expect(scopeCheck).toHaveBeenCalledTimes(1);
    expect(connection.endCount).toBe(0);
    expect(bus.subscriberCount('acc_test')).toBe(1);
    connection.request.raw.emit('close');
  });

  it('keeps private cache policy but omits CORS headers for a disallowed origin', () => {
    const { handler } = captureNotificationsHandler();
    const connection = makeConnection({ origin: 'https://cross-account.invalid' });
    handler(connection.request, connection.reply);

    expect(connection.headers?.['cache-control']).toBe('no-cache, no-store, private, no-transform');
    expect(connection.headers).not.toHaveProperty('access-control-allow-origin');
    expect(connection.headers).not.toHaveProperty('access-control-allow-credentials');
    expect(connection.headers).not.toHaveProperty('vary');
    connection.request.raw.emit('close');
  });
});
