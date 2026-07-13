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
//   • SSE headers: text/event-stream + no-cache + keep-alive +
//     x-accel-buffering: no.
//   • Frame shape: `event: <kind>` + `data: <JSON>` + double-LF.
//   • Heartbeat at 25s default (overridable for tests).
//   • Cleanup: clearInterval + unsubscribe + reply.raw.end() on
//     req.raw 'close' + 'error'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-notifications.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

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

  it('SSE headers pinned: text/event-stream + no-cache + keep-alive + x-accel-buffering: no', () => {
    expect(body).toMatch(/'content-type': 'text\/event-stream; charset=utf-8'/);
    expect(body).toMatch(/'cache-control': 'no-cache, no-transform'/);
    expect(body).toMatch(/connection: 'keep-alive'/);
    expect(body).toMatch(/'x-accel-buffering': 'no'/);
  });

  it('SSE frame shape: `event: <kind>` discriminator + `data: <JSON>` + double-LF; preamble `: stream open\\n\\n`', () => {
    expect(body).toMatch(/reply\.raw\.write\(': stream open\\n\\n'\);/);
    expect(body).toMatch(/reply\.raw\.write\(`event: \$\{event\.kind\}\\n`\);/);
    expect(body).toMatch(/reply\.raw\.write\(`data: \$\{JSON\.stringify\(event\)\}\\n\\n`\);/);
  });

  it('heartbeat at 25_000ms default (DEFAULT_HEARTBEAT_MS), overridable via opts.heartbeatMs; .unref() so heartbeat does not keep the process alive past disconnect; each tick RE-VALIDATES auth (requireAuthEventSource) → success writes the heartbeat, failure destroys the socket so a revoked web session cannot keep streaming (bounds the leak to one interval)', () => {
    expect(body).toMatch(/const DEFAULT_HEARTBEAT_MS = 25_000;/);
    expect(body).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? DEFAULT_HEARTBEAT_MS;/);
    expect(body).toMatch(/const heartbeat = setInterval\(\(\) => \{/);
    // Re-auth + re-authorize each tick, write on success, destroy on failure.
    expect(body).toMatch(/await app\.requireAuthEventSource\(req, reply\);/);
    expect(body).toMatch(/await requireNotificationRead\(req, reply\);/);
    expect(body).toMatch(
      /reply\.raw\.write\(`: heartbeat \$\{new Date\(\)\.toISOString\(\)\}\\n\\n`\)/,
    );
    expect(body).toMatch(/\.catch\(\(\) => reply\.raw\.destroy\(\)\)/);
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

  it('L1 — backpressure cap (MAX_SSE_BUFFER_BYTES) closes a stalled stream, mirroring the transcript SSE', () => {
    expect(body).toMatch(/const MAX_SSE_BUFFER_BYTES = 4_000_000;/);
    expect(body).toMatch(/if \(reply\.raw\.writableLength > MAX_SSE_BUFFER_BYTES\) cleanup\(\);/);
  });

  it('L1 — per-account concurrency ceiling: 429 at the cap, increment on accept, decrement in cleanup', () => {
    expect(body).toMatch(/const DEFAULT_MAX_SSE_PER_ACCOUNT = 10;/);
    expect(body).toMatch(
      /const maxStreamsPerAccount = opts\.maxStreamsPerAccount \?\? DEFAULT_MAX_SSE_PER_ACCOUNT;/,
    );
    expect(body).toMatch(/const activeByAccount = new Map<string, number>\(\);/);
    expect(body).toMatch(/if \(active >= maxStreamsPerAccount\) \{/);
    expect(body).toMatch(/\.code\(429\)/);
    expect(body).toMatch(/too_many_notification_streams/);
    expect(body).toMatch(/activeByAccount\.set\(accountId, active \+ 1\);/);
    expect(body).toMatch(/const remaining = \(activeByAccount\.get\(accountId\) \?\? 1\) - 1;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
