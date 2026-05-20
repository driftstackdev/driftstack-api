// W420.B — drift guard for apps/server/src/routes/admin-incidents.ts.
// V-295a admin-only incident management + V-281 dual-write audit
// pattern on every mutation. Drift here either drops audit on
// mutations (silent admin actions) or breaks the public /v1/status/
// incidents 30d default window (status page shows incomplete history).
//
//   • V-295a framing pinned: 5 admin routes (create/list/detail/
//     append-update/resolve) + 2 PUBLIC routes (/v1/status/incidents
//     list + /v1/status/incidents/:id detail — V-545.A timeline).
//   • V-281 dual-write framing pinned: every mutation writes
//     admin_audit_log; targetResourceId is `inc_<uuid>` (cross-
//     account audit-log filtering).
//   • Public route: no-auth; scope='public' coerce; 30-day default
//     window; default limit 50.
//   • Scope-gate pattern: requireScope('driftstack_internal_admin')
//     on all 5 admin routes; mutations also have rateLimit('global'),
//     listing/detail GETs do not (lower-cost reads).
//   • publicIncident: inc_<uuid> + affected_components spread copy +
//     11-field wire shape with nullable resolved_at + ISO timestamps.
//   • publicIncidentUpdate: incu_<uuid> + incident_id=inc_<uuid> +
//     message + status + posted_at ISO.
//   • Pending-id audit pre-create: `inc_pending` written when
//     creating (real id not yet assigned).
//   • Schemas: Add/Create/List/Resolve from @driftstack/api-types.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W420.B apps/server/src/routes/admin-incidents.ts content parity', () => {
  const body = read(LIB);

  it('V-295a framing pinned: 5 admin routes (create + list + detail + append-update + resolve) + V-281 dual-write audit pattern on every mutation', () => {
    expect(body).toMatch(/V-295a — admin-only incident management endpoints\./);
    expect(body).toMatch(/POST\s+\/v1\/admin\/incidents\s+— create new incident/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/incidents\s+— list \(scope=all by default\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/incidents\/:id\s+— detail \(incident \+ updates\)/);
    expect(body).toMatch(/POST\s+\/v1\/admin\/incidents\/:id\/updates\s+— append timeline update/);
    expect(body).toMatch(
      /POST\s+\/v1\/admin\/incidents\/:id\/resolve\s+— mark resolved with final update/,
    );
    expect(body).toMatch(
      /Each mutation writes an admin_audit_log row in the same request\s*\n?\s*\/\/\s*\(V-281 dual-write pattern\)\. Audit row's targetResourceId stores\s*\n?\s*\/\/\s*`inc_<uuid>` for cross-account audit-log filtering\./,
    );
  });

  it('publicIncident: inc_<uuid> + 11-field shape with affected_components spread copy + nullable resolved_at + ISO timestamps; returns Incident type from @driftstack/api-types', () => {
    expect(body).toMatch(/function publicIncident\(row: IncidentRow\): Incident \{/);
    expect(body).toMatch(/id: `inc_\$\{row\.id\}`,/);
    expect(body).toMatch(/severity: row\.severity,/);
    expect(body).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(body).toMatch(/public: row\.public,/);
    expect(body).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(body).toMatch(
      /resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/,
    );
  });

  it('publicIncidentUpdate: incu_<uuid> + incident_id=inc_<uuid> + message + status + posted_at ISO', () => {
    expect(body).toMatch(
      /function publicIncidentUpdate\(row: IncidentUpdateRow\): IncidentUpdate \{\s*\n?\s*return \{\s*\n?\s*id: `incu_\$\{row\.id\}`,\s*\n?\s*incident_id: `inc_\$\{row\.incidentId\}`,\s*\n?\s*message: row\.message,\s*\n?\s*status: row\.status,\s*\n?\s*posted_at: row\.postedAt\.toISOString\(\),/,
    );
  });

  it('withAudit wrapper: targetAccountId always null (admin actions on global incidents); dual-write success + error with err.name lowercase /error$/ strip', () => {
    expect(body).toMatch(
      /async function withAudit\(\s*\n?\s*request: FastifyRequest,\s*\n?\s*action: AdminAuditAction,\s*\n?\s*targetResourceId: string,\s*\n?\s*inputPayload: Record<string, unknown>,\s*\n?\s*perform: \(\) => Promise<void>,\s*\n?\s*\): Promise<void> \{/,
    );
    expect(body).toMatch(/targetAccountId: null,/);
    expect(body).toMatch(
      /const code =\s*\n?\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
  });

  it("POST create: action='incident.created'; pending-id audit pre-create (`inc_pending`); spread-conditional affected_components ?? [] + public ?? true + started_at fallback to new Date()", () => {
    expect(body).toMatch(/const tempId = 'pending';/);
    expect(body).toMatch(
      /await withAudit\(request, 'incident\.created', `inc_\$\{tempId\}`, parsed\.data, async \(\) => \{\s*\n?\s*result = await incidentsService\.create\(\{/,
    );
    expect(body).toMatch(/affectedComponents: parsed\.data\.affected_components \?\? \[\],/);
    expect(body).toMatch(/public: parsed\.data\.public \?\? true,/);
    expect(body).toMatch(
      /startedAt: parsed\.data\.started_at \? new Date\(parsed\.data\.started_at\) : new Date\(\),/,
    );
    expect(body).toMatch(/createdByAdminId: ctx\.account\.id,/);
    expect(body).toMatch(/createdByAdminKeyId: ctx\.apiKey\.id,/);
  });

  it('POST create reply 201: { incident: publicIncident(created.incident), updates: [publicIncidentUpdate(created.update)] }', () => {
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*incident: publicIncident\(created\.incident\),\s*\n?\s*updates: \[publicIncidentUpdate\(created\.update\)\],\s*\n?\s*\}\);/,
    );
  });

  it("GET list: scope-only preHandler (no rate-limit); scope ?? 'all' default; since pass-through Date(); limit pass-through", () => {
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/admin\/incidents',\s*\n?\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toMatch(
      /const rows = await incidentsService\.list\(\{\s*\n?\s*scope: parsed\.data\.scope \?\? 'all',\s*\n?\s*since: parsed\.data\.since \? new Date\(parsed\.data\.since\) : undefined,\s*\n?\s*limit: parsed\.data\.limit,\s*\n?\s*\}\);/,
    );
  });

  it("GET detail: uuidFromPrefixedId('inc'); incidentsService.get; reply { incident, updates }", () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/incidents\/:id',\s*\n?\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toMatch(/const id = uuidFromPrefixedId\(request\.params\.id, 'inc'\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*incident: publicIncident\(result\.incident\),\s*\n?\s*updates: result\.updates\.map\(publicIncidentUpdate\),\s*\n?\s*\};/,
    );
  });

  it("POST append-update: action='incident.updated'; incidentsService.addUpdate with postedByAdminId/KeyId; reply 201 publicIncidentUpdate", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/incidents\/:id\/updates',/,
    );
    expect(body).toMatch(
      /await withAudit\(request, 'incident\.updated', `inc_\$\{id\}`, parsed\.data, async \(\) => \{\s*\n?\s*result = await incidentsService\.addUpdate\(\{\s*\n?\s*incidentId: id,\s*\n?\s*message: parsed\.data\.message,\s*\n?\s*status: parsed\.data\.status,\s*\n?\s*postedByAdminId: ctx\.account\.id,\s*\n?\s*postedByAdminKeyId: ctx\.apiKey\.id,/,
    );
  });

  it("POST resolve: action='incident.resolved'; incidentsService.resolve; reply 200 { incident, update }", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/incidents\/:id\/resolve',/,
    );
    expect(body).toMatch(
      /await withAudit\(request, 'incident\.resolved', `inc_\$\{id\}`, parsed\.data, async \(\) => \{\s*\n?\s*result = await incidentsService\.resolve\(\{\s*\n?\s*incidentId: id,\s*\n?\s*message: parsed\.data\.message,\s*\n?\s*postedByAdminId: ctx\.account\.id,\s*\n?\s*postedByAdminKeyId: ctx\.apiKey\.id,/,
    );
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*incident: publicIncident\(resolved\.incident\),\s*\n?\s*update: publicIncidentUpdate\(resolved\.update\),\s*\n?\s*\}\);/,
    );
  });

  it('V-545.A PUBLIC GET /v1/status/incidents/:id surfaces public-only incidents with their full update timeline — registered + delegates to incidentsService.get(id, {publicOnly:true}) + maps via publicIncidentUpdate + Cache-Control 30s + IP-rate-limit gate (2026-05-20 defense-in-depth)', () => {
    expect(body).toMatch(/V-545\.A — status-page incident-detail view\./);
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/status\/incidents\/:id',\s*\n?\s*\{ preHandler: statusIncidentDetailGate \},\s*\n?\s*async \(request, reply\) => \{\s*\n?\s*const id = uuidFromPrefixedId\(request\.params\.id, 'inc'\);\s*\n?\s*const result = await incidentsService\.get\(id, \{ publicOnly: true \}\);\s*\n?\s*reply\.header\('cache-control', 'public, max-age=30'\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*incident: publicIncident\(result\.incident\),\s*\n?\s*updates: result\.updates\.map\(publicIncidentUpdate\),\s*\n?\s*\};/,
    );
  });

  it("PUBLIC GET /v1/status/incidents: no-auth (only the IP-rate-limit preHandler gate); scope='public' forced coerce; 30-day default since; limit default 50", () => {
    expect(body).toMatch(
      /\/\/ The status page consumes this; no auth required, only public=true rows\s*\n?\s*\/\/ surfaced\. Limited to the last 30 days by default\./,
    );
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/status\/incidents',\s*\n?\s*\{ preHandler: statusIncidentsListGate \},\s*\n?\s*async \(request, reply\) => \{\s*\n?\s*const parsed = ListIncidentsQuerySchema\.safeParse\(\{\s*\n?\s*\.\.\.\(request\.query \?\? \{\}\),\s*\n?\s*scope: 'public',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const since =\s*\n?\s*parsed\.data\.since !== undefined\s*\n?\s*\? new Date\(parsed\.data\.since\)\s*\n?\s*: new Date\(Date\.now\(\) - 30 \* 24 \* 60 \* 60 \* 1000\);/,
    );
    expect(body).toMatch(
      /const rows = await incidentsService\.list\(\{\s*\n?\s*scope: 'public',\s*\n?\s*since,\s*\n?\s*limit: parsed\.data\.limit \?\? 50,\s*\n?\s*\}\);/,
    );
  });

  it('Schemas from @driftstack/api-types: AddIncidentUpdate + CreateIncident + ListIncidents + ResolveIncident + Incident/IncidentUpdate types', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*AddIncidentUpdateRequestSchema,\s*\n?\s*CreateIncidentRequestSchema,\s*\n?\s*ListIncidentsQuerySchema,\s*\n?\s*ResolveIncidentRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{ Incident, IncidentUpdate \} from '@driftstack\/api-types';/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + AdminAuditAction/Service + IncidentRow/IncidentUpdateRow/IncidentsService + BadRequestError/ValidationError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ AdminAuditAction, AdminAuditService \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentUpdateRow, IncidentsService \} from '\.\.\/services\/incidents\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
