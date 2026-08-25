// Drift guard for apps/server/src/services/byok-anthropic-rotation-reminder.ts.
// Pins the v2-#11.5 BYOK Anthropic key rotation reminder service —
// mirrors the v2-#10.5 webhook rotation reminder shape (slice 254) for
// per-account Anthropic BYOK keys.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic-rotation-reminder.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/byok-anthropic-rotation-reminder content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("v2-#11.5 module-level framing pinned: 'BYOK Anthropic key rotation reminder service. Mirrors v2-#10.5 (webhook secret rotation reminder) for the per-account BYOK Anthropic API key. Each tickOnce(now) call finds accounts whose BYOK key was set more than 60d ago AND that haven't been reminded in the 7d cooldown window. Fires a Postmark reminder email per match + stamps byok_anthropic_api_key_last_reminder_sent_at = now.' — pinned so the v2-#11.5 anchor + v2-#10.5 mirror reference + 60d-threshold + 7d-cooldown + the exact column name byok_anthropic_api_key_last_reminder_sent_at all stay documented", () => {
    expect(body).toMatch(/\/\/ v2-#11\.5 — BYOK Anthropic key rotation reminder service\./);
    expect(body).toMatch(
      /\/\/ Mirrors v2-#10\.5 \(webhook secret rotation reminder\) for the\s*\/\/ per-account BYOK Anthropic API key\. Each `tickOnce\(now\)` call\s*\/\/ finds accounts whose BYOK key was set more than 60d ago AND that\s*\/\/ haven't been reminded in the 7d cooldown window\. Fires a Postmark\s*\/\/ reminder email per match \+ stamps\s*\/\/ `byok_anthropic_api_key_last_reminder_sent_at = now`\./,
    );
  });

  it("Nag-not-auto-rotate framing pinned: 'This service does NOT auto-rotate — only the customer can rotate (via PUT /v1/account/me/byok-anthropic-key). The reminder is a nag, not a side-effecting action.' — pinned so the customer-only-rotates + nag-only contract + exact PUT-endpoint cross-reference all stay documented", () => {
    expect(body).toMatch(
      /\/\/ This service does NOT auto-rotate — only the customer can rotate\s*\/\/ \(via PUT \/v1\/account\/me\/byok-anthropic-key\)\. The reminder is a\s*\/\/ nag, not a side-effecting action\./,
    );
  });

  it('Wiring framing pinned, and checked against bootstrap rather than against itself. V-841 corrected this case: it froze a claim that the service was dormant and fired no reminders, which stopped being true when the daily sweep was wired and stayed pinned regardless', () => {
    expect(body).toMatch(
      /\/\/ Wiring: LANDED\. `bootstrap\.ts` registers this through\s*\/\/ `wireDailyMaintenanceSweep`/,
    );
    // V-841 — CROSS-SOURCE, because a pin over this header could only ever
    // compare it to itself. The dormancy claim was false for as long as the
    // sweep has been wired, and nothing in this file could see that.
    const boot = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'),
      'utf8',
    ).replace(/\/\/[^\n]*/g, '');
    expect(
      boot,
      'the daily sweep that fires these reminders — if this goes, the header must say dormant again',
    ).toMatch(/byokAnthropicRotationReminderService\.tickOnce\(now\)/);
    expect(body, 'the service is not dormant').not.toMatch(/this service is dormant/);
  });

  it('4-constant catalog pinned: REMINDER_THRESHOLD_DAYS=60 + COOLDOWN_DAYS=7 + MS_PER_DAY + ROTATION_TARGET_DAYS=90. + matches the slice-254 webhook-rotation-reminder cohort exactly (cross-service alignment). Drift to a different threshold/cooldown would diverge from the webhook-rotation reminder cohort + the BYOKAnthropicService 90-day TTL (slice 234)', () => {
    expect(body).toMatch(/const REMINDER_THRESHOLD_DAYS = 60;/);
    expect(body).toMatch(/const COOLDOWN_DAYS = 7;/);
    expect(body).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(/const ROTATION_TARGET_DAYS = 90;/);
  });

  it('ByokAnthropicReminderRow 4-field shape pinned: accountId + accountEmail (nullable) + byokAnthropicApiKeySetAt + byokAnthropicApiKeyLastReminderSentAt (nullable). Drift to dropping accountEmail-nullable would crash on rows where the account has no verified email; drift to renaming setAt would mismatch the SQL column name', () => {
    expect(body).toMatch(
      /export interface ByokAnthropicReminderRow \{\s*accountId: string;\s*accountEmail: string \| null;\s*byokAnthropicApiKeySetAt: Date;\s*byokAnthropicApiKeyLastReminderSentAt: Date \| null;\s*\}/,
    );
  });

  it('ByokAnthropicRotationReminderRepo 2-method extension surface pinned: findAccountsNeedingRotationReminder (4-arg composite predicate) + markReminderSent (idempotent on accountId). Drift would diverge from the v2-#10.5 webhook-rotation-reminder repo shape', () => {
    expect(body).toMatch(/export interface ByokAnthropicRotationReminderRepo \{/);
    expect(body).toMatch(
      /findAccountsNeedingRotationReminder\(args: \{\s*now: Date;\s*thresholdDays: number;\s*cooldownDays: number;\s*limit: number;\s*\}\): Promise<ReadonlyArray<ByokAnthropicReminderRow>>;/,
    );
    expect(body).toMatch(
      /markReminderSent\(args: \{ accountId: string; now: Date \}\): Promise<void>;/,
    );
  });

  it("v2-#36 dashboardUrl framing pinned: 'customer-facing dashboard origin threaded into the email template so the rotation link points at the right host.' — pinned so the v2-#36 DASHBOARD_ORIGIN env cross-reference + per-host-rotation-link contract stay documented", () => {
    expect(body).toMatch(
      /\/\*\* v2-#36 — customer-facing dashboard origin threaded into the\s*\*\s+email template so the rotation link points at the right host\. \*\//,
    );
    expect(body).toMatch(/dashboardUrl: string;/);
  });

  it('perTickLimit default 50 pinned (cohort alignment with webhook-rotation-reminder + force-rotation)', () => {
    expect(body).toMatch(/this\.perTickLimit = config\.perTickLimit \?\? 50;/);
  });

  it('tickOnce 3-step pipeline pinned: 1. findAccountsNeedingRotationReminder 2. for each: compute ageDays + rotateBy from byokAnthropicApiKeySetAt, attempt sendByokAnthropicKeyRotationReminder, then markReminderSent (always, even on send failure) 3. return { reminded }. Cohort alignment with slice-254 webhook-rotation-reminder + slice-255 force-rotation', () => {
    expect(body).toMatch(/async tickOnce\(now: Date\): Promise<\{ reminded: number \}> \{/);
    expect(body).toMatch(
      /const eligible = await this\.repo\.findAccountsNeedingRotationReminder\(\{\s*now,\s*thresholdDays: REMINDER_THRESHOLD_DAYS,\s*cooldownDays: COOLDOWN_DAYS,\s*limit: this\.perTickLimit,\s*\}\);/,
    );
    expect(body).toMatch(
      /const ageDays = Math\.floor\(\s*\(now\.getTime\(\) - row\.byokAnthropicApiKeySetAt\.getTime\(\)\) \/ MS_PER_DAY,\s*\);\s*const rotateBy = new Date\(\s*row\.byokAnthropicApiKeySetAt\.getTime\(\) \+ ROTATION_TARGET_DAYS \* MS_PER_DAY,\s*\);/,
    );
  });

  it("sendByokAnthropicKeyRotationReminder 4-field call shape pinned: to + ageDays + rotateBy + dashboardUrl. + 'email send failed (non-fatal); marking sent anyway' best-effort log. Drift to throwing on email failure would loop the same customer on every tick during transient Postmark outage", () => {
    expect(body).toMatch(
      /await this\.email\.sendByokAnthropicKeyRotationReminder\(\{\s*to: row\.accountEmail,\s*ageDays,\s*rotateBy,\s*dashboardUrl: this\.dashboardUrl,\s*\}\);/,
    );
    expect(body).toMatch(
      /'ByokAnthropicRotationReminderService email send failed \(non-fatal\); marking sent anyway',/,
    );
  });

  it('No-accountEmail skip-without-mark + markReminderSent error-path retry-on-next-tick logs pinned. Same cohort-pattern as slice-254 webhook-rotation-reminder', () => {
    expect(body).toMatch(/'ByokAnthropicRotationReminderService no accountEmail; skipping send',/);
    expect(body).toMatch(
      /'ByokAnthropicRotationReminderService markReminderSent failed; will retry on next tick',/,
    );
  });
});
