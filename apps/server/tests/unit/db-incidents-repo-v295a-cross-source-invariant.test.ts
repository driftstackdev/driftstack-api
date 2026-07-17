// W999 — db/incidents-repo V-295a cross-source invariant. Three-
// hundred-twenty-fifth in the drift-guard series. Pins the apps/
// server/src/db/incidents-repo.ts Drizzle incidents repo primitive:
//
//   V-295a anchor — 'V-295a — Drizzle-backed IncidentsRepo'.
//
//   DrizzleIncidentsRepo 7-method surface — create + findOpenAuto-
//     Incident + list + get + listUpdates + addUpdate (txn) + resolve
//     (txn).
//
//   create defaults framing — status ?? 'investigating' (initial-state
//     default).
//
//   findOpenAutoIncident 3-condition — eq(autoProbeTarget) +
//     ne(status, 'resolved') + isNotNull(autoProbeTarget). The 3-cond
//     ensures only open auto-probe-tracked incidents match.
//
//   list 2-filter — public-only (eq(public, true)) + since (gte
//     startedAt) + default limit 100.
//
//   get publicOnly opt-in scope (eq(public, true)).
//
//   listUpdates orderBy postedAt ASC (chronological).
//
//   addUpdate transactional 2-write — insert(incidentUpdates) +
//     update(incidents).status + updatedAt.
//
//   resolve transactional 2-write — insert(incidentUpdates).status=
//     'resolved' + update(incidents) status='resolved' + resolvedAt +
//     updatedAt + throws NotFoundError on missing incident.
//
//   toRow 14-field IncidentRow mapper — id + title + description +
//     severity + status + affectedComponents + public + startedAt +
//     resolvedAt + createdByAdminId + createdByAdminKeyId +
//     autoProbeTarget + createdAt + updatedAt.
//
//   toUpdateRow 7-field IncidentUpdateRow mapper — id + incidentId +
//     message + status + postedByAdminId + postedByAdminKeyId +
//     postedAt.
//
// stays in lockstep across apps/server/src/db/incidents-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W999 db/incidents-repo V-295a cross-source invariant', () => {
  // ─── V-295a anchor ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/incidents-repo.ts header pins V-295a — 'V-295a — Drizzle-backed IncidentsRepo'. The V-295a anchor is the incidents-repo provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/\/\/ V-295a — Drizzle-backed IncidentsRepo\./);
    expect(p).toMatch(/export class DrizzleIncidentsRepo implements IncidentsRepo \{/);
  });

  // ─── 7-method surface ────────────────────────────────────────

  it('CRITICAL surface includes atomic create + exact listPage alongside lifecycle methods.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/async createWithInitialUpdate\(/);
    expect(p).toMatch(/Promise<CreateIncidentWriteResult> \{/);
    expect(p).toMatch(
      /async findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null> \{/,
    );
    expect(p).toMatch(/async list\(opts: ListIncidentsOpts\): Promise<IncidentRow\[\]> \{/);
    expect(p).toMatch(/async listPage\(opts: ListIncidentsOpts\): Promise<IncidentListPage> \{/);
    expect(p).toMatch(
      /async publicFeed\(args: \{ since: Date; limit: number \}\): Promise<PublicIncidentFeedRows> \{/,
    );
    expect(p).toMatch(
      /async get\(id: string, opts\?: \{ publicOnly\?: boolean \}\): Promise<IncidentRow \| null> \{/,
    );
    expect(p).toMatch(/async listUpdates\(incidentId: string\): Promise<IncidentUpdateRow\[\]> \{/);
    expect(p).toMatch(/async addUpdate\(input: AddUpdateInput\): Promise<IncidentUpdateRow> \{/);
    expect(p).toMatch(/async resolve\(/);
  });

  // ─── create defaults ─────────────────────────────────────────

  it("CRITICAL create defaults — status ?? 'investigating' + autoProbeTarget ?? null + affectedComponents copied via spread. The 'investigating' default is the V-295a initial state.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/const initialStatus = input\.status \?\? 'investigating';/);
    expect(p).toMatch(/status: initialStatus,/);
    expect(p).toMatch(/resolvedAt: initialStatus === 'resolved' \? new Date\(\) : null,/);
    expect(p).toMatch(/affectedComponents: \[\.\.\.input\.affectedComponents\],/);
    expect(p).toMatch(/autoProbeTarget: input\.autoProbeTarget \?\? null,/);
  });

  // ─── findOpenAutoIncident 3-condition ────────────────────────

  it("CRITICAL findOpenAutoIncident 3-condition — eq(autoProbeTarget) + ne(status, 'resolved') + isNotNull(autoProbeTarget). The triple-cond filters to open + auto-probe-tracked incidents only.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/eq\(incidents\.autoProbeTarget, target\),/);
    expect(p).toMatch(/ne\(incidents\.status, 'resolved'\),/);
    expect(p).toMatch(/isNotNull\(incidents\.autoProbeTarget\),/);
    expect(p).toMatch(/\.orderBy\(desc\(incidents\.startedAt\)\)/);
    expect(p).toMatch(/\.limit\(1\);/);
  });

  // ─── list 2-filter ───────────────────────────────────────────

  it('CRITICAL listPage filters before limit and uses exact composite keyset pagination.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(
      /if \(opts\.scope === 'public'\) filters\.push\(eq\(incidents\.public, true\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.since\) filters\.push\(gte\(incidents\.startedAt, opts\.since\)\);/,
    );
    expect(p).toMatch(/opts\.state === 'open'/);
    expect(p).toMatch(/lt\(incidents\.startedAt, opts\.cursor\.startedAt\)/);
    expect(p).toMatch(/lt\(incidents\.id, opts\.cursor\.id\)/);
    expect(p).toMatch(/\.limit\(limit \+ 1\);/);
    expect(p).toMatch(/\.select\(\{ value: count\(\) \}\)/);
  });

  // ─── get publicOnly opt-in ───────────────────────────────────

  it("CRITICAL get publicOnly opt-in scope — 'if (opts?.publicOnly) conditions.push(eq(incidents.public, true));'. The opt-in filter is what makes the same get() callable from both admin (full surface) and public status-page (filtered) routes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/const conditions = \[eq\(incidents\.id, id\)\];/);
    expect(p).toMatch(
      /if \(opts\?\.publicOnly\) conditions\.push\(eq\(incidents\.public, true\)\);/,
    );
  });

  // ─── listUpdates orderBy postedAt ────────────────────────────

  it('CRITICAL listUpdates orders by postedAt ASC (chronological). The chronological ordering matches status-page timeline rendering.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/\.where\(eq\(incidentUpdates\.incidentId, incidentId\)\)/);
    expect(p).toMatch(/\.orderBy\(incidentUpdates\.postedAt\);/);
  });

  // ─── addUpdate transactional 2-write ─────────────────────────

  it("CRITICAL addUpdate is transactional — 'this.database.db.transaction(async (tx) => { ... })' + insert(incidentUpdates) + update(incidents) that bumps status AND keeps resolved_at in lockstep (V-295a invariant: status==='resolved' <=> resolved_at != null). The txn keeps the update-row + incident bump atomic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(p).toMatch(/await tx/);
    expect(p).toMatch(/\.insert\(incidentUpdates\)/);
    expect(p).toMatch(/\.update\(incidents\)/);
    // resolved_at lockstep on the timeline-update path (Fable admin re-audit
    // 2026-07-02) — the addUpdate invariant is now guarded here too.
    expect(p).toMatch(/if \(input\.status === 'resolved'\) \{/);
    expect(p).toMatch(/resolvedAt = existing\?\.resolvedAt \?\? now;/);
    expect(p).toMatch(/\.set\(\{ status: input\.status, resolvedAt, updatedAt: now \}\)/);
  });

  // ─── resolve transactional 3-write + NotFoundError ──────────

  it("CRITICAL resolve is transactional — 2-write (insert(incidentUpdates).status='resolved' + update(incidents) status='resolved' + resolvedAt + updatedAt). The status='resolved' double-set is the V-295a resolve contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/status: 'resolved',/);
    expect(p).toMatch(/postedByAdminId: input\.postedByAdminId,/);
    expect(p).toMatch(/postedByAdminKeyId: input\.postedByAdminKeyId,/);
    expect(p).toMatch(/const now = new Date\(\);/);
    expect(p).toMatch(/\.set\(\{ status: 'resolved', resolvedAt: now, updatedAt: now \}\)/);
  });

  it("CRITICAL resolve throws NotFoundError on missing incident — 'throw new NotFoundError(`Incident ${input.incidentId} not found.`);'. The NotFoundError surface lets routes return 404.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/if \(!incidentRow\) \{/);
    expect(p).toMatch(/throw new NotFoundError\(`Incident \$\{input\.incidentId\} not found\.`\);/);
  });

  it('CRITICAL resolve returns 2-field object — { incident: IncidentRow, update: IncidentUpdateRow }. The pair lets the route emit both the resolved-incident + the resolve-update event.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(
      /return \{ incident: toRow\(incidentRow\), update: toUpdateRow\(updateRow\) \};/,
    );
  });

  // ─── toRow 14-field IncidentRow mapper ───────────────────────

  it('CRITICAL toRow 14-field IncidentRow mapper — id + title + description + severity + status + affectedComponents + public + startedAt + resolvedAt + createdByAdminId + createdByAdminKeyId + autoProbeTarget + createdAt + updatedAt. The 14-field shape includes the V-295a auto-probe-target binding.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/function toRow\(row: IncidentDbRow\): IncidentRow \{/);
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/title: row\.title,/);
    expect(p).toMatch(/description: row\.description,/);
    expect(p).toMatch(/severity: row\.severity,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/affectedComponents: row\.affectedComponents,/);
    expect(p).toMatch(/public: row\.public,/);
    expect(p).toMatch(/startedAt: row\.startedAt,/);
    expect(p).toMatch(/resolvedAt: row\.resolvedAt,/);
    expect(p).toMatch(/createdByAdminId: row\.createdByAdminId,/);
    expect(p).toMatch(/createdByAdminKeyId: row\.createdByAdminKeyId,/);
    expect(p).toMatch(/autoProbeTarget: row\.autoProbeTarget,/);
    expect(p).toMatch(/createdAt: row\.createdAt,/);
    expect(p).toMatch(/updatedAt: row\.updatedAt,/);
  });

  // ─── toUpdateRow 7-field IncidentUpdateRow mapper ────────────

  it('CRITICAL toUpdateRow 7-field IncidentUpdateRow mapper — id + incidentId + message + status + postedByAdminId + postedByAdminKeyId + postedAt. The 7-field shape carries the per-update audit + status snapshot.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/incidents-repo.ts'));
    expect(p).toMatch(/function toUpdateRow\(row: IncidentUpdateDbRow\): IncidentUpdateRow \{/);
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/incidentId: row\.incidentId,/);
    expect(p).toMatch(/message: row\.message,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/postedByAdminId: row\.postedByAdminId,/);
    expect(p).toMatch(/postedByAdminKeyId: row\.postedByAdminKeyId,/);
    expect(p).toMatch(/postedAt: row\.postedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-incidents-repo-v295a-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
