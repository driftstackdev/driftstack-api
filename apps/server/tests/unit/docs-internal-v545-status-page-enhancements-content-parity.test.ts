// W562.A — drift guard for /docs/internal/v545-status-page-enhancements.md.
// V-545 DESIGN doc 2026-05-11 Wave-23. Drift here either weakens the
// V-295c-shipped-basic-status-site + V-545-3-cluster scope, drops
// the incident_updates schema, or unsets the V-545.A/B/C sub-slice
// sequencing.
//
//   • V-545. DESIGN. status.driftstack.io next-layer features.
//   • V-295c shipped basic; V-516 admin endpoints already exist.
//   • V-545.A incident-posting-workflow-timeline.
//   • V-545.B subscriber notification (Postmark 3-template +
//     throttle-1/hour + unsubscribe + per-component).
//   • V-545.C history view (month-archive + permalink + RSS feed).
//   • incident_updates table schema + index.
//   • 3 open questions for team review.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v545-status-page-enhancements.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W562.A /docs/internal/v545-status-page-enhancements.md content parity', () => {
  const body = read(LIB);

  it("Header + V-295c-shipped + V-516-admin-endpoints framing pinned: '# V-545 — status-page enhancements' + '**Date:** 2026-05-11' + '**Wave:** 23' + '**Status:** DESIGN — V-295c shipped the basic status site at' + 'status.driftstack.io. V-545 designs the next-layer features' + 'Overall platform status (operational / degraded / outage), driven by' + 'the `/v1/status` endpoint (V-295c).' + 'Per-component status (API / dashboard / docs / marketing).' + 'Most recent incidents (last 5).' + 'Existing admin endpoints (V-516):' + 'POST /v1/admin/incidents — open an incident.' + 'PATCH /v1/admin/incidents/:id — update / close.' + 'GET /v1/admin/status-subscribers — list email subscribers.' — pinned so the V-545-DESIGN-Wave-23-2026-05-11 + V-295c-shipped-status.driftstack.dev + /v1/status-endpoint + 4-component (API/dashboard/docs/marketing) + last-5-incidents + V-516-3-admin-endpoint commitment survives", () => {
    expect(body).toMatch(/^# V-545 — status-page enhancements$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 23/);
    expect(body).toMatch(/\*\*Status:\*\* DESIGN — V-295c shipped the basic status site at/);
    expect(body).toMatch(/status\.driftstack\.io\. V-545 designs the next-layer features/);
    expect(body).toMatch(
      /- Overall platform status \(operational \/ degraded \/ outage\), driven by/,
    );
    expect(body).toMatch(/the `\/v1\/status` endpoint \(V-295c\)\./);
    expect(body).toMatch(/- Per-component status \(API \/ dashboard \/ docs \/ marketing\)\./);
    expect(body).toMatch(/- Most recent incidents \(last 5\)\./);
    expect(body).toMatch(/Existing admin endpoints \(V-516\):/);
    expect(body).toMatch(/- `POST \/v1\/admin\/incidents` — open an incident\./);
    expect(body).toMatch(/- `PATCH \/v1\/admin\/incidents\/:id` — update \/ close\./);
    expect(body).toMatch(/- `GET \/v1\/admin\/status-subscribers` — list email subscribers\./);
  });

  it("V-545.A + V-545.B + V-545.C 3-cluster framing pinned: '### V-545.A — incident posting workflow polish' + 'Each `PATCH /v1/admin/incidents/:id` writes a new row to' + '`incident_updates` (proposed table).' + 'Status site renders the timeline per incident in reverse-chrono' + 'order.' + 'Admin can mark an update as \"operator-only\" (skipped from the' + 'status-site render) for internal notes.' + '### V-545.B — subscriber notification' + '**Email-on-incident-open** — Postmark template' + '`incident-opened` sent to all subscribers when incident state goes' + '**Email-on-update** — `incident-updated` template per update,' + 'throttled to max 1 per subscriber per incident per hour' + '**Email-on-resolve** — `incident-resolved` template when state' + 'Unsubscribe-all link in every email.' + 'Per-component subscribe (subscribe only to API outages, not docs).' + '### V-545.C — history view' + '`/status/history/2026-05` — month-archive view' + 'Permalink per incident: `/status/incidents/incident-id-slug`.' + 'RSS feed at `/status/feed.xml`' — pinned so the 3-cluster + incident_updates-reverse-chrono + operator-only-skip + 3-Postmark-template (incident-opened/updated/resolved) + 1/hour-throttle + unsubscribe-all + per-component + history-month-archive + permalink + RSS commitment survives", () => {
    expect(body).toMatch(/### V-545\.A — incident posting workflow polish/);
    expect(body).toMatch(/1\. Each `PATCH \/v1\/admin\/incidents\/:id` writes a new row to/);
    expect(body).toMatch(/`incident_updates` \(proposed table\)\./);
    expect(body).toMatch(/2\. Status site renders the timeline per incident in reverse-chrono/);
    expect(body).toMatch(/order\./);
    expect(body).toMatch(/3\. Admin can mark an update as "operator-only" \(skipped from the/);
    expect(body).toMatch(/status-site render\) for internal notes\./);
    expect(body).toMatch(/### V-545\.B — subscriber notification/);
    expect(body).toMatch(/1\. \*\*Email-on-incident-open\*\* — Postmark template/);
    expect(body).toMatch(/`incident-opened` sent to all subscribers when incident state goes/);
    expect(body).toMatch(/2\. \*\*Email-on-update\*\* — `incident-updated` template per update,/);
    expect(body).toMatch(/throttled to max 1 per subscriber per incident per hour/);
    expect(body).toMatch(/3\. \*\*Email-on-resolve\*\* — `incident-resolved` template when state/);
    expect(body).toMatch(/- Unsubscribe-all link in every email\./);
    expect(body).toMatch(/- Per-component subscribe \(subscribe only to API outages, not docs\)\./);
    expect(body).toMatch(/### V-545\.C — history view/);
    expect(body).toMatch(/1\. `\/status\/history\/2026-05` — month-archive view/);
    expect(body).toMatch(/2\. Permalink per incident: `\/status\/incidents\/incident-id-slug`\./);
    expect(body).toMatch(/3\. RSS feed at `\/status\/feed\.xml`/);
  });

  it("incident_updates schema + open-questions + sub-slices framing pinned: '## Schema additions (V-545.A target)' + 'CREATE TABLE incident_updates' + 'incident_id   uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE' + 'operator_only boolean NOT NULL DEFAULT false' + 'CONSTRAINT incident_updates_body_nonempty CHECK (length(body) > 0)' + 'CREATE INDEX incident_updates_incident_id_posted_at_idx' + '## Open questions for team review' + '**Email throttling default.** 1-per-hour per subscriber per incident' + '**Per-component subscribe granularity.** Coarse (API / dashboard /' + '**RSS feed scope.** Open incidents only, or include resolved' + '## Sub-slices' + '**V-545.A** — incident-update timeline + schema + admin route' + '**V-545.B** — subscriber notification (3 Postmark templates +' + '**V-545.C** — status-site history view + permalinks + RSS feed.' + '## Verification' + 'V-205 + V-211 sweep: zero hits.' — pinned so the incident_updates-schema + CASCADE + operator_only-default-false + nonempty-CHECK + posted_at-DESC-index + 3-open-question (throttle-1/hour + 4-coarse-bucket + RSS-include-history) + 3-sub-slice + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Schema additions \(V-545\.A target\)/);
    expect(body).toMatch(/CREATE TABLE incident_updates/);
    expect(body).toMatch(
      /incident_id\s+uuid NOT NULL REFERENCES incidents\(id\) ON DELETE CASCADE/,
    );
    expect(body).toMatch(/operator_only boolean NOT NULL DEFAULT false/);
    expect(body).toMatch(/CONSTRAINT incident_updates_body_nonempty CHECK \(length\(body\) > 0\)/);
    expect(body).toMatch(/CREATE INDEX incident_updates_incident_id_posted_at_idx/);
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(
      /1\. \*\*Email throttling default\.\*\* 1-per-hour per subscriber per incident/,
    );
    expect(body).toMatch(
      /2\. \*\*Per-component subscribe granularity\.\*\* Coarse \(API \/ dashboard \//,
    );
    expect(body).toMatch(/3\. \*\*RSS feed scope\.\*\* Open incidents only, or include resolved/);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-545\.A\*\* — incident-update timeline \+ schema \+ admin route/);
    expect(body).toMatch(/- \*\*V-545\.B\*\* — subscriber notification \(3 Postmark templates \+/);
    expect(body).toMatch(
      /- \*\*V-545\.C\*\* — status-site history view \+ permalinks \+ RSS feed\./,
    );
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
