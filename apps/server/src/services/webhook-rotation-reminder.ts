// v2-#10.5 — webhook signing-secret rotation reminder service.
//
// Tick-driven: each `tickOnce(now)` call finds webhook endpoints with
// secrets older than the threshold AND that haven't been reminded in
// the cooldown window. Fires a Postmark reminder email per match +
// stamps `last_reminder_sent_at = now`.
//
// This service does NOT auto-rotate the secret — only the customer can
// rotate (via POST /v1/webhooks/:id/rotate-secret). The reminder is a
// nag, not a side-effecting action; the existing V-359 dual-sign
// machinery handles the actual rotation with zero customer downtime.
//
// Wiring (LIVE as a durable job chain): bootstrap.ts runs tickOnce once
// per day as a self-re-arming scheduled_jobs row
// (WEBHOOK_ROTATION_REMINDER_JOB_TYPE, DAILY_MAINTENANCE_INTERVAL_MS =
// 24h), gated off by DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 (the
// kill-switch shared with the BYOK/API-key reminder sweeps). The schema
// is v2-#10 migration 0048.
//
// V-784 replaced a bare 24h setInterval here. That timer fired its first
// tick a full day after boot and kept the schedule only in memory, so a
// deploy cadence under 24 hours meant this reminder never sent at all —
// and because chain liveness is rostered from *_JOB_TYPE constants, a
// sweep that was not a job had no series to report zero on. (An earlier
// revision of this header said the wiring was deferred/dormant — stale
// since the timer shipped, and the timer itself is now gone too.)

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { WebhookEndpointRow } from './webhooks.js';

const REMINDER_THRESHOLD_DAYS = 60;
const COOLDOWN_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROTATION_TARGET_DAYS = 90;

/**
 * Repository extension. Two new methods on top of the existing
 * WebhooksRepo surface; concrete impl lives in the Drizzle repo +
 * is stubbed in the in-memory test repo.
 */
export interface WebhookRotationReminderRepo {
  /**
   * Find endpoints with `secret_created_at < now - threshold` AND
   * (`last_reminder_sent_at IS NULL` OR `< now - cooldown`).
   * Returns at most `limit` rows; caller picks limit to bound the
   * per-tick email burst.
   */
  findEndpointsNeedingRotationReminder(args: {
    now: Date;
    thresholdDays: number;
    cooldownDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>>;

  /**
   * Mark `last_reminder_sent_at = now` on an endpoint id. Idempotent
   * per id (always writes; the cooldown query is what dedupes).
   */
  markReminderSent(args: { endpointId: string; now: Date }): Promise<void>;
}

export interface WebhookRotationReminderServiceConfig {
  /** Maximum emails per tick. Bounds the per-tick burst. */
  perTickLimit?: number;
  /**
   * v2-#36 — customer-facing dashboard origin (DASHBOARD_ORIGIN env)
   * passed through to the email template so the rotation link points
   * at the right host across dev / staging / prod. Required so a
   * staging deploy doesn't mail customers a prod-dashboard link.
   */
  dashboardUrl: string;
}

export class WebhookRotationReminderService {
  private readonly perTickLimit: number;
  private readonly dashboardUrl: string;

  constructor(
    private readonly repo: WebhookRotationReminderRepo,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: WebhookRotationReminderServiceConfig,
  ) {
    this.perTickLimit = config.perTickLimit ?? 50;
    this.dashboardUrl = config.dashboardUrl;
  }

  /**
   * Sweep eligible endpoints + fire reminder emails. Best-effort:
   * email failures swallowed; the markReminderSent update still
   * fires so a transient Postmark outage doesn't loop reminders.
   * Returns the number of reminders dispatched (for telemetry).
   */
  async tickOnce(now: Date): Promise<{ reminded: number }> {
    const eligible = await this.repo.findEndpointsNeedingRotationReminder({
      now,
      thresholdDays: REMINDER_THRESHOLD_DAYS,
      cooldownDays: COOLDOWN_DAYS,
      limit: this.perTickLimit,
    });

    let reminded = 0;
    for (const ep of eligible) {
      const ageDays = Math.floor((now.getTime() - ep.secretCreatedAt.getTime()) / MS_PER_DAY);
      const rotateBy = new Date(ep.secretCreatedAt.getTime() + ROTATION_TARGET_DAYS * MS_PER_DAY);

      if (ep.accountEmail !== null) {
        try {
          await this.email.sendWebhookSecretRotationReminder({
            to: ep.accountEmail,
            endpointUrl: ep.url,
            secretPrefix: ep.secretPrefix,
            ageDays,
            rotateBy,
            dashboardUrl: this.dashboardUrl,
          });
        } catch (err) {
          this.logger.warn(
            { err, endpointId: ep.id, accountId: ep.accountId },
            'WebhookRotationReminderService email send failed (non-fatal); marking sent anyway',
          );
        }
      } else {
        this.logger.warn(
          { endpointId: ep.id, accountId: ep.accountId },
          'WebhookRotationReminderService no accountEmail; skipping send',
        );
      }

      try {
        await this.repo.markReminderSent({ endpointId: ep.id, now });
        reminded += 1;
      } catch (err) {
        this.logger.error(
          { err, endpointId: ep.id, accountId: ep.accountId },
          'WebhookRotationReminderService markReminderSent failed; will retry on next tick',
        );
      }
    }

    if (reminded > 0) {
      this.logger.info({ reminded }, 'WebhookRotationReminderService dispatched reminders');
    }
    return { reminded };
  }
}
