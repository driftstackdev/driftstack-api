// W933 — V-295c3-followup incident-notifications fan-out cross-
// source invariant. Two-hundred-fifty-ninth in the drift-guard
// series. Pins the incident-notification fan-out service:
//
//   V-295c3-followup anchor — 'incident-notification fan-out.
//   Wraps StatusSubscribersService + EmailService and exposes
//   notifyCreated / notifyResolved methods that the IncidentsService
//   lifecycle hooks invoke'.
//
//   4-step fan-out per method:
//     1. Snapshot confirmed-subscriber list at notify-time.
//     2. Rotate the unsubscribe token PER subscriber (one-click
//        unsub works exactly once per recipient).
//     3. Send appropriate template ('created' or 'resolved') with
//        fresh personal unsubscribe URL.
//     4. Log fan-out count + per-recipient errors. Each send is
//        fire-and-forget; one bad address can't poison the batch.
//
//   Serial dispatch — 'subscriber list is small at launch; when
//   scale becomes a concern, swap to the V-202d scheduled-jobs
//   pattern with per-subscriber jobs'.
//
//   V-295c3-tombstone null-email guard — 'listConfirmed only
//   returns rows where unsubscribed_at IS NULL, so email IS NOT
//   NULL by invariant (purge only fires post-unsubscribe). Guard
//   for type-narrowing'.
//
//   notifyCreated uses incident.startedAt as timestamp;
//     notifyResolved uses incident.resolvedAt ?? new Date() (current
//     time fallback when resolved-at is unset).
//
//   statusPageBaseUrl trailing-slash stripped at construction.
//
//   Per-recipient error logged at WARN with component +
//     email + kind + err fields. Batch summary logged at INFO with
//     component + kind + incidentId + ok + failed.
//
// stays in lockstep across
// apps/server/src/services/incident-notifications.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W933 V-295c3-followup incident-notifications cross-source invariant', () => {
  // ─── V-295c3-followup anchor + wrapping framing ──────────────

  it("CRITICAL apps/server/src/services/incident-notifications.ts header pins V-295c3-followup anchor — 'V-295c3-followup — incident-notification fan-out. Wraps StatusSubscribersService + EmailService and exposes notifyCreated / notifyResolved methods that the IncidentsService lifecycle hooks invoke'. The V-295c3-followup + wrap-of-2-services framing is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/V-295c3-followup — incident-notification fan-out/);
    expect(p).toMatch(/Wraps StatusSubscribersService \+ EmailService and exposes/);
    expect(p).toMatch(/`notifyCreated` \/ `notifyResolved` methods that the IncidentsService/);
    expect(p).toMatch(/lifecycle hooks invoke/);
  });

  // ─── 4-step fan-out framing ──────────────────────────────────

  it('CRITICAL 4-step fan-out framing — 1. Snapshot subscriber list. 2. Rotate per-subscriber unsub token. 3. Send template (created/resolved). 4. Log fan-out + per-recipient errors. The 4-step is the customer-facing fan-out contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/1\. Snapshots the confirmed-subscriber list at notify-time/);
    expect(p).toMatch(/2\. For each subscriber, rotates the unsubscribe token \(so the/);
    expect(p).toMatch(/one-click unsub link in this specific email works exactly/);
    expect(p).toMatch(/once per recipient\)/);
    expect(p).toMatch(/3\. Sends the appropriate template \('created' or 'resolved'\) with/);
    expect(p).toMatch(/a fresh personal unsubscribe URL/);
    expect(p).toMatch(/4\. Logs the fan-out count \+ per-recipient errors\. Each send is/);
    expect(p).toMatch(/fire-and-forget; one bad address can't poison the batch/);
  });

  // ─── Serial dispatch + V-202d scaling plan ───────────────────

  it("CRITICAL serial-dispatch framing — 'Dispatch is serial. The subscriber list is small at launch; when scale becomes a concern, swap to the V-202d scheduled-jobs pattern with per-subscriber jobs'. The serial-now + V-202d-later plan is the scope decision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/Dispatch is serial\. The subscriber list is small at launch; when/);
    expect(p).toMatch(/scale becomes a concern, swap to the V-202d scheduled-jobs pattern/);
    expect(p).toMatch(/with per-subscriber jobs/);
  });

  // ─── 2 entrypoints: notifyCreated + notifyResolved ───────────

  it("CRITICAL 2-method API — notifyCreated(incident, initialUpdate) + notifyResolved(incident, finalUpdate). Each delegates to the same private fanOut(incident, update, kind: 'created' | 'resolved'). The 2-method split mirrors the V-295e IncidentEventBus 2-event union.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(
      /async notifyCreated\(incident: IncidentRow, initialUpdate: IncidentUpdateRow\): Promise<void>/,
    );
    expect(p).toMatch(/await this\.fanOut\(incident, initialUpdate, 'created'\);/);
    expect(p).toMatch(
      /async notifyResolved\(incident: IncidentRow, finalUpdate: IncidentUpdateRow\): Promise<void>/,
    );
    expect(p).toMatch(/await this\.fanOut\(incident, finalUpdate, 'resolved'\);/);
  });

  // ─── V-295c3-tombstone null-email guard ──────────────────────

  it("CRITICAL V-295c3-tombstone null-email guard — 'listConfirmed only returns rows where unsubscribed_at IS NULL, so email IS NOT NULL by invariant (purge only fires post-unsubscribe). Guard for type-narrowing'. The invariant + type-narrow guard prevents accidental nulls reaching the email send.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/V-295c3-tombstone — listConfirmed only returns rows where/);
    expect(p).toMatch(/unsubscribed_at IS NULL, so email IS NOT NULL by invariant/);
    expect(p).toMatch(/\(purge only fires post-unsubscribe\)\. Guard for type-narrowing/);
    expect(p).toMatch(/if \(sub\.email === null\) continue;/);
  });

  // ─── Per-recipient unsub token rotation ──────────────────────

  it("CRITICAL per-recipient unsub rotation — 'const unsubPlaintext = await this.subscribers.rotateUnsubscribeToken(sub.id)'. The rotate-per-recipient is what makes the one-click unsub link unique to this specific email; drift to shared-token would invalidate after first click.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(
      /const unsubPlaintext = await this\.subscribers\.rotateUnsubscribeToken\(sub\.id\);/,
    );
  });

  it('CRITICAL unsubscribeLink uses encodeURIComponent and the canonical status-page path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(
      /const unsubscribeLink = `\$\{this\.baseUrl\}\/subscribe\/unsubscribe\/\?token=\$\{encodeURIComponent\(/,
    );
    expect(p).toMatch(/unsubPlaintext,/);
  });

  // ─── 9-field sendStatusIncidentNotification args ─────────────

  it('CRITICAL sendStatusIncidentNotification args carry 9 fields — to + kind + title + severity + status + message + incidentTime + statusPageUrl + unsubscribeLink. The 9-arg template surface gives the email everything it needs to render without further lookups.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/await this\.email\.sendStatusIncidentNotification\(\{/);
    expect(p).toMatch(/to: sub\.email,/);
    expect(p).toMatch(/kind,/);
    expect(p).toMatch(/title: incident\.title,/);
    expect(p).toMatch(/severity: incident\.severity,/);
    expect(p).toMatch(/status: incident\.status,/);
    expect(p).toMatch(/message: update\.message,/);
    expect(p).toMatch(/incidentTime: time,/);
    expect(p).toMatch(/statusPageUrl: this\.baseUrl,/);
    expect(p).toMatch(/unsubscribeLink,/);
  });

  // ─── Time semantics: startedAt vs resolvedAt ?? now ──────────

  it("CRITICAL time field source — 'created' → incident.startedAt; 'resolved' → incident.resolvedAt ?? new Date(); 'updated' → update.postedAt (V-545.B Phase 2). The 3-branch + new-Date-fallback handles the resolved-at-null edge case.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(
      /const time =\s*\n?\s*kind === 'created'\s*\n?\s*\? incident\.startedAt\s*\n?\s*: kind === 'resolved'\s*\n?\s*\? \(incident\.resolvedAt \?\? new Date\(\)\)\s*\n?\s*: update\.postedAt;/,
    );
  });

  // ─── Empty-list early return ─────────────────────────────────

  it('CRITICAL empty-list early return — fanOut returns immediately when recipients.length === 0. The fast-path avoids logging an empty fan-out for zero-subscriber state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/if \(recipients\.length === 0\) return;/);
  });

  // ─── Per-recipient error handling + WARN log ─────────────────

  it("CRITICAL per-recipient error — try/catch around 1 send. Failed: failed += 1 + log warn with component 'incident-notifications' + email (masked) + kind + err fields. The fan-out keeps going past a bad address.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/this\.logger\.warn\(/);
    expect(p).toMatch(/component: 'incident-notifications',/);
    // GDPR / data-minimization — the raw address must not sit in plaintext
    // in logs; maskEmail() keeps just the first local-part char + domain.
    expect(p).toMatch(/email: maskEmail\(sub\.email\),/);
    expect(p).toMatch(/kind,/);
    expect(p).toMatch(/'incident notification email failed'/);
  });

  // ─── Batch summary INFO log ──────────────────────────────────

  it("CRITICAL batch-summary log — info-level with 6 fields — component + kind + incidentId + ok + failed + throttled (V-545.B Phase 2). 'fan-out complete' message. The 6-field telemetry is what dashboards aggregate.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/this\.logger\.info\(/);
    expect(p).toMatch(
      /\{ component: 'incident-notifications', kind, incidentId: incident\.id, ok, failed, throttled \}/,
    );
    expect(p).toMatch(/'fan-out complete'/);
  });

  // ─── statusPageBaseUrl trailing-slash strip ──────────────────

  it('CRITICAL constructor strips trailing slashes on statusPageBaseUrl. The strip matches the V-295c3 status-subscribers + V-202b dashboardUrl + V-281 docsBaseUrl baseUrl-strip pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/this\.baseUrl = config\.statusPageBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
  });

  // ─── IncidentNotificationsConfig 1-field shape ───────────────

  it('CRITICAL IncidentNotificationsConfig has 1 field — statusPageBaseUrl. The single-field config is intentionally minimal — no per-recipient settings here, since per-recipient state lives in the subscriber rows.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(p).toMatch(/export interface IncidentNotificationsConfig \{/);
    expect(p).toMatch(/Public origin of the status site, used for link rendering/);
    expect(p).toMatch(/statusPageBaseUrl: string;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/incident-notifications-v295c3-followup-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
