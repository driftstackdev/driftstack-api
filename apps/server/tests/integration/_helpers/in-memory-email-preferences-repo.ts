// V-204 — in-memory EmailPreferencesRepo for integration tests.

import type { OptOutableEmailEvent } from '@driftstack/api-types';
import type {
  EmailPreferenceRecord,
  EmailPreferencesRepo,
} from '../../../src/services/email-preferences.js';

export class InMemoryEmailPreferencesRepo implements EmailPreferencesRepo {
  private readonly rows = new Map<string, EmailPreferenceRecord>();

  private key(accountId: string, eventType: OptOutableEmailEvent): string {
    return `${accountId}:${eventType}`;
  }

  list(accountId: string): Promise<EmailPreferenceRecord[]> {
    const out: EmailPreferenceRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.accountId === accountId) out.push(r);
    }
    // V-1208 — mirrors DrizzleEmailPreferencesRepo's `ORDER BY event_type`. Map iteration is
    // write order, which agreed with the real repo only until a customer opted out of two events
    // in non-alphabetical order. V-1201 gave the Drizzle side its ORDER BY and left this behind.
    out.sort((a, b) => a.eventType.localeCompare(b.eventType));
    return Promise.resolve(out);
  }

  set(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean): Promise<void> {
    const k = this.key(accountId, eventType);
    if (optedIn) {
      this.rows.delete(k);
      return Promise.resolve();
    }
    this.rows.set(k, {
      accountId,
      eventType,
      optedIn: false,
      updatedAt: new Date(),
    });
    return Promise.resolve();
  }

  isOptedOut(accountId: string, eventType: OptOutableEmailEvent): Promise<boolean> {
    const r = this.rows.get(this.key(accountId, eventType));
    if (!r) return Promise.resolve(false);
    return Promise.resolve(r.optedIn === false);
  }
}
