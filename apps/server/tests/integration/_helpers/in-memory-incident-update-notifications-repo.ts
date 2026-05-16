// V-545.B Phase 2 — in-memory IncidentUpdateNotificationsRepo for
// integration tests. Mirrors the Drizzle implementation's semantics:
// one row per (subscriber, incident), upsert-style mark-sent.

import type { IncidentUpdateNotificationsRepo } from '../../../src/db/incident-update-notifications-repo.js';

export class InMemoryIncidentUpdateNotificationsRepo implements IncidentUpdateNotificationsRepo {
  private readonly rows = new Map<string, Date>();

  private key(subscriberId: string, incidentId: string): string {
    return `${subscriberId}::${incidentId}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findLastSentAt(subscriberId: string, incidentId: string): Promise<Date | null> {
    return this.rows.get(this.key(subscriberId, incidentId)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markSent(subscriberId: string, incidentId: string, at: Date): Promise<void> {
    this.rows.set(this.key(subscriberId, incidentId), at);
  }
}
