// Arc 3 sub-slice 28.5 follow-up (v2-#28 webhook secret server-initiated
// force-rotation).
//
// Tick-driven: each `tickOnce(now)` call finds webhook endpoints whose
// server-initiated grace window (graceWindowEndsAt) closes within the
// next GRACE_EXPIRING_WINDOW_HOURS AND haven't already been sent the
// "grace expiring" last-chance email. Fires
// EmailService.sendWebhookSecretGraceExpiring per match + stamps
// `grace_expiring_notified_at = now` ONLY on a successful send.
//
// This differs from WebhookRotationReminderService.tickOnce, which
// marks-sent UNCONDITIONALLY (a Postmark outage there just delays the
// next 60d-cadence nag by one cooldown window — no harm done). Here the
// notice is time-critical: it fires inside a narrow ~24h window before
// a hard cutover (the old secret stops verifying), and that grace
// window won't reopen for ~91 days (the next force-rotation cycle). A
// swallowed send failure marked "sent" here would silently cost the
// customer their only warning for the rest of that window. Marking
// only on success means a transient send failure is retried on this
// sweep's very next tick instead.
//
// Wiring: bootstrap.ts runs tickOnce once per day via a setInterval
// (mirrors ROTATION_REMINDER_INTERVAL_MS, 24h), gated off by the same
// DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 kill-switch shared with
// the other rotation-related timers. Schema: migration 0093
// (webhook_endpoints.grace_expiring_notified_at).

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { WebhookEndpointRow } from './webhooks.js';

const GRACE_EXPIRING_WINDOW_HOURS = 24;

/**
 * Repo surface this service depends on. Implemented directly on
 * DrizzleWebhooksRepo (apps/server/src/db/webhooks-repo.ts) — the two
 * methods live alongside findEndpointsNeedingForceRotation /
 * forceRotateSecret in that file, structurally satisfying this
 * interface without DrizzleWebhooksRepo needing to `implements` it.
 */
export interface WebhookGraceExpiringNoticeRepo {
  /**
   * Find endpoints where `grace_window_ends_at` is non-null, still in
   * the future (> now — not already expired), due within
   * `windowHours` of now, AND `grace_expiring_notified_at IS NULL`.
   * Returns at most `limit` rows; caller picks limit to bound the
   * per-tick email burst.
   */
  findEndpointsNeedingGraceExpiringNotice(args: {
    now: Date;
    windowHours: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>>;

  /**
   * Mark `grace_expiring_notified_at = now` on an endpoint id. Callers
   * MUST only invoke this after a successful email send (see module
   * header) — unlike WebhookRotationReminderRepo.markReminderSent,
   * which the reminder service calls unconditionally.
   */
  markGraceExpiringNotified(args: { endpointId: string; now: Date }): Promise<void>;
}

export interface WebhookGraceExpiringNoticeServiceConfig {
  /** Maximum emails per tick. Bounds the per-tick burst. */
  perTickLimit?: number;
  /**
   * v2-#36 — customer-facing dashboard origin (DASHBOARD_ORIGIN env)
   * passed through to the email template so the "fetch the current
   * secret" link points at the right host across dev / staging / prod.
   */
  dashboardUrl: string;
}

export class WebhookGraceExpiringNoticeService {
  private readonly perTickLimit: number;
  private readonly dashboardUrl: string;

  constructor(
    private readonly repo: WebhookGraceExpiringNoticeRepo,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: WebhookGraceExpiringNoticeServiceConfig,
  ) {
    this.perTickLimit = config.perTickLimit ?? 50;
    this.dashboardUrl = config.dashboardUrl;
  }

  /**
   * Sweep eligible endpoints + fire the grace-expiring last-chance
   * email. Marks `graceExpiringNotifiedAt` ONLY on a successful send —
   * a failed send leaves the row eligible so the very next tick
   * retries it (see module header for why this differs from the
   * rotation-reminder's mark-unconditionally pattern). Returns the
   * number of notices dispatched (for telemetry).
   */
  async tickOnce(now: Date): Promise<{ notified: number }> {
    const eligible = await this.repo.findEndpointsNeedingGraceExpiringNotice({
      now,
      windowHours: GRACE_EXPIRING_WINDOW_HOURS,
      limit: this.perTickLimit,
    });

    let notified = 0;
    for (const ep of eligible) {
      if (ep.graceWindowEndsAt === null) {
        // Shouldn't happen (the query filters on IS NOT NULL) but keep
        // the type-narrowing honest without throwing mid-sweep.
        this.logger.warn(
          { endpointId: ep.id, accountId: ep.accountId },
          'WebhookGraceExpiringNoticeService matched a row with null graceWindowEndsAt; skipping',
        );
        continue;
      }

      if (ep.accountEmail === null) {
        this.logger.warn(
          { endpointId: ep.id, accountId: ep.accountId },
          'WebhookGraceExpiringNoticeService no accountEmail on record; skipping send (retries next tick)',
        );
        continue;
      }

      try {
        await this.email.sendWebhookSecretGraceExpiring({
          to: ep.accountEmail,
          endpointUrl: ep.url,
          secretPrefix: ep.secretPrefix,
          graceWindowEndsAt: ep.graceWindowEndsAt,
          dashboardUrl: this.dashboardUrl,
        });
      } catch (err) {
        this.logger.warn(
          { err, endpointId: ep.id, accountId: ep.accountId },
          'WebhookGraceExpiringNoticeService email send failed; NOT marking notified so the next tick retries',
        );
        continue;
      }

      try {
        await this.repo.markGraceExpiringNotified({ endpointId: ep.id, now });
        notified += 1;
      } catch (err) {
        this.logger.error(
          { err, endpointId: ep.id, accountId: ep.accountId },
          'WebhookGraceExpiringNoticeService markGraceExpiringNotified failed after a successful send; next tick will re-send (accepted duplicate-notice risk over a silently-dropped one)',
        );
      }
    }

    if (notified > 0) {
      this.logger.info({ notified }, 'WebhookGraceExpiringNoticeService dispatched notices');
    }
    return { notified };
  }
}
