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
//   • Create audit targetResourceId is resolved lazily to the real
//     `inc_<uuid>` after create() runs (falls back to `inc_pending`
//     only if create() throws before an incident exists).
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

  it("V-1517 CRITICAL the audit suppression is safe only while the outcome union stays a no-op replay. This file's withAudit is the one admin copy that lets a caller skip the SUCCESS row, and the idempotent PUT uses it. That is correct today because createWithId answers `created` or `replayed` and a replay writes nothing, so auditing it would file a second incident.created for one logical creation. A third outcome that mutates would turn the same line into a staff mutation with no trace — and the coverage guard cannot catch it, because its own header says it asserts an audit CALL exists, not that it fires on every path. So the union is read from the service here rather than trusted.", () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'),
      'utf8',
    );
    const start = service.indexOf('async createWithId(');
    expect(start, 'createWithId is still declared in the incidents service').toBeGreaterThan(-1);
    const signature = service.slice(start, start + 900);
    const union = /outcome:\s*((?:'[a-z_]+'\s*\|\s*)*'[a-z_]+')/.exec(signature);
    expect(union?.[1], 'the declared outcome union of createWithId').toBeDefined();
    const members = (union?.[1] ?? '')
      .split('|')
      .map((x) => x.trim().replace(/'/g, ''))
      .sort();
    expect(
      members,
      'createWithId gained an outcome the audit suppression has never considered — the PUT skips ' +
        'its success row on anything that is not `created`, so a new mutating outcome would go ' +
        'unrecorded. Widen the suppression or audit the new outcome',
    ).toEqual(['created', 'replayed']);
  });

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
      /Each mutation writes an admin_audit_log row in the same request\s*\/\/\s*\(V-281 dual-write pattern\)\. Audit row's targetResourceId stores\s*\/\/\s*`inc_<uuid>` for cross-account audit-log filtering\./,
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
      /function publicIncidentUpdate\(row: IncidentUpdateRow\): IncidentUpdate \{\s*return \{\s*id: `incu_\$\{row\.id\}`,\s*incident_id: `inc_\$\{row\.incidentId\}`,\s*message: row\.message,\s*status: row\.status,\s*posted_at: row\.postedAt\.toISOString\(\),/,
    );
  });

  it('withAudit wrapper: targetAccountId always null (admin actions on global incidents); dual-write success + error with err.name lowercase /error$/ strip', () => {
    // withAudit signature — targetResourceId accepts a string OR a thunk
    // (the create route passes a thunk; the :id routes pass a string).
    expect(body).toMatch(/async function withAudit\(/);
    expect(body).toMatch(/action: AdminAuditAction,/);
    expect(body).toMatch(/targetResourceId: string \| \(\(\) => string\),/);
    expect(body).toMatch(/perform: \(\) => Promise<void>,/);
    expect(body).toContain('shouldRecordSuccess: () => boolean = () => true');
    expect(body).toContain('if (shouldRecordSuccess()) {');
    // V-1517 — the suppression carries its reason, and the reason is checked.
    expect(body).toContain('a replay writes');
    expect(body).toContain('Only a real creation is audited; a replay changed nothing.');
    // The target id is resolved at record time so the create route can
    // log the real inc_<uuid> (known only after perform()).
    expect(body).toMatch(
      /const resolveTargetResourceId = \(\): string =>\s*typeof targetResourceId === 'function' \? targetResourceId\(\) : targetResourceId;/,
    );
    expect(body).toMatch(/targetResourceId: resolveTargetResourceId\(\),/);
    expect(body).toMatch(/targetAccountId: null,/);
    expect(body).toMatch(
      /const code =\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
  });

  it("POST create: action='incident.created'; lazy real-id audit (`inc_<uuid>` resolved after create, `inc_pending` only on pre-create failure); spread-conditional affected_components ?? [] + public ?? true + started_at fallback to new Date()", () => {
    // Lazy id thunk: real inc_<uuid> on success, inc_pending only if create() throws.
    expect(body).toMatch(/\(\) => \(result \? `inc_\$\{result\.incident\.id\}` : 'inc_pending'\),/);
    expect(body).toMatch(/result = await incidentsService\.create\(\{/);
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
      /return reply\.code\(201\)\.send\(\{\s*incident: publicIncident\(created\.incident\),\s*updates: \[publicIncidentUpdate\(created\.update\)\],\s*\}\);/,
    );
  });

  it('idempotent PUT records incident.created success only for the winning mutation', () => {
    expect(body).toContain("() => result?.outcome === 'created'");
  });

  it('GET list applies state before limit and returns exact aggregate + composite cursor metadata', () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/admin\/incidents',\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toContain("const scope = parsed.data.scope ?? 'all';");
    expect(body).toContain("const state = parsed.data.state ?? 'all';");
    expect(body).toContain('const page = await incidentsService.listPage({');
    expect(body).toContain(
      'cursor: parsed.data.cursor ? decodeIncidentCursor(parsed.data.cursor) : undefined',
    );
    expect(body).toContain('open_count: page.openCount');
    expect(body).not.toMatch(/const openCount = \(\s*await incidentsService\.listPage/);
    expect(body).toContain(
      'next_cursor: page.nextCursor ? encodeIncidentCursor(page.nextCursor) : null',
    );
  });

  it("GET detail: uuidFromPrefixedId('inc'); incidentsService.get; reply { incident, updates }", () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/incidents\/:id',\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toMatch(/const id = uuidFromPrefixedId\(request\.params\.id, 'inc'\);/);
    expect(body).toMatch(
      /return \{\s*incident: publicIncident\(result\.incident\),\s*updates: result\.updates\.map\(publicIncidentUpdate\),\s*\};/,
    );
  });

  it("POST append-update: action='incident.updated'; incidentsService.addUpdate with postedByAdminId/KeyId; reply 201 publicIncidentUpdate", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/incidents\/:id\/updates',/,
    );
    expect(body).toMatch(
      /await withAudit\(request, 'incident\.updated', `inc_\$\{id\}`, parsed\.data, async \(\) => \{\s*result = await incidentsService\.addUpdate\(\{\s*incidentId: id,\s*message: parsed\.data\.message,\s*status: parsed\.data\.status,\s*postedByAdminId: ctx\.account\.id,\s*postedByAdminKeyId: ctx\.apiKey\.id,/,
    );
  });

  it("POST resolve: action='incident.resolved'; incidentsService.resolve; reply 200 { incident, update }", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/incidents\/:id\/resolve',/,
    );
    expect(body).toMatch(
      /await withAudit\(request, 'incident\.resolved', `inc_\$\{id\}`, parsed\.data, async \(\) => \{\s*result = await incidentsService\.resolve\(\{\s*incidentId: id,\s*message: parsed\.data\.message,\s*postedByAdminId: ctx\.account\.id,\s*postedByAdminKeyId: ctx\.apiKey\.id,/,
    );
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*incident: publicIncident\(resolved\.incident\),\s*update: publicIncidentUpdate\(resolved\.update\),\s*\}\);/,
    );
  });

  it('V-545.A PUBLIC GET /v1/status/incidents/:id surfaces public-only incidents with their full update timeline — registered + delegates to incidentsService.get(id, {publicOnly:true}) + maps via publicIncidentUpdate + Cache-Control 30s + IP-rate-limit gate (2026-05-20 defense-in-depth)', () => {
    expect(body).toMatch(/V-545\.A — status-page incident-detail view\./);
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/status\/incidents\/:id',\s*\{ preHandler: statusIncidentDetailGate \},\s*async \(request, reply\) => \{\s*const id = uuidFromPrefixedId\(request\.params\.id, 'inc'\);\s*const result = await incidentsService\.get\(id, \{ publicOnly: true \}\);\s*reply\.header\('cache-control', 'public, max-age=30'\);/,
    );
    expect(body).toMatch(
      /return \{\s*incident: publicIncident\(result\.incident\),\s*updates: result\.updates\.map\(publicIncidentUpdate\),\s*\};/,
    );
  });

  it('PUBLIC GET uses all-time open truth plus selectable bounded resolved history', () => {
    expect(body).toMatch(
      /\/\/ The status page consumes this; no auth required, only public=true rows\s*\/\/ surfaced\. Open incidents are all-time; resolved history defaults to 30d\./,
    );
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/status\/incidents',\s*\{ preHandler: statusIncidentsListGate \},\s*async \(request, reply\) => \{\s*const parsed = ListIncidentsQuerySchema\.safeParse\(\{\s*\.\.\.\(request\.query \?\? \{\}\),\s*scope: 'public',\s*\}\);/,
    );
    expect(body).toMatch(/parsed\.data\.window === '90d' \? 90 : 30/);
    expect(body).toContain('const feed = await incidentsService.publicFeed({');
    expect(body).toContain('open_count: feed.openCount');
    expect(body).toContain('open_outage_count: feed.openOutageCount');
    expect(body).toContain('truncated: feed.truncated');
  });

  it('Schemas from @driftstack/api-types: AddIncidentUpdate + CreateIncident + ListIncidents + ResolveIncident + Incident/IncidentUpdate types', () => {
    expect(body).toMatch(
      /import \{\s*AddIncidentUpdateRequestSchema,\s*CreateIncidentRequestSchema,\s*ListIncidentsQuerySchema,\s*ResolveIncidentRequestSchema,\s*\} from '@driftstack\/api-types';/,
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
    expect(body).toContain('IncidentListCursor,');
    expect(body).toContain('IncidentRow,');
    expect(body).toContain('IncidentUpdateRow,');
    expect(body).toContain('IncidentsService,');
    expect(body).toMatch(
      /import \{ BadRequestError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
