// In-memory StripeWebhooksRepo for integration tests.

import type { StripeWebhooksRepo } from '../../../src/services/stripe-webhooks.js';

interface Row {
  eventId: string;
  eventType: string;
  payloadHash: string;
  result: string;
  receivedAt: Date;
}

export class InMemoryStripeWebhooksRepo implements StripeWebhooksRepo {
  private readonly events = new Map<string, Row>();

  hasEvent(eventId: string): Promise<boolean> {
    return Promise.resolve(this.events.has(eventId));
  }

  recordEvent(args: Row): Promise<{ inserted: boolean }> {
    if (this.events.has(args.eventId)) {
      return Promise.resolve({ inserted: false });
    }
    this.events.set(args.eventId, args);
    return Promise.resolve({ inserted: true });
  }

  /** Test inspection — list all recorded events in insertion order. */
  list(): Row[] {
    return Array.from(this.events.values());
  }
}
