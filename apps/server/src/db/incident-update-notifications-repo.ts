// V-545.B Phase 2 — repo for `incident_update_notifications` (the
// throttle marker table). IncidentNotificationsService consults it
// before dispatching a `status-incident-updated` email to enforce
// the "max 1 per subscriber per incident per hour" cap.
//
// Tiny surface — one read + one upsert. Drizzle implementation +
// InMemory test seam.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { incidentUpdateNotifications } from './schema.js';

export interface IncidentUpdateNotificationsRepo {
  /** Returns the most-recent `last_sent_at` for the (subscriber,
   *  incident) pair, or null if no row exists yet. */
  findLastSentAt(subscriberId: string, incidentId: string): Promise<Date | null>;
  /** Upserts the row with last_sent_at = `at`. Idempotent on
   *  (subscriber_id, incident_id). */
  markSent(subscriberId: string, incidentId: string, at: Date): Promise<void>;
}

export class DrizzleIncidentUpdateNotificationsRepo implements IncidentUpdateNotificationsRepo {
  constructor(private readonly database: Database) {}

  async findLastSentAt(subscriberId: string, incidentId: string): Promise<Date | null> {
    const [row] = await this.database.db
      .select({ lastSentAt: incidentUpdateNotifications.lastSentAt })
      .from(incidentUpdateNotifications)
      .where(
        and(
          eq(incidentUpdateNotifications.subscriberId, subscriberId),
          eq(incidentUpdateNotifications.incidentId, incidentId),
        ),
      )
      .limit(1);
    return row?.lastSentAt ?? null;
  }

  async markSent(subscriberId: string, incidentId: string, at: Date): Promise<void> {
    await this.database.db
      .insert(incidentUpdateNotifications)
      .values({ subscriberId, incidentId, lastSentAt: at })
      .onConflictDoUpdate({
        target: [incidentUpdateNotifications.subscriberId, incidentUpdateNotifications.incidentId],
        set: { lastSentAt: sql`excluded.last_sent_at` },
      });
  }
}
