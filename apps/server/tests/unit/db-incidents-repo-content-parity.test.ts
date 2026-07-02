// W447.C — drift guard for apps/server/src/db/incidents-repo.ts.
// V-295a IncidentsRepo. Drift here either drops the
// transaction-bracketed update+insert on addUpdate/resolve (status
// transition becomes non-atomic — incident.status can drift from
// the latest update.status) or breaks findOpenAutoIncident's
// ne(status, 'resolved') guard (auto-probe creates duplicate
// incidents on resolved-then-re-failing target).
//
//   • V-295a framing pinned.
//   • toRow + toUpdateRow mappers.
//   • create: 10-field values w/ default status 'investigating';
//     copies affectedComponents array; autoProbeTarget null-coalesce.
//   • findOpenAutoIncident: and(eq(autoProbeTarget), ne(status,
//     'resolved'), isNotNull(autoProbeTarget)) + orderBy desc
//     (startedAt) + limit 1 — most-recent open auto incident only.
//   • list: filters by scope='public' → public=true + since gte;
//     orderBy desc(startedAt) + limit (default 100).
//   • get: publicOnly opt adds eq(public, true) — admin sees
//     private, status page only public.
//   • listUpdates: orderBy ASC postedAt (chronological timeline).
//   • addUpdate transaction: insert incidentUpdates row + bump
//     incidents.status + updatedAt — atomic.
//   • resolve transaction: insert update + set status='resolved' +
//     resolvedAt + updatedAt; throws NotFoundError if incident
//     row missing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W447.C apps/server/src/db/incidents-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-295a framing pinned: 'Drizzle-backed IncidentsRepo.'", () => {
    expect(body).toMatch(/\/\/ V-295a — Drizzle-backed IncidentsRepo\./);
  });

  it('imports: and/desc/eq/gte/isNotNull/ne from drizzle-orm; 7 service types; NotFoundError from lib/errors-helpers; Database; incidentUpdates + incidents schemas', () => {
    expect(body).toMatch(/import \{ and, desc, eq, gte, isNotNull, ne \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*AddUpdateInput,\s*\n?\s*CreateIncidentInput,\s*\n?\s*IncidentRow,\s*\n?\s*IncidentUpdateRow,\s*\n?\s*IncidentsRepo,\s*\n?\s*ListIncidentsOpts,\s*\n?\s*ResolveIncidentInput,\s*\n?\s*\} from '\.\.\/services\/incidents\.js';/,
    );
    expect(body).toMatch(/import \{ NotFoundError \} from '\.\.\/lib\/errors-helpers\.js';/);
    expect(body).toMatch(/import \{ incidentUpdates, incidents \} from '\.\/schema\.js';/);
  });

  it('toRow: 14-field IncidentRow (id + title + description + severity + status + affectedComponents + public + startedAt + resolvedAt + createdByAdminId + createdByAdminKeyId + autoProbeTarget + created/updated_at)', () => {
    expect(body).toMatch(
      /function toRow\(row: IncidentDbRow\): IncidentRow \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*title: row\.title,\s*\n?\s*description: row\.description,\s*\n?\s*severity: row\.severity,\s*\n?\s*status: row\.status,\s*\n?\s*affectedComponents: row\.affectedComponents,\s*\n?\s*public: row\.public,\s*\n?\s*startedAt: row\.startedAt,\s*\n?\s*resolvedAt: row\.resolvedAt,\s*\n?\s*createdByAdminId: row\.createdByAdminId,\s*\n?\s*createdByAdminKeyId: row\.createdByAdminKeyId,\s*\n?\s*autoProbeTarget: row\.autoProbeTarget,\s*\n?\s*createdAt: row\.createdAt,\s*\n?\s*updatedAt: row\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('toUpdateRow: 7-field IncidentUpdateRow (id + incidentId + message + status + postedByAdminId + postedByAdminKeyId + postedAt)', () => {
    expect(body).toMatch(
      /function toUpdateRow\(row: IncidentUpdateDbRow\): IncidentUpdateRow \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*incidentId: row\.incidentId,\s*\n?\s*message: row\.message,\s*\n?\s*status: row\.status,\s*\n?\s*postedByAdminId: row\.postedByAdminId,\s*\n?\s*postedByAdminKeyId: row\.postedByAdminKeyId,\s*\n?\s*postedAt: row\.postedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it("create: 11-field values w/ default status 'investigating'; copies affectedComponents via spread [...input.affectedComponents]; autoProbeTarget null-coalesce; throws 'incidents insert returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*title: input\.title,\s*\n?\s*description: input\.description,\s*\n?\s*severity: input\.severity,\s*\n?\s*status: input\.status \?\? 'investigating',\s*\n?\s*affectedComponents: \[\.\.\.input\.affectedComponents\],\s*\n?\s*public: input\.public,\s*\n?\s*startedAt: input\.startedAt,\s*\n?\s*createdByAdminId: input\.createdByAdminId,\s*\n?\s*createdByAdminKeyId: input\.createdByAdminKeyId,\s*\n?\s*autoProbeTarget: input\.autoProbeTarget \?\? null,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('incidents insert returned no row'\);/);
  });

  it("findOpenAutoIncident: where and(eq(autoProbeTarget, target), ne(status, 'resolved'), isNotNull(autoProbeTarget)) + orderBy desc(startedAt) + limit 1 — most-recent OPEN auto-incident only", () => {
    expect(body).toMatch(
      /async findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(incidents\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(incidents\.autoProbeTarget, target\),\s*\n?\s*ne\(incidents\.status, 'resolved'\),\s*\n?\s*isNotNull\(incidents\.autoProbeTarget\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.orderBy\(desc\(incidents\.startedAt\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it("list: scope==='public' → eq(public, true); since → gte(startedAt); orderBy desc(startedAt); limit default 100", () => {
    expect(body).toMatch(
      /if \(opts\.scope === 'public'\) conditions\.push\(eq\(incidents\.public, true\)\);\s*\n?\s*if \(opts\.since\) conditions\.push\(gte\(incidents\.startedAt, opts\.since\)\);/,
    );
    expect(body).toMatch(
      /\.orderBy\(desc\(incidents\.startedAt\)\)\s*\n?\s*\.limit\(opts\.limit \?\? 100\);/,
    );
  });

  it('get with publicOnly opt: pushes eq(public, true) — admin sees private; status page only sees public', () => {
    expect(body).toMatch(
      /async get\(id: string, opts\?: \{ publicOnly\?: boolean \}\): Promise<IncidentRow \| null> \{\s*\n?\s*const conditions = \[eq\(incidents\.id, id\)\];\s*\n?\s*if \(opts\?\.publicOnly\) conditions\.push\(eq\(incidents\.public, true\)\);\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(incidents\)\s*\n?\s*\.where\(and\(\.\.\.conditions\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('listUpdates: orderBy ASC postedAt — chronological timeline rendering', () => {
    expect(body).toMatch(
      /async listUpdates\(incidentId: string\): Promise<IncidentUpdateRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(incidentUpdates\)\s*\n?\s*\.where\(eq\(incidentUpdates\.incidentId, incidentId\)\)\s*\n?\s*\.orderBy\(incidentUpdates\.postedAt\);\s*\n?\s*return rows\.map\(toUpdateRow\);\s*\n?\s*\}/,
    );
  });

  it("addUpdate framing pinned: transaction-bracketed insert; bumps status + keeps resolved_at in LOCKSTEP with status (invariant: status==='resolved' <=> resolved_at != null); throws 'incident_updates insert returned no row' on missing insert row", () => {
    expect(body).toMatch(
      /async addUpdate\(input: AddUpdateInput\): Promise<IncidentUpdateRow> \{\s*\n?\s*return this\.database\.db\.transaction\(async \(tx\) => \{\s*\n?\s*const \[updateRow\] = await tx\s*\n?\s*\.insert\(incidentUpdates\)\s*\n?\s*\.values\(\{\s*\n?\s*incidentId: input\.incidentId,\s*\n?\s*message: input\.message,\s*\n?\s*status: input\.status,\s*\n?\s*postedByAdminId: input\.postedByAdminId,\s*\n?\s*postedByAdminKeyId: input\.postedByAdminKeyId,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!updateRow\) throw new Error\('incident_updates insert returned no row'\);/,
    );
    // The resolved_at lockstep (Fable admin re-audit 2026-07-02): a 'resolved'
    // update stamps resolved_at (preserving an existing one), any non-resolved
    // update clears it — so the /updates path can't drift the invariant.
    expect(body).toMatch(
      /\/\/ Bump incident\.status \+ updated_at to reflect the latest state, AND keep/,
    );
    expect(body).toMatch(/if \(input\.status === 'resolved'\) \{/);
    expect(body).toMatch(/resolvedAt = existing\?\.resolvedAt \?\? now;/);
    expect(body).toMatch(
      /\.set\(\{ status: input\.status, resolvedAt, updatedAt: now \}\)\s*\n?\s*\.where\(eq\(incidents\.id, input\.incidentId\)\);/,
    );
  });

  it("resolve: transaction-bracketed insert update with status='resolved' + UPDATE incidents set status='resolved'/resolvedAt/updatedAt; throws NotFoundError `Incident ${id} not found.` when incident row missing", () => {
    expect(body).toMatch(
      /async resolve\(\s*\n?\s*input: ResolveIncidentInput,\s*\n?\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}> \{\s*\n?\s*return this\.database\.db\.transaction\(async \(tx\) => \{/,
    );
    expect(body).toMatch(
      /status: 'resolved',\s*\n?\s*postedByAdminId: input\.postedByAdminId,\s*\n?\s*postedByAdminKeyId: input\.postedByAdminKeyId,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /const \[incidentRow\] = await tx\s*\n?\s*\.update\(incidents\)\s*\n?\s*\.set\(\{ status: 'resolved', resolvedAt: now, updatedAt: now \}\)\s*\n?\s*\.where\(eq\(incidents\.id, input\.incidentId\)\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!incidentRow\) \{\s*\n?\s*throw new NotFoundError\(`Incident \$\{input\.incidentId\} not found\.`\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
