// V-295c3 — in-memory StatusSubscribersRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  StatusSubscriberRow,
  StatusSubscribersRepo,
} from '../../../src/services/status-subscribers.js';

export class InMemoryStatusSubscribersRepo implements StatusSubscribersRepo {
  private readonly rows: StatusSubscriberRow[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertPending(input: {
    email: string;
    confirmTokenHash: string;
    confirmExpiresAt: Date;
  }): Promise<StatusSubscriberRow> {
    const existing = this.rows.find((r) => r.email === input.email);
    if (existing) {
      existing.confirmTokenHash = input.confirmTokenHash;
      existing.confirmExpiresAt = input.confirmExpiresAt;
      existing.confirmedAt = null;
      existing.unsubscribeTokenHash = null;
      existing.unsubscribedAt = null;
      return existing;
    }
    const row: StatusSubscriberRow = {
      id: randomUUID(),
      email: input.email,
      confirmTokenHash: input.confirmTokenHash,
      confirmExpiresAt: input.confirmExpiresAt,
      confirmedAt: null,
      unsubscribeTokenHash: null,
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findByConfirmTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    return this.rows.find((r) => r.confirmTokenHash === hash) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findByUnsubscribeTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    return this.rows.find((r) => r.unsubscribeTokenHash === hash) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markConfirmed(input: {
    id: string;
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow> {
    const row = this.rows.find((r) => r.id === input.id);
    if (!row) throw new Error(`status_subscribers ${input.id} not found`);
    row.confirmedAt = input.confirmedAt;
    row.confirmTokenHash = null;
    row.confirmExpiresAt = null;
    row.unsubscribeTokenHash = input.unsubscribeTokenHash;
    row.unsubscribedAt = null;
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markUnsubscribed(input: {
    id: string;
    unsubscribedAt: Date;
  }): Promise<StatusSubscriberRow> {
    const row = this.rows.find((r) => r.id === input.id);
    if (!row) throw new Error(`status_subscribers ${input.id} not found`);
    row.unsubscribedAt = input.unsubscribedAt;
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rotateUnsubscribeTokenHash(input: { id: string; hash: string }): Promise<void> {
    const row = this.rows.find((r) => r.id === input.id);
    if (!row) throw new Error(`status_subscribers ${input.id} not found`);
    row.unsubscribeTokenHash = input.hash;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listConfirmed(): Promise<StatusSubscriberRow[]> {
    return this.rows.filter((r) => r.confirmedAt !== null && r.unsubscribedAt === null);
  }

  /** Test-only — exposes raw rows for assertions. */
  getAll(): readonly StatusSubscriberRow[] {
    return this.rows;
  }
}
