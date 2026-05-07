// V-295c3 — Drizzle-backed StatusSubscribersRepo.

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
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
    // INSERT ... ON CONFLICT (email) DO UPDATE — re-subscribe path
    // resets confirmation state. Drizzle's onConflictDoUpdate covers
    // this without a separate select.
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
          // Reset confirmation state on re-subscribe so a previously
          // unsubscribed user starts a fresh double-opt-in.
          confirmedAt: null,
          unsubscribeTokenHash: null,
          unsubscribedAt: null,
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
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow> {
    const [row] = await this.database.db
      .update(statusSubscribers)
      .set({
        confirmedAt: input.confirmedAt,
        confirmTokenHash: null,
        confirmExpiresAt: null,
        unsubscribeTokenHash: input.unsubscribeTokenHash,
        unsubscribedAt: null,
      })
      .where(eq(statusSubscribers.id, input.id))
      .returning();
    if (!row) throw new Error('status_subscribers markConfirmed returned no row');
    return toRow(row);
  }

  async markUnsubscribed(input: {
    id: string;
    unsubscribedAt: Date;
  }): Promise<StatusSubscriberRow> {
    const [row] = await this.database.db
      .update(statusSubscribers)
      .set({ unsubscribedAt: input.unsubscribedAt })
      .where(eq(statusSubscribers.id, input.id))
      .returning();
    if (!row) throw new Error('status_subscribers markUnsubscribed returned no row');
    return toRow(row);
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
}
