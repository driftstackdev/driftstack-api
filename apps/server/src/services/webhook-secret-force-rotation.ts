// Arc 3 sub-slice 28.2 (v2-#28 webhook secret server-initiated force-rotation).
//
// Daily sweep that auto-rotates webhook signing secrets past the
// 91-day age threshold (Q1=B). For each rotated endpoint:
//   1. Mint fresh secret via WebhooksRepo.forceRotateSecret (sub-
//      slice 28.1 columns get stamped — graceWindowEndsAt = now + 7d
//      per Q2=B; forceRotatedAt = now so this sweep skips it next
//      cycle).
//   2. Email the customer the new secret prefix + 7-day grace
//      deadline (sub-slice 28.4 template wiring lands separately;
//      this slice fires the existing rotation-reminder email shape
//      for now).
//
// The 7-day grace window is honoured by the v2-#20 worker via
// secret_prev / secret_prev_expires_at; v2-#29's cleanup nulls
// secret_prev past the grace deadline. Validation against incoming
// HMACs (sub-slice 28.3) reads graceWindowEndsAt as the cutoff.

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { WebhookEndpointRow, WebhooksRepo } from './webhooks.js';
import { generateWebhookSecret, webhookSecretPrefix } from '../lib/webhook-signing.js';

const FORCE_ROTATE_THRESHOLD_DAYS = 91;
const GRACE_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WebhookSecretForceRotationServiceConfig {
  perTickLimit?: number;
  /** v2-#36 — customer-facing dashboard origin. The reminder email
   *  links into the dashboard rotation-management view. */
  dashboardUrl: string;
}

export class WebhookSecretForceRotationService {
  private readonly perTickLimit: number;
  private readonly dashboardUrl: string;

  constructor(
    private readonly repo: WebhooksRepo,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: WebhookSecretForceRotationServiceConfig,
  ) {
    this.perTickLimit = config.perTickLimit ?? 50;
    this.dashboardUrl = config.dashboardUrl;
  }

  async tickOnce(now: Date): Promise<{ rotated: number }> {
    const eligible = await this.repo.findEndpointsNeedingForceRotation({
      now,
      thresholdDays: FORCE_ROTATE_THRESHOLD_DAYS,
      limit: this.perTickLimit,
    });

    let rotated = 0;
    for (const ep of eligible) {
      const newSecret = generateWebhookSecret();
      const newPrefix = webhookSecretPrefix(newSecret);
      const graceWindowEndsAt = new Date(now.getTime() + GRACE_WINDOW_DAYS * MS_PER_DAY);
      const updated: WebhookEndpointRow | null = await this.repo.forceRotateSecret({
        id: ep.id,
        newSecret,
        newPrefix,
        graceWindowEndsAt,
        now,
      });
      if (updated === null) {
        this.logger.warn(
          { endpointId: ep.id, accountId: ep.accountId },
          'force-rotation update returned no row (endpoint disappeared / disabled); skipping email',
        );
        continue;
      }
      rotated += 1;
      if (ep.accountEmail !== null) {
        try {
          // Arc 3 sub-slice 28.4 (v2-#28) — dedicated template
          // distinguishes the force-rotation event from the 60-day
          // reminder. Customer sees "we auto-rotated for security"
          // framing instead of "rotate at your convenience".
          await this.email.sendWebhookSecretForceRotated({
            to: ep.accountEmail,
            endpointUrl: ep.url,
            newSecretPrefix: newPrefix,
            graceWindowEndsAt,
            dashboardUrl: this.dashboardUrl,
          });
        } catch (err) {
          this.logger.warn(
            { err, endpointId: ep.id, accountId: ep.accountId },
            'force-rotation email send failed (non-fatal); rotation persisted',
          );
        }
      } else {
        this.logger.warn(
          { endpointId: ep.id, accountId: ep.accountId },
          'force-rotation: no accountEmail on record; rotation persisted without notification',
        );
      }
    }

    if (rotated > 0) {
      this.logger.info({ rotated }, 'WebhookSecretForceRotationService completed sweep');
    }
    return { rotated };
  }
}
