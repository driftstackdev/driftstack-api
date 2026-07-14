// V-295c3 — Drizzle-backed StatusSubscribersRepo.

import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { StatusSubscriberRow, StatusSubscribersRepo } from '../services/status-subscribers.js';
import type { Database } from './client.js';
import { statusSubscribers } from './schema.js';

type DbRow = typeof statusSubscribers.$inferSelect;

function toRow(row: DbRow): StatusSubscriberRow {
  return {
    id: row.id,
    email: row.email,
    confirmTokenHash: row.confirmTokenHash,
    confirmExpiresAt: row.confirmExpiresAt,
    confirmedAt: row.confirmedAt,
    unsubscribeTokenHash: row.unsubscribeTokenHash,
    unsubscribedAt: row.unsubscribedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleStatusSubscribersRepo implements StatusSubscribersRepo {
  constructor(private readonly database: Database) {}

  async upsertPending(input: {
    email: string;
    confirmTokenHash: string;
    confirmExpiresAt: Date;
  }): Promise<StatusSubscriberRow> {
    // INSERT ... ON CONFLICT (email) DO UPDATE — re-subscribe refreshes only
    // the pending proof. Preserve confirmed/unsubscribed authority until the
    // mailbox owner consumes that proof; anonymous POST must not suppress an
    // active recipient or reactivate an unsubscribed one.
    const [row] = await this.database.db
      .insert(statusSubscribers)
      .values({
        email: input.email,
        confirmTokenHash: input.confirmTokenHash,
        confirmExpiresAt: input.confirmExpiresAt,
        confirmedAt: null,
        unsubscribeTokenHash: null,
        unsubscribedAt: null,
      })
      .onConflictDoUpdate({
        target: statusSubscribers.email,
        set: {
          confirmTokenHash: input.confirmTokenHash,
          confirmExpiresAt: input.confirmExpiresAt,
        },
      })
      .returning();
    if (!row) throw new Error('status_subscribers upsert returned no row');
    return toRow(row);
  }

  async findByConfirmTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    const [row] = await this.database.db
      .select()
      .from(statusSubscribers)
      .where(eq(statusSubscribers.confirmTokenHash, hash))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async findByUnsubscribeTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    const [row] = await this.database.db
      .select()
      .from(statusSubscribers)
      .where(eq(statusSubscribers.unsubscribeTokenHash, hash))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async markConfirmed(input: {
    id: string;
    expectedConfirmTokenHash: string;
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow | null> {
    const [row] = await this.database.db
      .update(statusSubscribers)
      .set({
        confirmedAt: input.confirmedAt,
        confirmTokenHash: null,
        confirmExpiresAt: null,
        unsubscribeTokenHash: input.unsubscribeTokenHash,
        unsubscribedAt: null,
      })
      .where(
        and(
          eq(statusSubscribers.id, input.id),
          eq(statusSubscribers.confirmTokenHash, input.expectedConfirmTokenHash),
        ),
      )
      .returning();
    return row ? toRow(row) : null;
  }

  async markUnsubscribed(input: {
    id: string;
    expectedUnsubscribeTokenHash: string | null;
    unsubscribedAt: Date;
  }): Promise<StatusSubscriberRow | null> {
    const predicate =
      input.expectedUnsubscribeTokenHash === null
        ? eq(statusSubscribers.id, input.id)
        : and(
            eq(statusSubscribers.id, input.id),
            eq(statusSubscribers.unsubscribeTokenHash, input.expectedUnsubscribeTokenHash),
          );
    const [row] = await this.database.db
      .update(statusSubscribers)
      .set({ unsubscribedAt: input.unsubscribedAt })
      .where(predicate)
      .returning();
    return row ? toRow(row) : null;
  }

  async rotateUnsubscribeTokenHash(input: { id: string; hash: string }): Promise<void> {
    await this.database.db
      .update(statusSubscribers)
      .set({ unsubscribeTokenHash: input.hash })
      .where(eq(statusSubscribers.id, input.id));
  }

  async listConfirmed(): Promise<StatusSubscriberRow[]> {
    const rows = await this.database.db
      .select()
      .from(statusSubscribers)
      .where(
        and(isNotNull(statusSubscribers.confirmedAt), isNull(statusSubscribers.unsubscribedAt)),
      );
    return rows.map(toRow);
  }

  async listAll(opts: { limit: number; offset: number }): Promise<StatusSubscriberRow[]> {
    const rows = await this.database.db
      .select()
      .from(statusSubscribers)
      .orderBy(desc(statusSubscribers.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);
    return rows.map(toRow);
  }

  async getById(id: string): Promise<StatusSubscriberRow | null> {
    const [row] = await this.database.db
      .select()
      .from(statusSubscribers)
      .where(eq(statusSubscribers.id, id))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async listPurgeCandidates(cutoff: Date): Promise<StatusSubscriberRow[]> {
    const rows = await this.database.db
      .select()
      .from(statusSubscribers)
      .where(and(lt(statusSubscribers.unsubscribedAt, cutoff), isNotNull(statusSubscribers.email)));
    return rows.map(toRow);
  }

  async purgeEmails(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.database.db
      .update(statusSubscribers)
      .set({
        email: null,
        // Clear the tokens too — they're all derivative of the email.
        confirmTokenHash: null,
        confirmExpiresAt: null,
        unsubscribeTokenHash: null,
      })
      .where(inArray(statusSubscribers.id, [...ids]))
      .returning({ id: statusSubscribers.id });
    return result.length;
  }
}
