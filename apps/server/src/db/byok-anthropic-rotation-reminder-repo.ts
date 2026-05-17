// v2-#11.5 — Drizzle-backed ByokAnthropicRotationReminderRepo.
//
// Queries accounts whose BYOK Anthropic API key is older than the
// threshold AND hasn't been reminded in the cooldown window. Mirrors
// the webhook-rotation pattern (v2-#10.5).

import { and, eq, isNull, lt, not, or } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type {
  ByokAnthropicReminderRow,
  ByokAnthropicRotationReminderRepo,
} from '../services/byok-anthropic-rotation-reminder.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class DrizzleByokAnthropicRotationReminderRepo implements ByokAnthropicRotationReminderRepo {
  constructor(private readonly database: Database) {}

  async findAccountsNeedingRotationReminder(args: {
    now: Date;
    thresholdDays: number;
    cooldownDays: number;
    limit: number;
  }): Promise<ReadonlyArray<ByokAnthropicReminderRow>> {
    const thresholdCutoff = new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY);
    const cooldownCutoff = new Date(args.now.getTime() - args.cooldownDays * MS_PER_DAY);

    const rows = await this.database.db
      .select({
        accountId: accounts.id,
        accountEmail: accounts.email,
        byokAnthropicApiKeySetAt: accounts.byokAnthropicApiKeySetAt,
        byokAnthropicApiKeyLastReminderSentAt: accounts.byokAnthropicApiKeyLastReminderSentAt,
      })
      .from(accounts)
      .where(
        and(
          // BYOK key must be set (otherwise there's nothing to rotate).
          not(isNull(accounts.byokAnthropicApiKeySetAt)),
          // Key age exceeds threshold.
          lt(accounts.byokAnthropicApiKeySetAt, thresholdCutoff),
          // Dedupe: never reminded or last reminder older than cooldown.
          or(
            isNull(accounts.byokAnthropicApiKeyLastReminderSentAt),
            lt(accounts.byokAnthropicApiKeyLastReminderSentAt, cooldownCutoff),
          ),
        ),
      )
      .orderBy(accounts.byokAnthropicApiKeySetAt)
      .limit(args.limit);

    return rows
      .filter(
        (r): r is typeof r & { byokAnthropicApiKeySetAt: Date } =>
          r.byokAnthropicApiKeySetAt !== null,
      )
      .map((r) => ({
        accountId: r.accountId,
        accountEmail: r.accountEmail,
        byokAnthropicApiKeySetAt: r.byokAnthropicApiKeySetAt,
        byokAnthropicApiKeyLastReminderSentAt: r.byokAnthropicApiKeyLastReminderSentAt,
      }));
  }

  async markReminderSent(args: { accountId: string; now: Date }): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({ byokAnthropicApiKeyLastReminderSentAt: args.now })
      .where(eq(accounts.id, args.accountId));
  }
}
