// W1042 — routes/admin-incidents V-295a + V-281 cross-source invariant.
// Pins the apps/server/src/routes/admin-incidents.ts admin incident
// management routes:
//
//   V-295a anchor — 'V-295a — admin-only incident management endpoints'.
//
//   Endpoint roster — 5 admin endpoints + 1 public:
//     POST   /v1/admin/incidents
//     GET    /v1/admin/incidents
//     GET    /v1/admin/incidents/:id
//     POST   /v1/admin/incidents/:id/updates
//     POST   /v1/admin/incidents/:id/resolve
//     GET    /v1/status/incidents (public, no auth)
//
//   V-281 dual-write framing — 'Each mutation writes an admin_audit_log
//   row in the same request (V-281 dual-write pattern). Audit row's
//   targetResourceId stores inc_<uuid> for cross-account audit-log
//   filtering'.
//
//   driftstack_internal_admin scope required on every admin endpoint.
//
//   PUBLIC_ID_RE prefix_uuid pattern — '^[a-z]{3}_(uuid)$'.
//
//   publicIncident envelope shape — 11 fields including affected_components
//   (spread to new array, not aliased) + ISO timestamps + public flag.
//
//   publicIncidentUpdate envelope shape — id (incu_ prefix) + incident_id
//   (inc_ prefix) + message + status + posted_at.
//
//   Public status-incidents 30-day default window — Date.now() -
//   30 * 24 * 60 * 60 * 1000.
//
//   incident.created / incident.updated / incident.resolved AdminAuditAction
//   strings.
//
// stays in lockstep across apps/server/src/routes/admin-incidents.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1042 routes/admin-incidents V-295a + V-281 cross-source invariant', () => {
  // ─── V-295a + V-281 framing ──────────────────────────────────

  it("CRITICAL V-295a anchor — 'V-295a — admin-only incident management endpoints'. The single-anchor design ties the admin surface to the V-295 incident protocol family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/V-295a — admin-only incident management endpoints\./);
  });

  it("CRITICAL V-281 dual-write framing — 'Each mutation writes an admin_audit_log row in the same request (V-281 dual-write pattern). Audit row's targetResourceId stores inc_<uuid> for cross-account audit-log filtering'. The synchronous-write design ensures every admin mutation is auditable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/Each mutation writes an admin_audit_log row in the same request/);
    expect(p).toMatch(/\(V-281 dual-write pattern\)\. Audit row's targetResourceId stores/);
    expect(p).toMatch(/`inc_<uuid>` for cross-account audit-log filtering\./);
  });

  // ─── Endpoint roster ─────────────────────────────────────────

  it('CRITICAL endpoint roster — 5 admin routes + 1 public status route. The exhaustive header comment is the canonical contract for the incident surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/POST\s+\/v1\/admin\/incidents\s+— create new incident/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/incidents\s+— list \(scope=all by default\)/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/incidents\/:id\s+— detail \(incident \+ updates\)/);
    expect(p).toMatch(/POST\s+\/v1\/admin\/incidents\/:id\/updates\s+— append timeline update/);
    expect(p).toMatch(
      /POST\s+\/v1\/admin\/incidents\/:id\/resolve\s+— mark resolved with final update/,
    );
  });

  it('CRITICAL driftstack_internal_admin scope required on every admin endpoint. The hardcoded scope name is the canonical admin-key check; drift to a different scope would silently let normal customer keys hit admin routes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    // Was `>= 5` against a file carrying 7 admin gates — two spare, and a bound
    // with spare cannot see an admin route added without the scope.
    //
    // This file registers BOTH surfaces: /v1/admin/incidents/* (staff-gated) and
    // /v1/status/incidents/* (the public status page, deliberately ungated). So
    // the roster is the admin paths only, and the gate count must match it.
    const code = p
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const adminRoutes =
      code.match(/^\s*app\.(?:get|post|patch|put|delete)[^\n]*\n?[^\n]*'\/v1\/admin\//gm) ?? [];
    expect(
      adminRoutes.length,
      'the derived admin-route roster must not collapse',
    ).toBeGreaterThanOrEqual(7);
    const adminScopeRefs = code.match(/app\.requireScope\('driftstack_internal_admin'\)/g) ?? [];
    expect(
      adminScopeRefs.length,
      'one driftstack_internal_admin gate per /v1/admin route (public /v1/status routes are excluded)',
    ).toBe(adminRoutes.length);
  });

  // ─── PUBLIC_ID_RE prefix pattern ─────────────────────────────

  it("CRITICAL PUBLIC_ID_RE — '^[a-z]{3}_(uuid)$'. The 3-letter prefix + UUID-with-dashes design matches the rest of the public-id roster.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
  });

  it('CRITICAL uuidFromPrefixedId — throws BadRequestError with \'Invalid id format. Expected "<prefix>_<uuid>".\' The error message format is the same across all prefix-id validators; drift would diverge the error UX.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(
      /throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\)/,
    );
  });

  // ─── publicIncident envelope ─────────────────────────────────

  it('CRITICAL publicIncident envelope — 11 fields (id inc_<uuid> / title / description / severity / status / affected_components spread to new array / public / started_at ISO / resolved_at ISO|null / created_at ISO / updated_at ISO). The spread-to-new-array detail prevents accidental shared-reference mutation across api responses.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/id: `inc_\$\{row\.id\}`,/);
    expect(p).toMatch(/title: row\.title,/);
    expect(p).toMatch(/description: row\.description,/);
    expect(p).toMatch(/severity: row\.severity,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(p).toMatch(/public: row\.public,/);
    expect(p).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(p).toMatch(/resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  // ─── publicIncidentUpdate envelope ───────────────────────────

  it('CRITICAL publicIncidentUpdate envelope — 5 fields (id incu_<uuid> / incident_id inc_<uuid> / message / status / posted_at ISO). The dual-prefix design (incu_ + inc_) lets clients route update events back to the parent incident.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/id: `incu_\$\{row\.id\}`,/);
    expect(p).toMatch(/incident_id: `inc_\$\{row\.incidentId\}`,/);
    expect(p).toMatch(/message: row\.message,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/posted_at: row\.postedAt\.toISOString\(\),/);
  });

  // ─── AdminAuditAction taxonomy ───────────────────────────────

  it("CRITICAL AdminAuditAction taxonomy — 3 entries ('incident.created' / 'incident.updated' / 'incident.resolved'). Drift would break the admin-audit-log filter pages.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    // create passes its target id as a lazy thunk, so its withAudit call is
    // multi-line — match the action string with flexible leading whitespace.
    expect(p).toMatch(/withAudit\(\s*\n?\s*request,\s*\n?\s*'incident\.created',/);
    expect(p).toMatch(/withAudit\(request, 'incident\.updated',/);
    expect(p).toMatch(/withAudit\(request, 'incident\.resolved',/);
  });

  // ─── withAudit error-code derivation ─────────────────────────

  it("CRITICAL withAudit error-code derivation — strips 'Error' suffix + lowercases (e.g. 'NotFoundError' → 'notfound'). Surfaces as 'error: <code>' in the audit log. Drift would change the admin audit-log filter chips.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(
      /err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown'/,
    );
    expect(p).toMatch(/result: `error: \$\{code\}`/);
  });

  // ─── Public status route window ──────────────────────────────

  it('CRITICAL public status feed retains all-time open incidents and selects 30d/90d resolved history.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/The status page consumes this; no auth required, only public=true rows/);
    expect(p).toMatch(/surfaced\. Open incidents are all-time; resolved history defaults to 30d\./);
    expect(p).toMatch(/parsed\.data\.window === '90d' \? 90 : 30/);
    expect(p).toMatch(/incidentsService\.publicFeed/);
    expect(p).toMatch(/limit: parsed\.data\.limit \?\? 50,/);
    expect(p).toMatch(/open_count: feed\.openCount/);
    expect(p).toMatch(/open_outage_count: feed\.openOutageCount/);
  });

  it('CRITICAL public status-incidents path — GET /v1/status/incidents (no auth, NO requireScope preHandler). The lack of any auth gate is what lets the public status page consume this. 2026-05-20 added a defense-in-depth IP-rate-limit preHandler (statusIncidentsListGate) — still no auth, but bounded against direct-API abuse bypassing the CDN.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/status\/incidents',\s*\n?\s*\{ preHandler: statusIncidentsListGate \},\s*\n?\s*async \(request, reply\) => \{/,
    );
    // Negative guard: no auth-related preHandler on this path.
    expect(p).not.toMatch(
      /\/v1\/status\/incidents[^:]'?,\s*\{[^}]*requireAuth[\s\S]*?async \(request, reply\)/,
    );
  });

  // ─── Defaults on create ──────────────────────────────────────

  it('CRITICAL create-defaults — affected_components ?? [] (empty array fallback), public ?? true (default to publishable), started_at ?? now. The default-public behaviour matches V-295 intent that customer-visible incidents are the norm, not the exception.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(/affectedComponents: parsed\.data\.affected_components \?\? \[\],/);
    expect(p).toMatch(/public: parsed\.data\.public \?\? true,/);
    expect(p).toMatch(
      /startedAt: parsed\.data\.started_at \? new Date\(parsed\.data\.started_at\) : new Date\(\),/,
    );
  });

  // ─── 201/200 response codes ──────────────────────────────────

  it('CRITICAL response codes — 201 on create + addUpdate + resolve responses include the canonical envelope. Drift to 200 on create would break HTTP-201-meaning across the admin surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'));
    expect(p).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*incident: publicIncident\(created\.incident\)/,
    );
    expect(p).toMatch(/return reply\.code\(201\)\.send\(publicIncidentUpdate\(result\)\)/);
    expect(p).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*incident: publicIncident\(resolved\.incident\)/,
    );
  });
});
