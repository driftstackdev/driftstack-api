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
//   • Cleanup pinned: clearInterval + unsubscribe + reply.raw.end()
//     fires on request.raw 'close' AND 'error'.
//   • setInterval handle .unref() (don't pin event loop).
//   • reply.hijack() at end so Fastify doesn't complete response.
//   • SLA framing pinned: same no-auth posture as
//     /v1/status/incidents; cheap aggregate (~43k rows in 30d) →
//     no extra rate-limiting.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W412.B apps/server/src/routes/status-stream.ts content parity', () => {
  const body = read(LIB);

  it('V-295e framing pinned: GET /v1/status/stream SSE + GET /v1/status/sla rolling 30d uptime', () => {
    expect(body).toMatch(/V-295e — public status streaming \+ SLA endpoints\./);
    expect(body).toMatch(
      /GET \/v1\/status\/stream — Server-Sent Events\. Clients connect with\s*\n?\s*\/\/\s*`EventSource\(url\)` and receive every public incident\.created \/\s*\n?\s*\/\/\s*incident\.resolved event in real time\. Heartbeat every 30s keeps\s*\n?\s*\/\/\s*the connection alive through proxies\./,
    );
    expect(body).toMatch(
      /GET \/v1\/status\/sla — rolling 30-day uptime per probe target,\s*\n?\s*\/\/\s*computed from the V-295b system_health_probes table\./,
    );
  });

  it('Unauth + connection-limit posture pinned: status site is public; SSE has NO app-level cap and Fastify/Node set no maxConnections — bounded only at the OS/Cloudflare edge (surfaced gap)', () => {
    expect(body).toMatch(/Both endpoints are unauthenticated \(the status site is public\)\./);
    // Corrected posture: NO app-level cap + no Fastify/Node maxConnections (the
    // prior "connection-limited by Fastify itself" claim was inaccurate).
    expect(body).toMatch(/rate-limit or concurrent-connection cap, and Fastify\/Node set no/);
    expect(body).toMatch(/TCP-connection ceiling at the OS \/ Cloudflare edge layer/);
  });

  it('Heartbeat default 30_000ms with proxy-timeout rationale (Cloudflare 60s)', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*Heartbeat interval in ms\. Defaults to 30s — well below typical\s*\n?\s*\*\s*proxy idle-timeouts \(60s on Cloudflare, longer elsewhere\)\.\s*\n?\s*\*\//,
    );
    expect(body).toMatch(/const heartbeatMs = opts\.heartbeatMs \?\? 30_000;/);
  });

  it('SSE response headers: text/event-stream utf-8 + no-cache,no-transform + keep-alive + x-accel-buffering:no + W586 CORS spread', () => {
    expect(body).toMatch(
      /reply\.raw\.writeHead\(200, \{\s*\n?\s*'content-type': 'text\/event-stream; charset=utf-8',\s*\n?\s*'cache-control': 'no-cache, no-transform',\s*\n?\s*connection: 'keep-alive',\s*\n?\s*'x-accel-buffering': 'no',\s*\/\/\s*disable nginx-style buffering/,
    );
    // W586 — hijacked SSE reply must reflect ACAO itself (bypasses cors hook).
    expect(body).toMatch(/\.\.\.sseCorsHeaders\(request\.headers\.origin, opts\.cors \?\? \{\}\)/);
  });

  it("Initial flush: ': stream open' comment to flush headers on some proxies", () => {
    expect(body).toMatch(
      /\/\/ Initial comment to flush headers immediately on some proxies\.\s*\n?\s*reply\.raw\.write\(': stream open\\n\\n'\);/,
    );
  });

  it('Event framing: send() emits `event: <name>` + `data: <json>` + blank-line terminator', () => {
    expect(body).toMatch(
      /const send = \(event: IncidentEvent\): void => \{\s*\n?\s*const data = JSON\.stringify\(event\);\s*\n?\s*\/\/ SSE framing: `event:` \(named\) \+ `data:` \+ blank-line terminator\.\s*\n?\s*reply\.raw\.write\(`event: \$\{event\.event\}\\n`\);\s*\n?\s*reply\.raw\.write\(`data: \$\{data\}\\n\\n`\);/,
    );
  });

  it('Heartbeat: setInterval emits SSE comment `: heartbeat <iso>` + .unref() (no event-loop pin)', () => {
    expect(body).toMatch(/const unsubscribe = bus\.subscribe\(send\);/);
    expect(body).toMatch(
      /const heartbeat = setInterval\(\(\) => \{\s*\n?\s*\/\/ SSE comment lines \(start with `:`\) are heartbeats — no data\.\s*\n?\s*reply\.raw\.write\(`: heartbeat \$\{new Date\(\)\.toISOString\(\)\}\\n\\n`\);\s*\n?\s*\}, heartbeatMs\);\s*\n?\s*heartbeat\.unref\(\);/,
    );
  });

  it('Cleanup: clearInterval + unsubscribe + reply.raw.end() on request.raw close AND error', () => {
    expect(body).toMatch(
      /const cleanup = \(\): void => \{\s*\n?\s*clearInterval\(heartbeat\);\s*\n?\s*unsubscribe\(\);\s*\n?\s*reply\.raw\.end\(\);\s*\n?\s*\};/,
    );
    expect(body).toMatch(/request\.raw\.on\('close', cleanup\);/);
    expect(body).toMatch(/request\.raw\.on\('error', cleanup\);/);
  });

  it('reply.hijack() at end so Fastify does not auto-complete response', () => {
    expect(body).toMatch(
      /\/\/ Keep Fastify from completing the response — we'll end manually\.\s*\n?\s*reply\.hijack\(\);/,
    );
  });

  it('SLA endpoint: same no-auth posture; cheap aggregate ~43k rows in 30d; no extra rate-limiting; returns {data}', () => {
    expect(body).toMatch(
      /\/\/ \/v1\/status\/sla — same no-auth posture as \/v1\/status\/incidents\.\s*\n?\s*\/\/ The query is a cheap aggregate over a small table \(one probe\/min\s*\n?\s*\/\/ per target = ~43k rows in 30d\), so no extra rate-limiting needed\./,
    );
    expect(body).toMatch(
      /app\.get\('\/v1\/status\/sla', async \(\) => \{\s*\n?\s*const data = await sla\.report\(new Date\(\)\);\s*\n?\s*return \{ data \};\s*\n?\s*\}\);/,
    );
  });

  it('StatusStreamRoutesOptions: bus + sla + optional heartbeatMs', () => {
    expect(body).toMatch(/export interface StatusStreamRoutesOptions \{/);
    expect(body).toMatch(/bus: IncidentEventBus;/);
    expect(body).toMatch(/sla: SlaReportingService;/);
    expect(body).toMatch(/heartbeatMs\?: number;/);
  });

  it('imports: FastifyInstance + IncidentEvent/IncidentEventBus + SlaReportingService', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ IncidentEvent, IncidentEventBus \} from '\.\.\/services\/incident-event-bus\.js';/,
    );
    expect(body).toMatch(
      /import type \{ SlaReportingService \} from '\.\.\/services\/sla-reporting\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
