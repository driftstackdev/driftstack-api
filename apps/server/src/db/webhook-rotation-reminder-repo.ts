// v2-#10.5 — Drizzle-backed WebhookRotationReminderRepo.
//
// Queries the joined webhook_endpoints + accounts shape for the
// reminder sweep. `now - thresholdDays` filters the secret age;
// `now - cooldownDays` filters the dedupe column.

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts, webhookEndpoints } from './schema.js';
import type { WebhookRotationReminderRepo } from '../services/webhook-rotation-reminder.js';
import type { WebhookEndpointRow } from '../services/webhooks.js';
import { readWebhookSecret } from '../lib/webhook-secret-encryption.js';
import { sanitizePersistedWebhookEvents } from './webhooks-repo.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class DrizzleWebhookRotationReminderRepo implements WebhookRotationReminderRepo {
  private readonly secretEncryptionKeyBase64: string | undefined;

  constructor(
    private readonly database: Database,
    options: { secretEncryptionKeyBase64?: string } = {},
  ) {
    this.secretEncryptionKeyBase64 = options.secretEncryptionKeyBase64;
  }

  async findEndpointsNeedingRotationReminder(args: {
    now: Date;
    thresholdDays: number;
    cooldownDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>> {
    const thresholdCutoff = new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY);
    const cooldownCutoff = new Date(args.now.getTime() - args.cooldownDays * MS_PER_DAY);

    const rows = await this.database.db
      .select({
        id: webhookEndpoints.id,
        accountId: webhookEndpoints.accountId,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        secretPrefix: webhookEndpoints.secretPrefix,
        secretPrev: webhookEndpoints.secretPrev,
        secretPrevExpiresAt: webhookEndpoints.secretPrevExpiresAt,
        secretCreatedAt: webhookEndpoints.secretCreatedAt,
        lastReminderSentAt: webhookEndpoints.lastReminderSentAt,
        graceWindowEndsAt: webhookEndpoints.graceWindowEndsAt,
        forceRotatedAt: webhookEndpoints.forceRotatedAt,
        events: webhookEndpoints.events,
        description: webhookEndpoints.description,
        active: webhookEndpoints.active,
        consecutiveFailures: webhookEndpoints.consecutiveFailures,
        lastSuccessAt: webhookEndpoints.lastSuccessAt,
        lastFailureAt: webhookEndpoints.lastFailureAt,
        disabledAt: webhookEndpoints.disabledAt,
        createdAt: webhookEndpoints.createdAt,
        updatedAt: webhookEndpoints.updatedAt,
        accountEmail: accounts.email,
      })
      .from(webhookEndpoints)
      .innerJoin(accounts, eq(accounts.id, webhookEndpoints.accountId))
      .where(
        and(
          // Disabled endpoints are tombstones; skip them.
          isNull(webhookEndpoints.disabledAt),
          // Active-secret age exceeds the threshold.
          lt(webhookEndpoints.secretCreatedAt, thresholdCutoff),
          // Dedupe: either never reminded or last reminder older than
          // cooldown.
          or(
            isNull(webhookEndpoints.lastReminderSentAt),
            lt(webhookEndpoints.lastReminderSentAt, cooldownCutoff),
          ),
        ),
      )
      .orderBy(webhookEndpoints.secretCreatedAt)
      .limit(args.limit);

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      url: r.url,
      secret: readWebhookSecret(r.secret, this.secretEncryptionKeyBase64),
      secretPrefix: r.secretPrefix,
      secretPrev:
        r.secretPrev !== null
          ? readWebhookSecret(r.secretPrev, this.secretEncryptionKeyBase64)
          : null,
      secretPrevExpiresAt: r.secretPrevExpiresAt,
      secretCreatedAt: r.secretCreatedAt,
      lastReminderSentAt: r.lastReminderSentAt,
      graceWindowEndsAt: r.graceWindowEndsAt,
      forceRotatedAt: r.forceRotatedAt,
      events: sanitizePersistedWebhookEvents(r.events),
      description: r.description,
      active: r.active,
      consecutiveFailures: r.consecutiveFailures,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      disabledAt: r.disabledAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      accountEmail: r.accountEmail,
    }));
  }

  async markReminderSent(args: { endpointId: string; now: Date }): Promise<void> {
    await this.database.db
      .update(webhookEndpoints)
      .set({ lastReminderSentAt: args.now })
      .where(eq(webhookEndpoints.id, args.endpointId));
    // sql import kept for future predicate work; suppress unused import warn.
    void sql;
  }
}
