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
//     onPublicResolved — fire-and-forget (W427: void, not await — don't block
//     the admin op on the outbound fan-out) + catch-swallow (never roll back).
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
      /Owns the incident \+ incident_updates write paths\. Admin-only;\s*\/\/\s*scope-checked by the route layer \(driftstack_internal_admin\)\./,
    );
    expect(body).toMatch(
      /Posts go through `withAudit` in the route to write\s*\/\/\s*admin_audit_log rows in the same request lifecycle\./,
    );
  });

  it('2 write semantics framing: create (incident + initial update, one txn) + addUpdate (timeline + bump status)', () => {
    expect(body).toMatch(
      /Two write semantics:\s*\/\/\s*- create\(\) — inserts the incident \+ initial update in one\s*\/\/\s*transaction\. Initial update mirrors incident\.status\/description\./,
    );
    expect(body).toMatch(
      /- addUpdate\(\) — appends a timeline entry \+ bumps incident\.status\s*\/\/\s*in one transaction\. Resolved-state advances incident\.resolved_at\./,
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
      /\/\*\* Null when auto-created by V-295b health probe poller\. \*\/\s*createdByAdminId: string \| null;/,
    );
    expect(body).toMatch(/createdByAdminKeyId: string \| null;/);
    expect(body).toMatch(
      /\/\*\* Non-null only for poller-auto-created incidents \(e\.g\. 'api'\)\. \*\/\s*autoProbeTarget: string \| null;/,
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
      /\/\*\* Null when posted by V-295b health probe poller\. \*\/\s*postedByAdminId: string \| null;/,
    );
    expect(body).toMatch(/postedByAdminKeyId: string \| null;/);
    expect(body).toMatch(/postedAt: Date;/);
  });

  it('ListIncidentsOpts supports lifecycle/severity predicates and composite keyset cursor', () => {
    expect(body).toContain("scope?: 'public' | 'all';");
    expect(body).toContain('since?: Date;');
    expect(body).toContain('state?: IncidentListState;');
    expect(body).toContain('severity?: IncidentSeverity;');
    expect(body).toContain('cursor?: IncidentListCursor;');
    expect(body).toContain('limit?: number;');
  });

  it('IncidentListPage carries snapshot-coherent all-time openCount', () => {
    expect(body).toContain('openCount: number;');
    expect(body).toContain('the same snapshot as rows and total');
  });

  it('IncidentsRepo exposes atomic create + exact listPage alongside lifecycle methods', () => {
    expect(body).toMatch(/export interface IncidentsRepo \{/);
    expect(body).toContain('createWithInitialUpdate(');
    expect(body).toContain('explicitId?: string,');
    expect(body).toContain('): Promise<CreateIncidentWriteResult>;');
    expect(body).toMatch(/list\(opts: ListIncidentsOpts\): Promise<IncidentRow\[\]>;/);
    expect(body).toMatch(/listPage\(opts: ListIncidentsOpts\): Promise<IncidentListPage>;/);
    expect(body).toMatch(
      /publicFeed\(args: \{ since: Date; limit: number \}\): Promise<PublicIncidentFeedRows>;/,
    );
    expect(body).toMatch(
      /get\(id: string, opts\?: \{ publicOnly\?: boolean \}\): Promise<IncidentRow \| null>;/,
    );
    expect(body).toMatch(/listUpdates\(incidentId: string\): Promise<IncidentUpdateRow\[\]>;/);
    expect(body).toMatch(/addUpdate\(input: AddUpdateInput\): Promise<IncidentUpdateRow>;/);
    expect(body).toMatch(
      /resolve\(\s*input: ResolveIncidentInput,\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}>;/,
    );
    expect(body).toMatch(
      /V-295b — find the open auto-incident for a given probe target,\s*\*\s*or null\. Used by the poller to decide auto-resolve vs\. no-op\./,
    );
    expect(body).toMatch(/findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null>;/);
  });

  it('V-295c3-followup IncidentsLifecycle: onPublicCreated + onPublicResolved + V-545.B onPublicUpdated; throw logged+swallowed (never roll back)', () => {
    expect(body).toMatch(
      /All fire AFTER the incident write commits successfully, and are dispatched\s*\*\s*FIRE-AND-FORGET \(`void …`\) rather than awaited/,
    );
    // V-807 — both halves of the old sentence were false, and contradicted by the
    // implementation twenty lines below: `void this.lifecycle.on*()` is
    // fire-and-forget, and all four catch handlers were empty, so a fan-out that
    // reached nobody left no trace. The doc now matches, and the logger makes the
    // reported half true rather than aspirational.
    expect(body).toMatch(/but it IS reported through the\s*\*\s*optional logger, at error level\./);
    expect(body).toMatch(/private reportNotificationFailure\(/);
    expect(body).toMatch(/event: 'incident_notification_failed',/);
    expect(body, 'the awaited-and-logged claim must not return').not.toMatch(
      /are awaited; a throw is logged/,
    );
    expect(body, 'no catch handler may be silent again').not.toMatch(
      /\.catch\(\(\) => \{\s*\/\/ Notification failures must never roll back/,
    );
    expect(body).toMatch(/export interface IncidentsLifecycle \{/);
    expect(body).toMatch(
      /onPublicCreated\?: \(incident: IncidentRow, initialUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /onPublicResolved\?: \(incident: IncidentRow, finalUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /onPublicUpdated\?: \(incident: IncidentRow, update: IncidentUpdateRow\) => Promise<void>;/,
    );
  });

  it('create consumes the atomic incident+initial-update result and emits lifecycle after commit', () => {
    expect(body).toMatch(/const result = await this\.repo\.createWithInitialUpdate\(input\);/);
    expect(body).toContain("if (result.outcome !== 'created')");
    expect(body).toMatch(
      /if \(result\.incident\.public && this\.lifecycle\.onPublicCreated\) \{[\s\S]*?void this\.lifecycle\.onPublicCreated\(result\.incident, result\.update\)\.catch/,
    );
    expect(body).toContain('async createWithId(');
    expect(body).toContain("result.outcome === 'mismatch'");
  });

  it('publicFeed delegates the consistency boundary to the repository', () => {
    expect(body).toMatch(
      /async publicFeed\(args: \{ since: Date; limit: number \}\): Promise<PublicIncidentFeedRows> \{\s*return this\.repo\.publicFeed\(args\);\s*\}/,
    );
  });

  it('get: NotFoundError when missing; returns {incident, updates: repo.listUpdates(id)}', () => {
    expect(body).toMatch(
      /async get\(\s*id: string,\s*opts\?: \{ publicOnly\?: boolean \},\s*\): Promise<\{ incident: IncidentRow; updates: IncidentUpdateRow\[\] \}> \{\s*const incident = await this\.repo\.get\(id, opts\);\s*if \(!incident\) throw new NotFoundError\(`Incident \$\{id\} not found\.`\);\s*const updates = await this\.repo\.listUpdates\(id\);\s*return \{ incident, updates \};\s*\}/,
    );
  });

  it('resolve: fire onPublicResolved only when public; catch-swallow', () => {
    expect(body).toMatch(
      /async resolve\(\s*input: ResolveIncidentInput,\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}> \{\s*const result = await this\.repo\.resolve\(input\);/,
    );
    // V-807 — the resolve hook's catch now reports instead of swallowing silently.
    expect(body).toMatch(
      /void this\.lifecycle\.onPublicResolved\(result\.incident, result\.update\)\.catch\(\(err: unknown\) => \{/,
    );
    expect(body).toMatch(
      /this\.reportNotificationFailure\('onPublicResolved', result\.incident\.id, err\);/,
    );
  });

  it('V-295b findOpenAutoIncident: auto-poller hook delegates to repo', () => {
    expect(body).toMatch(
      /\/\*\* V-295b — auto-poller hook\. \*\/\s*async findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null> \{\s*return this\.repo\.findOpenAutoIncident\(target\);\s*\}/,
    );
  });

  it('imports lifecycle list/status types from api-types and conflict/not-found errors together', () => {
    expect(body).toContain(
      "import type { IncidentListState, IncidentSeverity, IncidentStatus } from '@driftstack/api-types';",
    );
    expect(body).toContain("import { ConflictError, NotFoundError } from '../lib/errors.js';");
  });

  it('V-1100 CRITICAL every fire-and-forget lifecycle dispatch reports its own failure, and production passes a logger. V-807 corrected this comment from "awaited, throw logged" to fire-and-forget-but-reported, and built the reporting seam that made the second half true. The seam is only true where it is called: four dispatch sites exist, one was pinned, and an emptied catch on any of the other three restores the silence V-807 found — a status-page notification failing to reach every subscriber with no trace anywhere.', () => {
    const body = read(LIB);
    const dispatches = [...body.matchAll(/void this\.lifecycle\.(\w+)\(/g)].map((m) => ({
      hook: m[1] ?? '',
      at: m.index ?? 0,
    }));
    expect(dispatches.length, 'fire-and-forget lifecycle dispatches found').toBeGreaterThanOrEqual(
      4,
    );

    const silent: string[] = [];
    for (const d of dispatches) {
      // The catch belongs to this dispatch: everything up to the first `});`
      // that closes it. A hook name is required inside, so a catch that reports
      // the WRONG hook is not accepted as coverage either.
      const tail = body.slice(d.at, body.indexOf('});', d.at) + 3);
      if (!new RegExp(`reportNotificationFailure\\('${d.hook}'`).test(tail)) {
        silent.push(`${d.hook} at offset ${String(d.at)} does not report its own rejection`);
      }
    }
    expect(
      silent.sort(),
      'these lifecycle dispatches swallow a rejection without reporting it — the doc comment above ' +
        'says a throw IS reported through the optional logger, and for these it is not:',
    ).toEqual([]);

    // …and the claim is only true in production if a logger is actually passed.
    // The service takes it as an optional trailing argument, so omitting it is
    // silent by construction and no behavioural test can see it — the unit
    // tests construct without one deliberately, to exercise the swallow.
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    const at = bootstrap.indexOf('new IncidentsService(');
    expect(at, 'bootstrap no longer constructs an IncidentsService').toBeGreaterThan(0);
    let depth = 0;
    let end = at;
    for (let i = bootstrap.indexOf('(', at); i < bootstrap.length; i += 1) {
      if (bootstrap[i] === '(') depth += 1;
      else if (bootstrap[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(
      bootstrap.slice(at, end),
      'bootstrap constructs the IncidentsService without a logger, so every notification failure is ' +
        'unreported in production however well the service reports internally',
    ).toMatch(/\n\s*logger,?\s*$|,\s*logger\b/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
