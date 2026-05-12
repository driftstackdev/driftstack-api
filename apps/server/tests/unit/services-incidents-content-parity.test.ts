// W401.A — drift guard for apps/server/src/services/incidents.ts.
// V-295a public-status incidents service. Owns incident + incident_
// updates write paths. Admin-only (scope-checked by route layer).
// V-295c3-followup lifecycle callbacks fire after commit; throws are
// swallowed (notification failure must never roll back the incident
// write — incident IS the source of truth). Drift here either
// silently swallows audit failures (D-025 risk via route) or rolls
// back an incident write on a fan-out error.
//
//   • V-295a framing + admin-only (driftstack_internal_admin route
//     gate) + withAudit admin_audit_log integration.
//   • 2 write semantics (create + addUpdate; resolve advances resolved_
//     at); read semantics (list / get) with public-vs-all scope.
//   • IncidentRow 14 fields; V-295b auto-poller nullable trio
//     (createdByAdminId / createdByAdminKeyId / autoProbeTarget).
//   • IncidentUpdateRow 7 fields; postedByAdmin* nullable for poller.
//   • V-295c3-followup IncidentsLifecycle: onPublicCreated +
//     onPublicResolved — both await + catch-swallow (never roll back).
//   • create: insert incident + synthetic initial update mirroring
//     incident.status/description (one transaction).
//   • get: NotFoundError when missing; lists updates after fetch.
//   • V-295b findOpenAutoIncident hook: per-target query for auto-
//     resolve-vs-no-op decision.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W401.A apps/server/src/services/incidents.ts content parity', () => {
  const body = read(LIB);

  it('V-295a framing pinned + admin-only + withAudit + 2-write-1-read posture', () => {
    expect(body).toMatch(/V-295a — public-status incidents service\./);
    expect(body).toMatch(
      /Owns the incident \+ incident_updates write paths\. Admin-only;\s*\n?\s*\/\/\s*scope-checked by the route layer \(driftstack_internal_admin\)\./,
    );
    expect(body).toMatch(
      /Posts go through `withAudit` in the route to write\s*\n?\s*\/\/\s*admin_audit_log rows in the same request lifecycle\./,
    );
  });

  it('2 write semantics framing: create (incident + initial update, one txn) + addUpdate (timeline + bump status)', () => {
    expect(body).toMatch(
      /Two write semantics:\s*\n?\s*\/\/\s*- create\(\) — inserts the incident \+ initial update in one\s*\n?\s*\/\/\s*transaction\. Initial update mirrors incident\.status\/description\./,
    );
    expect(body).toMatch(
      /- addUpdate\(\) — appends a timeline entry \+ bumps incident\.status\s*\n?\s*\/\/\s*in one transaction\. Resolved-state advances incident\.resolved_at\./,
    );
  });

  it('IncidentRow: 14 fields (id/title/description/severity/status/affectedComponents/public/startedAt/resolvedAt/createdByAdminId?/createdByAdminKeyId?/autoProbeTarget?/createdAt/updatedAt)', () => {
    expect(body).toMatch(/export interface IncidentRow \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description: string;/);
    expect(body).toMatch(/severity: IncidentSeverity;/);
    expect(body).toMatch(/status: IncidentStatus;/);
    expect(body).toMatch(/affectedComponents: readonly string\[\];/);
    expect(body).toMatch(/public: boolean;/);
    expect(body).toMatch(/startedAt: Date;/);
    expect(body).toMatch(/resolvedAt: Date \| null;/);
    expect(body).toMatch(
      /\/\*\* Null when auto-created by V-295b health probe poller\. \*\/\s*\n?\s*createdByAdminId: string \| null;/,
    );
    expect(body).toMatch(/createdByAdminKeyId: string \| null;/);
    expect(body).toMatch(
      /\/\*\* Non-null only for poller-auto-created incidents \(e\.g\. 'api'\)\. \*\/\s*\n?\s*autoProbeTarget: string \| null;/,
    );
    expect(body).toMatch(/createdAt: Date;/);
    expect(body).toMatch(/updatedAt: Date;/);
  });

  it('IncidentUpdateRow: 7 fields with V-295b poller-nullable postedByAdmin* pair', () => {
    expect(body).toMatch(/export interface IncidentUpdateRow \{/);
    expect(body).toMatch(/incidentId: string;/);
    expect(body).toMatch(/message: string;/);
    expect(body).toMatch(/status: IncidentStatus;/);
    expect(body).toMatch(
      /\/\*\* Null when posted by V-295b health probe poller\. \*\/\s*\n?\s*postedByAdminId: string \| null;/,
    );
    expect(body).toMatch(/postedByAdminKeyId: string \| null;/);
    expect(body).toMatch(/postedAt: Date;/);
  });

  it('ListIncidentsOpts: scope public|all + since? + limit?', () => {
    expect(body).toMatch(
      /export interface ListIncidentsOpts \{\s*\n?\s*scope\?: 'public' \| 'all';\s*\n?\s*since\?: Date;\s*\n?\s*limit\?: number;\s*\n?\s*\}/,
    );
  });

  it('IncidentsRepo: 6 methods (create/list/get/listUpdates/addUpdate/resolve) + V-295b findOpenAutoIncident', () => {
    expect(body).toMatch(/export interface IncidentsRepo \{/);
    expect(body).toMatch(/create\(input: CreateIncidentInput\): Promise<IncidentRow>;/);
    expect(body).toMatch(/list\(opts: ListIncidentsOpts\): Promise<IncidentRow\[\]>;/);
    expect(body).toMatch(
      /get\(id: string, opts\?: \{ publicOnly\?: boolean \}\): Promise<IncidentRow \| null>;/,
    );
    expect(body).toMatch(/listUpdates\(incidentId: string\): Promise<IncidentUpdateRow\[\]>;/);
    expect(body).toMatch(/addUpdate\(input: AddUpdateInput\): Promise<IncidentUpdateRow>;/);
    expect(body).toMatch(
      /resolve\(\s*\n?\s*input: ResolveIncidentInput,\s*\n?\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}>;/,
    );
    expect(body).toMatch(
      /V-295b — find the open auto-incident for a given probe target,\s*\n?\s*\*\s*or null\. Used by the poller to decide auto-resolve vs\. no-op\./,
    );
    expect(body).toMatch(/findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null>;/);
  });

  it('V-295c3-followup IncidentsLifecycle: onPublicCreated + onPublicResolved; throw logged+swallowed (never roll back)', () => {
    expect(body).toMatch(
      /V-295c3-followup — lifecycle callbacks\.\s*\n?\s*\*\s*\n?\s*\*\s*Both fire AFTER the incident write commits successfully\. Callbacks\s*\n?\s*\*\s*are awaited; a throw is logged \+ swallowed by the IncidentsService\s*\n?\s*\*\s*\(we never want a notification failure to roll back an incident\s*\n?\s*\*\s*write — the incident IS the source of truth, the email is best-effort\)\./,
    );
    expect(body).toMatch(/export interface IncidentsLifecycle \{/);
    expect(body).toMatch(
      /onPublicCreated\?: \(incident: IncidentRow, initialUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /onPublicResolved\?: \(incident: IncidentRow, finalUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
  });

  it('create: insert incident + synthetic initial update mirroring incident.status + description; fire onPublicCreated only when public; catch-swallow', () => {
    expect(body).toMatch(/const incident = await this\.repo\.create\(input\);/);
    expect(body).toMatch(
      /\/\/ Synthetic initial update mirroring the incident's first state\.\s*\n?\s*const update = await this\.repo\.addUpdate\(\{\s*\n?\s*incidentId: incident\.id,\s*\n?\s*message: input\.description,\s*\n?\s*status: incident\.status,\s*\n?\s*postedByAdminId: input\.createdByAdminId,\s*\n?\s*postedByAdminKeyId: input\.createdByAdminKeyId,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(incident\.public && this\.lifecycle\.onPublicCreated\) \{\s*\n?\s*await this\.lifecycle\.onPublicCreated\(incident, update\)\.catch\(\(\) => \{\s*\n?\s*\/\/ Notification failures must never roll back the incident write\./,
    );
  });

  it('get: NotFoundError when missing; returns {incident, updates: repo.listUpdates(id)}', () => {
    expect(body).toMatch(
      /async get\(\s*\n?\s*id: string,\s*\n?\s*opts\?: \{ publicOnly\?: boolean \},\s*\n?\s*\): Promise<\{ incident: IncidentRow; updates: IncidentUpdateRow\[\] \}> \{\s*\n?\s*const incident = await this\.repo\.get\(id, opts\);\s*\n?\s*if \(!incident\) throw new NotFoundError\(`Incident \$\{id\} not found\.`\);\s*\n?\s*const updates = await this\.repo\.listUpdates\(id\);\s*\n?\s*return \{ incident, updates \};\s*\n?\s*\}/,
    );
  });

  it('resolve: fire onPublicResolved only when public; catch-swallow', () => {
    expect(body).toMatch(
      /async resolve\(\s*\n?\s*input: ResolveIncidentInput,\s*\n?\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}> \{\s*\n?\s*const result = await this\.repo\.resolve\(input\);\s*\n?\s*if \(result\.incident\.public && this\.lifecycle\.onPublicResolved\) \{\s*\n?\s*await this\.lifecycle\.onPublicResolved\(result\.incident, result\.update\)\.catch\(\(\) => \{\s*\n?\s*\/\/ Notification failures must never roll back the resolve write\./,
    );
  });

  it('V-295b findOpenAutoIncident: auto-poller hook delegates to repo', () => {
    expect(body).toMatch(
      /\/\*\* V-295b — auto-poller hook\. \*\/\s*\n?\s*async findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null> \{\s*\n?\s*return this\.repo\.findOpenAutoIncident\(target\);\s*\n?\s*\}/,
    );
  });

  it('imports: IncidentSeverity + IncidentStatus from api-types + NotFoundError from errors-helpers', () => {
    expect(body).toMatch(
      /import type \{ IncidentSeverity, IncidentStatus \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import \{ NotFoundError \} from '\.\.\/lib\/errors-helpers\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
