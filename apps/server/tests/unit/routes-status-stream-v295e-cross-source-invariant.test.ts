// W1022 — routes/status-stream V-295e cross-source invariant. Three-
// hundred-forty-eighth in the drift-guard series. Pins the apps/
// server/src/routes/status-stream.ts SSE + SLA routes:
//
//   V-295e anchor — 'V-295e — public status streaming + SLA
//   endpoints'.
//
//   Endpoint inventory:
//     - GET /v1/status/stream — Server-Sent Events for incident
//       events. Heartbeat every 30s keeps connection alive through
//       proxies.
//     - GET /v1/status/sla — rolling 30-day uptime per probe target
//       from V-295b system_health_probes.
//
//   Both endpoints stay unauthenticated/public. SLA has the global
//   gate plus 60/min/IP route budget; SSE is capped at 500 total /10 IP.
//
//   heartbeatMs default 30_000 framing — 'Heartbeat interval in ms.
//   Defaults to 30s — well below typical proxy idle-timeouts (60s on
//   Cloudflare, longer elsewhere)'.
//
//   SSE 4 headers — content-type:'text/event-stream;charset=utf-8' +
//     cache-control:'no-cache, no-transform' + connection:
//     'keep-alive' + x-accel-buffering:'no' (disable nginx-style
//     buffering).
//
//   SSE framing — 'event: <name>\n' + 'data: <json>\n\n' (blank-line
//     terminator). Initial ':stream open\n\n' comment to flush
//     headers immediately on some proxies.
//
//   Heartbeat is SSE comment ':heartbeat <iso>\n\n' + setInterval
//     .unref() to not pin process.
//
//   cleanup on close + error events — clearInterval(heartbeat) +
//     unsubscribe() + idempotent connection release + reply.raw.end().
//
//   reply.hijack() to keep Fastify from auto-completing.
//
//   /v1/status/sla is protected by statusSlaGate before aggregation.
//
// stays in lockstep across apps/server/src/routes/status-stream.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1022 routes/status-stream V-295e cross-source invariant', () => {
  it("CRITICAL V-295e anchor — 'V-295e — public status streaming + SLA endpoints'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/V-295e — public status streaming \+ SLA endpoints\./);
  });

  it("CRITICAL endpoint inventory — 'GET /v1/status/stream — Server-Sent Events. Heartbeat every 30s keeps the connection alive through proxies' + 'GET /v1/status/sla — rolling 30-day uptime per probe target, computed from the V-295b system_health_probes table'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/GET \/v1\/status\/stream — Server-Sent Events\./);
    expect(p).toMatch(/Heartbeat every 30s keeps/);
    expect(p).toMatch(/the connection alive through proxies\./);
    expect(p).toMatch(/GET \/v1\/status\/sla — rolling 30-day uptime per probe target,/);
    expect(p).toMatch(/computed from the V-295b system_health_probes table\./);
  });

  it('CRITICAL public posture + route-level resource bounds', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toContain('Both endpoints are unauthenticated (the status site is public).');
    expect(p).toContain('60/min/IP direct-request budget');
    expect(p).toContain('500 total connections and 10 per IP');
    expect(p).not.toContain('NO app-level');
  });

  it("CRITICAL heartbeatMs default — '30_000' + framing 'well below typical proxy idle-timeouts (60s on Cloudflare, longer elsewhere)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/Heartbeat interval in ms\. Defaults to 30s — well below typical/);
    expect(p).toMatch(/proxy idle-timeouts \(60s on Cloudflare, longer elsewhere\)\./);
    expect(p).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? 30_000;/);
  });

  it("CRITICAL SSE 4 headers — content-type:'text/event-stream; charset=utf-8' + cache-control:'no-cache, no-transform' + connection:'keep-alive' + x-accel-buffering:'no'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/'content-type': 'text\/event-stream; charset=utf-8',/);
    expect(p).toMatch(/'cache-control': 'no-cache, no-transform',/);
    expect(p).toMatch(/connection: 'keep-alive',/);
    expect(p).toMatch(/'x-accel-buffering': 'no', \/\/ disable nginx-style buffering/);
  });

  it("CRITICAL SSE framing — initial ': stream open\\n\\n' comment + 'event: <name>\\n' + 'data: <json>\\n\\n' blank-terminated.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/reply\.raw\.write\(': stream open\\n\\n'\);/);
    expect(p).toMatch(/reply\.raw\.write\(`event: \$\{event\.event\}\\n`\);/);
    expect(p).toMatch(/reply\.raw\.write\(`data: \$\{data\}\\n\\n`\);/);
  });

  it("CRITICAL heartbeat is SSE-comment ':heartbeat <iso>' + setInterval.unref() to not pin process.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(
      /reply\.raw\.write\(`: heartbeat \$\{new Date\(\)\.toISOString\(\)\}\\n\\n`\);/,
    );
    expect(p).toMatch(/heartbeat\.unref\(\);/);
  });

  it('CRITICAL cleanup on close/error — clearInterval(heartbeat) + unsubscribe() + reply.raw.end() + listeners on request.raw close + error.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/const cleanup = \(\): void => \{/);
    expect(p).toMatch(/clearInterval\(heartbeat\);/);
    expect(p).toMatch(/unsubscribe\(\);/);
    expect(p).toMatch(/releaseConn\(\);/);
    expect(p).toMatch(/reply\.raw\.end\(\);/);
    expect(p).toMatch(/request\.raw\.on\('close', cleanup\);/);
    expect(p).toMatch(/request\.raw\.on\('error', cleanup\);/);
  });

  it("CRITICAL reply.hijack() — 'Keep Fastify from completing the response — we'll end manually'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toMatch(/\/\/ Keep Fastify from completing the response — we'll end manually\./);
    expect(p).toMatch(/reply\.hijack\(\);/);
  });

  it('CRITICAL /v1/status/sla has a 60/min/IP preHandler before aggregation', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'));
    expect(p).toContain("bucketPrefix: 'status_sla'");
    expect(p).toContain('capacity: AUTH_IP_LIMITS.statusSla.capacity');
    expect(p).toContain('refillPerSecond: AUTH_IP_LIMITS.statusSla.refillPerSecond');
    expect(p).toContain(
      "app.get('/v1/status/sla', { preHandler: statusSlaGate }, async (_request, reply) => {",
    );
    expect(p).toContain('const data = await sla.report(new Date());');
    expect(p).toContain("reply.header('cache-control', 'public, max-age=30');");
    expect(p).not.toContain('no extra rate-limiting needed');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-status-stream-v295e-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
