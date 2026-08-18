// W947 — V-295a IncidentsService cross-source invariant. Two-
// hundred-seventy-third in the drift-guard series. Pins the public-
// status incidents service:
//
//   V-295a anchor — 'V-295a — public-status incidents service. Owns
//   the incident + incident_updates write paths. Admin-only;
//   scope-checked by the route layer (driftstack_internal_admin)'.
//
//   Route-side withAudit framing — 'Posts go through withAudit in
//   the route to write admin_audit_log rows in the same request
//   lifecycle' (matches W940 service-vs-route audit split).
//
//   2 write semantics:
//     - create() — 'inserts the incident + initial update in one
//       transaction. Initial update mirrors incident.status/
//       description'.
//     - addUpdate() — 'appends a timeline entry + bumps
//       incident.status in one transaction. Resolved-state advances
//       incident.resolved_at'.
//
//   2 read semantics (scope-gated):
//     - list() — admin reads everything; status-page reads
//       scope=public.
//     - get() — admin reads everything; status-page reads
//       scope=public (verified by route handler before calling).
//
//   IncidentRow (13 fields):
//     - id + title + description + severity + status +
//       affectedComponents (readonly[]) + public + startedAt +
//       resolvedAt (nullable) + createdByAdminId (nullable;
//       V-295b auto-create) + createdByAdminKeyId (nullable) +
//       autoProbeTarget (nullable; V-295b auto-create only) +
//       createdAt + updatedAt.
//
//   IncidentUpdateRow (7 fields):
//     - id + incidentId + message + status + postedByAdminId
//       (nullable; V-295b auto-post) + postedByAdminKeyId
//       (nullable) + postedAt.
//
//   V-295b auto-creation framing — 'Null when auto-created by V-295b
//   health probe poller' for createdByAdminId / createdByAdminKeyId.
//
//   V-295b probe-target framing — 'Set only for V-295b auto-created
//   incidents' for autoProbeTarget.
//
//   ListIncidentsOpts — scope ('public' | 'all') + since + limit.
//
//   V-295b findOpenAutoIncident — 'find the open auto-incident for
//   a given probe target, or null. Used by the poller to decide
//   auto-resolve vs. no-op'.
//
//   V-295c3-followup IncidentsLifecycle — 'Both fire AFTER the
//   incident write commits successfully. Callbacks are awaited; a
//   throw is logged + swallowed by the IncidentsService (we never
//   want a notification failure to roll back an incident write —
//   the incident IS the source of truth, the email is best-effort)'.
//
//   2 lifecycle hooks: onPublicCreated + onPublicResolved (optional).
//
// stays in lockstep across apps/server/src/services/incidents.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W947 V-295a incidents cross-source invariant', () => {
  // ─── V-295a anchor + admin-only scope framing ────────────────

  it("CRITICAL apps/server/src/services/incidents.ts header pins V-295a anchor — 'V-295a — public-status incidents service. Owns the incident + incident_updates write paths. Admin-only; scope-checked by the route layer (driftstack_internal_admin)'. The V-295a + admin-only + route-side-scope is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/V-295a — public-status incidents service/);
    expect(p).toMatch(/Owns the incident \+ incident_updates write paths\. Admin-only;/);
    expect(p).toMatch(/scope-checked by the route layer \(driftstack_internal_admin\)/);
  });

  // ─── withAudit route-side framing ────────────────────────────

  it("CRITICAL route-audit framing — 'Posts go through withAudit in the route to write admin_audit_log rows in the same request lifecycle'. The withAudit-in-route matches W940 admin-accounts service-vs-route audit split.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/Posts go through `withAudit` in the route to write/);
    expect(p).toMatch(/admin_audit_log rows in the same request lifecycle/);
  });

  // ─── 2 write semantics ───────────────────────────────────────

  it("CRITICAL 2-write framing — 'create() — inserts the incident + initial update in one transaction. Initial update mirrors incident.status/description. addUpdate() — appends a timeline entry + bumps incident.status in one transaction. Resolved-state advances incident.resolved_at'. The 2-write semantics is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/- create\(\) — inserts the incident \+ initial update in one/);
    expect(p).toMatch(/transaction\. Initial update mirrors incident\.status\/description\./);
    expect(p).toMatch(/- addUpdate\(\) — appends a timeline entry \+ bumps incident\.status/);
    expect(p).toMatch(/in one transaction\. Resolved-state advances incident\.resolved_at\./);
  });

  // ─── 2 read semantics (scope=public vs all) ──────────────────

  it("CRITICAL 2-read framing — 'list() — admin reads everything; status-page reads scope=public. get() — admin reads everything; status-page reads scope=public (verified by route handler before calling)'. The 2-scope split + route-verifies-scope contract is the public-status access model.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/- list\(\) — admin reads everything; status-page reads scope=public\./);
    expect(p).toMatch(/- get\(\) — admin reads everything; status-page reads scope=public/);
    expect(p).toMatch(/\(verified by route handler before calling\)\./);
  });

  // ─── IncidentRow 13-field shape ──────────────────────────────

  it('CRITICAL IncidentRow has 13 fields — id + title + description + severity (IncidentSeverity) + status (IncidentStatus) + affectedComponents (readonly[]) + public + startedAt + resolvedAt (nullable) + createdByAdminId (nullable) + createdByAdminKeyId (nullable) + autoProbeTarget (nullable) + createdAt + updatedAt. The 13-field shape carries the full incident state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export interface IncidentRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/title: string;/);
    expect(p).toMatch(/description: string;/);
    expect(p).toMatch(/severity: IncidentSeverity;/);
    expect(p).toMatch(/status: IncidentStatus;/);
    expect(p).toMatch(/affectedComponents: readonly string\[\];/);
    expect(p).toMatch(/public: boolean;/);
    expect(p).toMatch(/startedAt: Date;/);
    expect(p).toMatch(/resolvedAt: Date \| null;/);
    expect(p).toMatch(/createdByAdminId: string \| null;/);
    expect(p).toMatch(/createdByAdminKeyId: string \| null;/);
    expect(p).toMatch(/autoProbeTarget: string \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── V-295b auto-creation null annotations ───────────────────

  it("CRITICAL V-295b auto-creation framing — 'Null when auto-created by V-295b health probe poller' for createdByAdminId + createdByAdminKeyId. The nullable-when-auto pattern lets the same IncidentRow shape carry both admin-created + V-295b-auto-created incidents.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    const matches = p.match(/Null when auto-created by V-295b health probe poller\./g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // 2 in IncidentRow + more in inputs
  });

  it("CRITICAL autoProbeTarget framing — 'Non-null only for poller-auto-created incidents (e.g. api)'. The non-null-when-auto contract is the V-295b discriminator field.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/Non-null only for poller-auto-created incidents \(e\.g\. 'api'\)\./);
  });

  // ─── IncidentUpdateRow 7-field shape ─────────────────────────

  it('CRITICAL IncidentUpdateRow has 7 fields — id + incidentId + message + status + postedByAdminId (nullable; V-295b auto-post) + postedByAdminKeyId (nullable) + postedAt. The 7-field shape carries per-update audit attribution.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export interface IncidentUpdateRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/incidentId: string;/);
    expect(p).toMatch(/message: string;/);
    expect(p).toMatch(/status: IncidentStatus;/);
    expect(p).toMatch(/postedByAdminId: string \| null;/);
    expect(p).toMatch(/postedByAdminKeyId: string \| null;/);
    expect(p).toMatch(/postedAt: Date;/);
  });

  // ─── ListIncidentsOpts shape ─────────────────────────────────

  it("CRITICAL ListIncidentsOpts has 3 fields — scope ('public' | 'all') + since + limit. The scope-discriminator drives the route-vs-status-page read split.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export interface ListIncidentsOpts \{/);
    expect(p).toMatch(/scope\?: 'public' \| 'all';/);
    expect(p).toMatch(/since\?: Date;/);
    expect(p).toMatch(/limit\?: number;/);
  });

  // ─── IncidentsRepo 7-method interface ────────────────────────

  it('CRITICAL IncidentsRepo has atomic create and exact paginated list primitives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export interface IncidentsRepo \{/);
    expect(p).toMatch(/createWithInitialUpdate\(/);
    expect(p).toMatch(/Promise<CreateIncidentWriteResult>;/);
    expect(p).toMatch(/list\(opts: ListIncidentsOpts\): Promise<IncidentRow\[\]>;/);
    expect(p).toMatch(/listPage\(opts: ListIncidentsOpts\): Promise<IncidentListPage>;/);
    expect(p).toMatch(
      /publicFeed\(args: \{ since: Date; limit: number \}\): Promise<PublicIncidentFeedRows>;/,
    );
    expect(p).toMatch(
      /get\(id: string, opts\?: \{ publicOnly\?: boolean \}\): Promise<IncidentRow \| null>;/,
    );
    expect(p).toMatch(/listUpdates\(incidentId: string\): Promise<IncidentUpdateRow\[\]>;/);
    expect(p).toMatch(/addUpdate\(input: AddUpdateInput\): Promise<IncidentUpdateRow>;/);
    expect(p).toMatch(/resolve\(/);
    expect(p).toMatch(/findOpenAutoIncident\(target: string\): Promise<IncidentRow \| null>;/);
  });

  // ─── V-295b findOpenAutoIncident framing ─────────────────────

  it("CRITICAL V-295b findOpenAutoIncident JSDoc — 'V-295b — find the open auto-incident for a given probe target, or null. Used by the poller to decide auto-resolve vs. no-op'. The lookup-then-poller-decides contract is the V-295b auto-resolve gate.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/V-295b — find the open auto-incident for a given probe target,/);
    expect(p).toMatch(/or null\. Used by the poller to decide auto-resolve vs\. no-op\./);
  });

  // ─── resolve() returns { incident, update } ──────────────────

  it('CRITICAL resolve() returns Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> — 2-field result lets callers consume both the resolved incident + the final update in one call.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(
      /resolve\(\s*\n\s*input: ResolveIncidentInput,\s*\n\s*\): Promise<\{ incident: IncidentRow; update: IncidentUpdateRow \}>;/,
    );
  });

  // ─── V-295c3-followup IncidentsLifecycle framing ─────────────

  it('CRITICAL V-295c3-followup IncidentsLifecycle framing — V-807 corrected both halves: callbacks are dispatched FIRE-AND-FORGET, never awaited, and all four catch handlers were empty rather than logging, so a fan-out that reached no subscriber left no trace. Commit-then-fire and swallow-throw are real; the swallow is now reported through an optional logger.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/V-295c3-followup — lifecycle callbacks\./);
    expect(p).toMatch(/All fire AFTER the incident write commits successfully, and are dispatched/);
    expect(p).toMatch(/FIRE-AND-FORGET \(`void …`\) rather than awaited/);
    expect(p).toMatch(
      /the incident IS the source of\s*\n?\s*\*\s*truth and the notification is best-effort/,
    );
    expect(p).toMatch(/but it IS reported through the/);
    // V-807 — both halves of the retired sentence, banned per-occurrence.
    expect(p).not.toMatch(/are awaited; a throw is logged/);
    expect(p).not.toMatch(/we never want a notification failure to roll back an incident/);
  });

  // ─── 2 optional lifecycle hooks ──────────────────────────────

  it('CRITICAL IncidentsLifecycle has 2 optional hooks — onPublicCreated + onPublicResolved. Both take (incident: IncidentRow, update: IncidentUpdateRow). The 2-hook surface mirrors V-295e IncidentEventBus 2-event union + V-295c3-followup notify methods.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export interface IncidentsLifecycle \{/);
    expect(p).toMatch(
      /onPublicCreated\?: \(incident: IncidentRow, initialUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
    expect(p).toMatch(
      /onPublicResolved\?: \(incident: IncidentRow, finalUpdate: IncidentUpdateRow\) => Promise<void>;/,
    );
  });

  // ─── IncidentsService constructor default lifecycle ──────────

  it('CRITICAL IncidentsService constructor — repo (required) + lifecycle default = {}. The empty-default lifecycle lets tests instantiate without wiring email/event/broadcast services.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toMatch(/export class IncidentsService \{/);
    expect(p).toMatch(/private readonly lifecycle: IncidentsLifecycle;/);
    expect(p).toMatch(/lifecycle: IncidentsLifecycle = \{\},/);
  });

  // ─── api-types IncidentSeverity + IncidentStatus imports ─────

  it('CRITICAL IncidentSeverity + IncidentStatus imported from @driftstack/api-types — single source of truth for incident enums.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incidents.ts'));
    expect(p).toContain(
      "import type { IncidentListState, IncidentSeverity, IncidentStatus } from '@driftstack/api-types';",
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/incidents-v295a-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
