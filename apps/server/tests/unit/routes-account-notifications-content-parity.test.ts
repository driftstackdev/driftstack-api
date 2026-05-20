// 2026-05-20 — drift guard for apps/server/src/routes/account-
// notifications.ts. Pins the SSE-stream shape so a refactor can't
// silently break customer-visible framing (event headers, heartbeat
// cadence, cleanup-on-disconnect contract).
//
//   • Opt-in registration: route lives behind a notificationBus
//     dep — when omitted, NO route registered (mirrors transcript
//     stream pattern).
//   • Per-accountId scope via requireAuth + ctx.account.id.
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

  it("route at GET /v1/account/me/notifications + requireAuth + rateLimit('global')", () => {
    expect(body).toMatch(/app\.get\(\s*\n?\s*'\/v1\/account\/me\/notifications',/);
    expect(body).toMatch(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/);
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

  it('heartbeat at 25_000ms default (DEFAULT_HEARTBEAT_MS), overridable via opts.heartbeatMs; .unref() so heartbeat does not keep the process alive past disconnect', () => {
    expect(body).toMatch(/const DEFAULT_HEARTBEAT_MS = 25_000;/);
    expect(body).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? DEFAULT_HEARTBEAT_MS;/);
    expect(body).toMatch(
      /const heartbeat = setInterval\(\(\) => \{\s*\n?\s*reply\.raw\.write\(`: heartbeat \$\{new Date\(\)\.toISOString\(\)\}\\n\\n`\);\s*\n?\s*\}, heartbeatMs\);/,
    );
    expect(body).toMatch(/heartbeat\.unref\(\);/);
  });

  it('cleanup on disconnect: req.raw close + error → clearInterval + unsubscribe + reply.raw.end()', () => {
    expect(body).toMatch(/req\.raw\.on\('close', cleanup\);/);
    expect(body).toMatch(/req\.raw\.on\('error', cleanup\);/);
    expect(body).toMatch(
      /const cleanup = \(\): void => \{\s*\n?\s*clearInterval\(heartbeat\);\s*\n?\s*unsubscribe\(\);\s*\n?\s*reply\.raw\.end\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/reply\.hijack\(\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
