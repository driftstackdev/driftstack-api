// Drizzle-backed StripeWebhooksRepo (V-080). Idempotency ledger for
// inbound Stripe webhook events.

import { eq } from 'drizzle-orm';
import type { StripeWebhooksRepo } from '../services/stripe-webhooks.js';
import type { Database } from './client.js';
import { processedStripeEvents } from './schema.js';

export class DrizzleStripeWebhooksRepo implements StripeWebhooksRepo {
  constructor(private readonly database: Database) {}

  async hasEvent(eventId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ eventId: processedStripeEvents.eventId })
      .from(processedStripeEvents)
      .where(eq(processedStripeEvents.eventId, eventId))
      .limit(1);
    return row !== undefined;
  }

  async recordEvent(args: {
    eventId: string;
    eventType: string;
    payloadHash: string;
    result: string;
    receivedAt: Date;
  }): Promise<{ inserted: boolean }> {
    // INSERT ... ON CONFLICT DO NOTHING resolves the concurrent-delivery
    // race deterministically: only one row wins, the other gets
    // `inserted: false`. The conflict target is the primary key.
    const result = await this.database.db
      .insert(processedStripeEvents)
      .values({
        eventId: args.eventId,
        eventType: args.eventType,
        payloadHash: args.payloadHash,
        result: args.result,
        receivedAt: args.receivedAt,
      })
      .onConflictDoNothing({ target: processedStripeEvents.eventId })
      .returning({ eventId: processedStripeEvents.eventId });
    return { inserted: result.length > 0 };
  }
}
