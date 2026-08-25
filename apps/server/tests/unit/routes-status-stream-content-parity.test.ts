// W412.B — drift guard for apps/server/src/routes/status-stream.ts.
// V-295e public status streaming + SLA endpoints. SSE for live
// incident events + 30d rolling SLA aggregate. Drift here either
// breaks proxy keep-alive (status page disconnects every 60s) or
// drops `reply.hijack()` (Fastify auto-finishes the response and
// breaks the stream).
//
//   • V-295e framing pinned: GET /v1/status/stream SSE + GET
//     /v1/status/sla rolling 30d uptime.
//   • SSE protocol pinned: text/event-stream charset utf-8 +
//     cache-control no-cache,no-transform + connection keep-alive +
//     x-accel-buffering:no (nginx-style buffer kill).
//   • Heartbeat framing pinned: 30s default, well below typical
//     proxy idle-timeouts (60s on Cloudflare); SSE comment-line
//     `: heartbeat <iso>` (start-with-colon = comment).
//   • Initial flush comment `: stream open` to flush headers
//     immediately on some proxies.
//   • Event framing pinned: `event:` named + `data:` JSON + blank-line
//     terminator.
//   • Cleanup pinned: idempotent clearInterval + unsubscribe + releaseConn +
//     reply.raw.end() fires on request.raw 'close' AND 'error'. Capacity is
//     acquired only after that cleanup is wired, so setup failures leak no slot.
//   • Event and heartbeat writes enforce the 4MB per-stream buffer ceiling.
//   • setInterval handle .unref() (don't pin event loop).
//   • reply.hijack() at end so Fastify doesn't complete response.
//   • Public-resource gates pinned: SSE allows at most 500 total / 10
//     per IP; SLA has a route-specific 60/min/IP token bucket.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W412.B apps/server/src/routes/status-stream.ts content parity', () => {
  const body = read(LIB);

  it('V-295e framing pinned: GET /v1/status/stream SSE + GET /v1/status/sla rolling 30d uptime', () => {
    expect(body).toMatch(/V-295e — public status streaming \+ SLA endpoints\./);
    expect(body).toMatch(
      /GET \/v1\/status\/stream — Server-Sent Events\. Clients connect with\s*\/\/\s*`EventSource\(url\)` and receive every public incident\.created \/\s*\/\/\s*incident\.resolved event in real time\. Heartbeat every 30s keeps\s*\/\/\s*the connection alive through proxies\./,
    );
    expect(body).toMatch(
      /GET \/v1\/status\/sla — rolling 30-day uptime per probe target,\s*\/\/\s*computed from the V-295b system_health_probes table\./,
    );
  });

  it('Unauthenticated public posture has route-level resource bounds', () => {
    expect(body).toContain('Both endpoints are unauthenticated (the status site is public).');
    expect(body).toContain('60/min/IP direct-request budget');
    expect(body).toContain('500 total connections and 10 per IP');
    expect(body).not.toContain('NO app-level');
  });

  it('SSE capacity gate rejects before hijack, acquires after cleanup wiring, and releases idempotently', () => {
    expect(body).toContain('const MAX_TOTAL_CONNECTIONS = 500;');
    expect(body).toContain('const MAX_CONNECTIONS_PER_IP = 10;');
    expect(body).toContain(
      'if (openTotal >= MAX_TOTAL_CONNECTIONS || perIp >= MAX_CONNECTIONS_PER_IP)',
    );
    expect(body).toContain("reply.header('retry-after', '30');");
    expect(body).toContain(
      "throw new FeatureUnavailableError('Status stream at capacity; retry shortly.');",
    );
    expect(body).toContain('if (!acquired || released) return;');
    expect(body).toContain('releaseConn();');
    const cleanupWired = body.indexOf("request.raw.on('error', cleanup);");
    const acquired = body.indexOf('openTotal += 1;');
    expect(cleanupWired).toBeGreaterThan(-1);
    expect(acquired).toBeGreaterThan(cleanupWired);
  });

  it('Heartbeat default 30_000ms with proxy-timeout rationale (Cloudflare 60s)', () => {
    expect(body).toMatch(
      /\/\*\*\s*\*\s*Heartbeat interval in ms\. Defaults to 30s — well below typical\s*\*\s*proxy idle-timeouts \(60s on Cloudflare, longer elsewhere\)\.\s*\*\//,
    );
    expect(body).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? 30_000;/);
  });

  // SPLIT. The chain ran from `writeHead(200, {` straight into `content-type` as
  // consecutive lines, so inheriting the pipeline's headers — which must be
  // spread FIRST, before the route's own values — broke a pin about which
  // headers the stream sets. The entry list is pinned on its own below.
  it('SSE response headers: text/event-stream utf-8 + no-cache,no-transform + keep-alive + x-accel-buffering:no + W586 CORS spread', () => {
    expect(body).toMatch(/reply\.raw\.writeHead\(200, \{/);
    expect(body).toMatch(
      /'content-type': 'text\/event-stream; charset=utf-8',\s*'cache-control': 'no-cache, no-transform',\s*connection: 'keep-alive',\s*'x-accel-buffering': 'no',\s*\/\/\s*disable nginx-style buffering/,
    );
    // W586 — hijacked SSE reply must reflect ACAO itself (bypasses cors hook).
    expect(body).toMatch(/\.\.\.sseCorsHeaders\(request\.headers\.origin, opts\.cors \?\? \{\}\)/);
  });

  it("Initial flush: ': stream open' comment to flush headers on some proxies", () => {
    expect(body).toMatch(
      /\/\/ Initial comment to flush headers immediately on some proxies\.\s*reply\.raw\.write\(': stream open\\n\\n'\);/,
    );
  });

  it('Event framing: send() emits `event: <name>` + `data: <json>` + blank-line terminator', () => {
    expect(body).toMatch(
      /const send = \(event: IncidentEvent\): void => \{\s*if \(closed\) return;\s*const data = JSON\.stringify\(event\);\s*\/\/ SSE framing: `event:` \(named\) \+ `data:` \+ blank-line terminator\.\s*reply\.raw\.write\(`event: \$\{event\.event\}\\n`\);\s*reply\.raw\.write\(`data: \$\{data\}\\n\\n`\);\s*closeIfBackpressured\(\);/,
    );
  });

  it('Heartbeat: setInterval emits SSE comment `: heartbeat <iso>` + .unref() (no event-loop pin)', () => {
    expect(body).toMatch(/unsubscribe = bus\.subscribe\(send\);/);
    expect(body).toMatch(
      /heartbeat = setInterval\(\(\) => \{\s*if \(closed\) return;\s*\/\/ SSE comment lines \(start with `:`\) are heartbeats — no data\.\s*reply\.raw\.write\(`: heartbeat \$\{new Date\(\)\.toISOString\(\)\}\\n\\n`\);\s*closeIfBackpressured\(\);\s*\}, heartbeatMs\);\s*heartbeat\.unref\(\);/,
    );
  });

  it('Event and heartbeat writes close a stream past the established 4MB buffer ceiling', () => {
    // The ceiling is shared, not redeclared: it used to be a local
    // `const MAX_SSE_BUFFER_BYTES = 4_000_000;` in each of the three SSE
    // routes, each pinned by its own parity test, with nothing requiring the
    // three to agree. Pin the import so a copy cannot come back.
    expect(body).toContain("from '../lib/sse-backpressure.js'");
    expect(body).not.toMatch(/const MAX_SSE_BUFFER_BYTES = /);
    expect(body).toMatch(
      /const closeIfBackpressured = \(\): void => \{\s*if \(reply\.raw\.writableLength > MAX_SSE_BUFFER_BYTES\) cleanup\(\);\s*\};/,
    );
    expect(body.match(/closeIfBackpressured\(\);/g)).toHaveLength(2);
  });

  it('Cleanup: exactly-once clearInterval + unsubscribe + releaseConn + reply.raw.end() on close/error', () => {
    expect(body).toMatch(
      /const cleanup = \(\): void => \{[\s\S]*?if \(closed\) return;\s*closed = true;\s*if \(heartbeat !== undefined\) clearInterval\(heartbeat\);\s*unsubscribe\(\);\s*releaseConn\(\);\s*reply\.raw\.end\(\);\s*\};/,
    );
    expect(body).toMatch(/request\.raw\.on\('close', cleanup\);/);
    expect(body).toMatch(/request\.raw\.on\('error', cleanup\);/);
  });

  it('reply.hijack() at end so Fastify does not auto-complete response', () => {
    expect(body).toMatch(
      /\/\/ Keep Fastify from completing the response — we'll end manually\.\s*reply\.hijack\(\);/,
    );
  });

  it('SLA endpoint: public + route-specific 60/min/IP gate + {data} response', () => {
    expect(body).toContain(
      '// /v1/status/sla — same public/no-auth posture as /v1/status/incidents.',
    );
    expect(body).toContain("bucketPrefix: 'status_sla'");
    expect(body).toContain('capacity: AUTH_IP_LIMITS.statusSla.capacity');
    expect(body).toContain('refillPerSecond: AUTH_IP_LIMITS.statusSla.refillPerSecond');
    expect(body).toContain(
      "app.get('/v1/status/sla', { preHandler: statusSlaGate }, async (_request, reply) => {",
    );
    expect(body).toContain('const data = await sla.report(new Date());');
    expect(body).toContain("reply.header('cache-control', 'public, max-age=30');");
    expect(body).toContain('return { data };');
    expect(body).not.toContain('no extra rate-limiting needed');
  });

  it('StatusStreamRoutesOptions: bus + sla + rateLimitStore + optional heartbeatMs', () => {
    expect(body).toMatch(/export interface StatusStreamRoutesOptions \{/);
    expect(body).toMatch(/bus: IncidentEventBus;/);
    expect(body).toMatch(/sla: SlaReportingService;/);
    expect(body).toMatch(/rateLimitStore: RateLimitStore;/);
    expect(body).toMatch(/heartbeatMs\?: number;/);
  });

  it('imports: FastifyInstance + IP limiter/config + RateLimitStore + stream/SLA services', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toContain(
      "import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';",
    );
    expect(body).toContain("import { FeatureUnavailableError } from '../lib/errors.js';");
    expect(body).toMatch(
      /import type \{ IncidentEvent, IncidentEventBus \} from '\.\.\/services\/incident-event-bus\.js';/,
    );
    expect(body).toMatch(
      /import type \{ SlaReportingService \} from '\.\.\/services\/sla-reporting\.js';/,
    );
    expect(body).toContain("import type { RateLimitStore } from '../services/rate-limit.js';");
  });

  it('buildApp wires the shared production rate-limit store into status routes', () => {
    const app = read(APP);
    expect(app).toContain(`registerStatusStreamRoutes(app, {
      bus: deps.incidentEventBus,
      sla: deps.slaReportingService,
      rateLimitStore: deps.rateLimitStore,`);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
