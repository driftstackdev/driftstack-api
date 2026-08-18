// v2-#11.5 — BYOK Anthropic key rotation reminder service.
//
// Mirrors v2-#10.5 (webhook secret rotation reminder) for the
// per-account BYOK Anthropic API key. Each `tickOnce(now)` call
// finds accounts whose BYOK key was set more than 60d ago AND that
// haven't been reminded in the 7d cooldown window. Fires a Postmark
// reminder email per match + stamps
// `byok_anthropic_api_key_last_reminder_sent_at = now`.
//
// This service does NOT auto-rotate — only the customer can rotate
// (via PUT /v1/account/me/byok-anthropic-key). The reminder is a
// nag, not a side-effecting action.
//
// Wiring: LANDED. `bootstrap.ts` registers this through
// `wireDailyMaintenanceSweep` under `BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE`,
// which calls `tickOnce(now)` once per day, and the job type is in
// `EXPECTED_RECURRING_JOB_TYPES` so the chain-liveness gauge watches it.
// Reminders fire. The schema (v2-#11 migration 0049) is in place.
//
// V-841 — this said the wire was deferred and the service dormant, with no
// reminders firing. It has been sending customer email since the sweep was
// wired. Nothing here contradicted itself, which is why it survived: the
// dormancy claim and the code that fires the reminder live in different
// files, and the pin over this header only ever compared it to itself.

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';

const REMINDER_THRESHOLD_DAYS = 60;
const COOLDOWN_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROTATION_TARGET_DAYS = 90;

export interface ByokAnthropicReminderRow {
  accountId: string;
  accountEmail: string | null;
  byokAnthropicApiKeySetAt: Date;
  byokAnthropicApiKeyLastReminderSentAt: Date | null;
}

export interface ByokAnthropicRotationReminderRepo {
  findAccountsNeedingRotationReminder(args: {
    now: Date;
    thresholdDays: number;
    cooldownDays: number;
    limit: number;
  }): Promise<ReadonlyArray<ByokAnthropicReminderRow>>;

  markReminderSent(args: { accountId: string; now: Date }): Promise<void>;
}

export interface ByokAnthropicRotationReminderServiceConfig {
  perTickLimit?: number;
  /** v2-#36 — customer-facing dashboard origin threaded into the
   *  email template so the rotation link points at the right host. */
  dashboardUrl: string;
}

export class ByokAnthropicRotationReminderService {
  private readonly perTickLimit: number;
  private readonly dashboardUrl: string;

  constructor(
    private readonly repo: ByokAnthropicRotationReminderRepo,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: ByokAnthropicRotationReminderServiceConfig,
  ) {
    this.perTickLimit = config.perTickLimit ?? 50;
    this.dashboardUrl = config.dashboardUrl;
  }

  async tickOnce(now: Date): Promise<{ reminded: number }> {
    const eligible = await this.repo.findAccountsNeedingRotationReminder({
      now,
      thresholdDays: REMINDER_THRESHOLD_DAYS,
      cooldownDays: COOLDOWN_DAYS,
      limit: this.perTickLimit,
    });

    let reminded = 0;
    for (const row of eligible) {
      const ageDays = Math.floor(
        (now.getTime() - row.byokAnthropicApiKeySetAt.getTime()) / MS_PER_DAY,
      );
      const rotateBy = new Date(
        row.byokAnthropicApiKeySetAt.getTime() + ROTATION_TARGET_DAYS * MS_PER_DAY,
      );

      if (row.accountEmail !== null) {
        try {
          await this.email.sendByokAnthropicKeyRotationReminder({
            to: row.accountEmail,
            ageDays,
            rotateBy,
            dashboardUrl: this.dashboardUrl,
          });
        } catch (err) {
          this.logger.warn(
            { err, accountId: row.accountId },
            'ByokAnthropicRotationReminderService email send failed (non-fatal); marking sent anyway',
          );
        }
      } else {
        this.logger.warn(
          { accountId: row.accountId },
          'ByokAnthropicRotationReminderService no accountEmail; skipping send',
        );
      }

      try {
        await this.repo.markReminderSent({ accountId: row.accountId, now });
        reminded += 1;
      } catch (err) {
        this.logger.error(
          { err, accountId: row.accountId },
          'ByokAnthropicRotationReminderService markReminderSent failed; will retry on next tick',
        );
      }
    }

    if (reminded > 0) {
      this.logger.info({ reminded }, 'ByokAnthropicRotationReminderService dispatched reminders');
    }
    return { reminded };
  }
}
