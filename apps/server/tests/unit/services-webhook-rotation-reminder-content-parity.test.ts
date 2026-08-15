// Drift guard for apps/server/src/services/webhook-rotation-reminder.ts.
// Pins the v2-#10.5 webhook signing-secret rotation reminder service.
// Tick-driven; sends nag emails for stale secrets; does NOT auto-rotate.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/webhook-rotation-reminder.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/webhook-rotation-reminder content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("v2-#10.5 module-level framing pinned: 'webhook signing-secret rotation reminder service. Tick-driven: each tickOnce(now) call finds webhook endpoints with secrets older than the threshold AND that haven't been reminded in the cooldown window. Fires a Postmark reminder email per match + stamps last_reminder_sent_at = now.' — pinned so the v2-#10.5 anchor + tick-driven + 2-predicate-filter (age + cooldown) + Postmark-as-transport stay documented", () => {
    expect(body).toMatch(/\/\/ v2-#10\.5 — webhook signing-secret rotation reminder service\./);
    expect(body).toMatch(
      /\/\/ Tick-driven: each `tickOnce\(now\)` call finds webhook endpoints with\s*\n?\s*\/\/ secrets older than the threshold AND that haven't been reminded in\s*\n?\s*\/\/ the cooldown window\. Fires a Postmark reminder email per match \+\s*\n?\s*\/\/ stamps `last_reminder_sent_at = now`\./,
    );
  });

  it("Nag-not-auto-rotate framing pinned: 'This service does NOT auto-rotate the secret — only the customer can rotate (via POST /v1/webhooks/:id/rotate-secret). The reminder is a nag, not a side-effecting action; the existing V-359 dual-sign machinery handles the actual rotation with zero customer downtime.' — pinned so the customer-only-rotates + nag-only contract + V-359 dual-sign cross-reference all stay documented (drift to auto-rotation would silently break customer integrations between secret rotation and verifier-side update)", () => {
    expect(body).toMatch(
      /\/\/ This service does NOT auto-rotate the secret — only the customer can\s*\n?\s*\/\/ rotate \(via POST \/v1\/webhooks\/:id\/rotate-secret\)\. The reminder is a\s*\n?\s*\/\/ nag, not a side-effecting action; the existing V-359 dual-sign\s*\n?\s*\/\/ machinery handles the actual rotation with zero customer downtime\./,
    );
  });

  it('Wiring-LIVE framing pinned: the header documents the durable daily job chain (WEBHOOK_ROTATION_REMINDER_JOB_TYPE, 24h DAILY_MAINTENANCE_INTERVAL_MS) + the DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS kill-switch + migration 0048. This header has now been wrong twice in the same place: it first said the wiring was deferred/dormant after the timer shipped (corrected 2026-06-12), and then described a setInterval after V-784 replaced it with a job chain. Both halves are pinned — the current text positively, the setInterval per-occurrence negatively — because the failure mode is a header that keeps describing whichever wiring it was written against.', () => {
    expect(body).toMatch(
      /\/\/ Wiring \(LIVE as a durable job chain\): bootstrap\.ts runs tickOnce once\s*\n?\s*\/\/ per day as a self-re-arming scheduled_jobs row\s*\n?\s*\/\/ \(WEBHOOK_ROTATION_REMINDER_JOB_TYPE, DAILY_MAINTENANCE_INTERVAL_MS =\s*\n?\s*\/\/ 24h\), gated off by DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1/,
    );
    expect(body).toMatch(/V-784 replaced a bare 24h setInterval here\./);
    expect(body, 'the retracted wiring claim must not survive anywhere in the header').not.toMatch(
      /LIVE since the bootstrap timer landed/,
    );
    expect(body).not.toMatch(/via a setInterval \(ROTATION_REMINDER_INTERVAL_MS/);
  });

  it('4-constant catalog pinned: REMINDER_THRESHOLD_DAYS=60 + COOLDOWN_DAYS=7 + MS_PER_DAY = 24*60*60*1000 + ROTATION_TARGET_DAYS=90. Drift would diverge from the email-template + dashboard-side rotation-status display that all assume these exact values', () => {
    expect(body).toMatch(/const REMINDER_THRESHOLD_DAYS = 60;/);
    expect(body).toMatch(/const COOLDOWN_DAYS = 7;/);
    expect(body).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(/const ROTATION_TARGET_DAYS = 90;/);
  });

  it("WebhookRotationReminderRepo 2-method extension surface pinned: findEndpointsNeedingRotationReminder (composite age+cooldown predicate, bounded by limit) + markReminderSent (idempotent on id). + 'always writes; the cooldown query is what dedupes' framing — pinned so the cooldown-via-query-not-via-application-code contract stays documented (drift to application-side dedup would race with parallel ticks)", () => {
    expect(body).toMatch(/export interface WebhookRotationReminderRepo \{/);
    expect(body).toMatch(
      /findEndpointsNeedingRotationReminder\(args: \{\s*\n?\s*now: Date;\s*\n?\s*thresholdDays: number;\s*\n?\s*cooldownDays: number;\s*\n?\s*limit: number;\s*\n?\s*\}\): Promise<ReadonlyArray<WebhookEndpointRow & \{ accountEmail: string \| null \}>>;/,
    );
    expect(body).toMatch(
      /\* Mark `last_reminder_sent_at = now` on an endpoint id\. Idempotent\s*\n?\s*\*\s+per id \(always writes; the cooldown query is what dedupes\)\./,
    );
  });

  it("v2-#36 dashboardUrl framing pinned: 'customer-facing dashboard origin (DASHBOARD_ORIGIN env) passed through to the email template so the rotation link points at the right host across dev / staging / prod. Required so a staging deploy doesn't mail customers a prod-dashboard link.' — pinned so the v2-#36 anchor + DASHBOARD_ORIGIN env + staging-mustnt-leak-prod-link contract stay documented (drift to a hardcoded URL would re-introduce the staging-leak risk)", () => {
    expect(body).toMatch(
      /\* v2-#36 — customer-facing dashboard origin \(DASHBOARD_ORIGIN env\)\s*\n?\s*\*\s+passed through to the email template so the rotation link points\s*\n?\s*\*\s+at the right host across dev \/ staging \/ prod\. Required so a\s*\n?\s*\*\s+staging deploy doesn't mail customers a prod-dashboard link\./,
    );
    expect(body).toMatch(/dashboardUrl: string;/);
  });

  it('perTickLimit default 50 pinned. Drift would change the per-tick email burst cap — too high risks rate-limiting at Postmark; too low risks reminder backlog never clearing on accounts with hundreds of webhook endpoints', () => {
    expect(body).toMatch(/this\.perTickLimit = config\.perTickLimit \?\? 50;/);
  });

  it('tickOnce 3-step pipeline pinned: 1. findEndpointsNeedingRotationReminder with the 4 args 2. for each eligible: compute ageDays + rotateBy, attempt sendWebhookSecretRotationReminder, then markReminderSent (always, even on send failure) 3. return { reminded }. Drift to skip markReminderSent on send-failure would re-introduce the loop where transient Postmark outages cause the same customer to be re-nagged every tick', () => {
    expect(body).toMatch(/async tickOnce\(now: Date\): Promise<\{ reminded: number \}> \{/);
    expect(body).toMatch(
      /const eligible = await this\.repo\.findEndpointsNeedingRotationReminder\(\{\s*\n?\s*now,\s*\n?\s*thresholdDays: REMINDER_THRESHOLD_DAYS,\s*\n?\s*cooldownDays: COOLDOWN_DAYS,\s*\n?\s*limit: this\.perTickLimit,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const ageDays = Math\.floor\(\(now\.getTime\(\) - ep\.secretCreatedAt\.getTime\(\)\) \/ MS_PER_DAY\);\s*\n?\s*const rotateBy = new Date\(ep\.secretCreatedAt\.getTime\(\) \+ ROTATION_TARGET_DAYS \* MS_PER_DAY\);/,
    );
  });

  it("Best-effort email-send + mark-sent-anyway framing pinned: 'email failures swallowed; the markReminderSent update still fires so a transient Postmark outage doesn't loop reminders.' — pinned so the swallow-send-error + mark-sent-on-failure contract stays documented", () => {
    expect(body).toMatch(
      /\* Sweep eligible endpoints \+ fire reminder emails\. Best-effort:\s*\n?\s*\*\s+email failures swallowed; the markReminderSent update still\s*\n?\s*\*\s+fires so a transient Postmark outage doesn't loop reminders\./,
    );
    expect(body).toMatch(
      /'WebhookRotationReminderService email send failed \(non-fatal\); marking sent anyway',/,
    );
  });

  it("No-accountEmail skip-without-mark pinned: when accountEmail is null, the service warns + skips the send. Drift would either crash on null-email OR send to '' (Postmark would reject; on subsequent retries the same row would be retried indefinitely since markReminderSent never fires in the no-email branch)", () => {
    expect(body).toMatch(
      /\} else \{\s*\n?\s*this\.logger\.warn\(\s*\n?\s*\{ endpointId: ep\.id, accountId: ep\.accountId \},\s*\n?\s*'WebhookRotationReminderService no accountEmail; skipping send',\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it("markReminderSent error-path retry-on-next-tick framing pinned: 'WebhookRotationReminderService markReminderSent failed; will retry on next tick'. Drift to swallowing the error without a retry signal would silently corrupt the once-per-cooldown invariant", () => {
    expect(body).toMatch(
      /'WebhookRotationReminderService markReminderSent failed; will retry on next tick',/,
    );
  });
});
