// V-204 — Drizzle-backed EmailPreferencesRepo.

import { and, asc, eq } from 'drizzle-orm';
import type { OptOutableEmailEvent } from '@driftstack/api-types';
import type { EmailPreferenceRecord, EmailPreferencesRepo } from '../services/email-preferences.js';
import type { Database } from './client.js';
import { accountEmailPreferences } from './schema.js';

export class DrizzleEmailPreferencesRepo implements EmailPreferencesRepo {
  constructor(private readonly database: Database) {}

  async list(accountId: string): Promise<EmailPreferenceRecord[]> {
    const rows = await this.database.db
      .select()
      .from(accountEmailPreferences)
      .where(eq(accountEmailPreferences.accountId, accountId))
      // Rendered as the customer's email-preference list. Without an ORDER BY the same
      // account can see its preferences in a different order on each load; `event_type` is
      // the stable, meaningful key to sort on.
      .orderBy(asc(accountEmailPreferences.eventType));
    return rows.map(toRecord);
  }

  async set(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean): Promise<void> {
    if (optedIn) {
      // Default is opted-in; deleting the row preserves that default
      // while reverting any prior explicit opt-out.
      await this.database.db
        .delete(accountEmailPreferences)
        .where(
          and(
            eq(accountEmailPreferences.accountId, accountId),
            eq(accountEmailPreferences.eventType, eventType),
          ),
        );
      return;
    }
    await this.database.db
      .insert(accountEmailPreferences)
      .values({
        accountId,
        eventType,
        optedIn: false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountEmailPreferences.accountId, accountEmailPreferences.eventType],
        set: { optedIn: false, updatedAt: new Date() },
      });
  }

  async isOptedOut(accountId: string, eventType: OptOutableEmailEvent): Promise<boolean> {
    const [row] = await this.database.db
      .select()
      .from(accountEmailPreferences)
      .where(
        and(
          eq(accountEmailPreferences.accountId, accountId),
          eq(accountEmailPreferences.eventType, eventType),
        ),
      )
      .limit(1);
    if (!row) return false;
    return row.optedIn === false;
  }
}

function toRecord(r: typeof accountEmailPreferences.$inferSelect): EmailPreferenceRecord {
  return {
    accountId: r.accountId,
    eventType: r.eventType as OptOutableEmailEvent,
    optedIn: r.optedIn,
    updatedAt: r.updatedAt,
  };
}
