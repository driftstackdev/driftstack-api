// V-295c3 — in-memory StatusSubscribersRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  StatusSubscriberRow,
  StatusSubscribersRepo,
} from '../../../src/services/status-subscribers.js';

/**
 * V-1251 — every read hands back a SNAPSHOT, never the stored object.
 *
 * This double keeps rows in an array and mutates them in place (`row.confirmedAt = …`), and its
 * reads used to return those very objects. So a row fetched by a caller kept changing underneath
 * it: read a subscriber, unsubscribe them, and the value read BEFORE the unsubscribe had silently
 * become the value after. Postgres cannot do that — a SELECT is a point-in-time copy, and a later
 * UPDATE does not reach into a result the caller is already holding.
 *
 * The damage is not a crash, it is a vacuous test. Any before/after comparison against this double
 * reads "nothing changed" no matter what the code under test did, because `before` and `after` are
 * the same object. That arm then passes forever and asserts nothing — the exact failure this
 * campaign keeps finding by mutation, arrived at here from the fixture side.
 *
 * Shallow is the right depth, and deliberately so: the columns are scalars and Dates, nothing
 * mutates a Date in place, and a deep clone would imply a guarantee the repo does not make either.
 */
function snap(row: StatusSubscriberRow): StatusSubscriberRow;
function snap(row: StatusSubscriberRow | undefined | null): StatusSubscriberRow | null;
function snap(row: StatusSubscriberRow | undefined | null): StatusSubscriberRow | null {
  return row ? { ...row } : null;
}

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
      return snap(existing);
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
    return snap(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findByConfirmTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    return snap(this.rows.find((r) => r.confirmTokenHash === hash));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findByUnsubscribeTokenHash(hash: string): Promise<StatusSubscriberRow | null> {
    return snap(this.rows.find((r) => r.unsubscribeTokenHash === hash));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markConfirmed(input: {
    id: string;
    expectedConfirmTokenHash: string;
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.id === input.id && candidate.confirmTokenHash === input.expectedConfirmTokenHash,
    );
    if (!row) return null;
    row.confirmedAt = input.confirmedAt;
    row.confirmTokenHash = null;
    row.confirmExpiresAt = null;
    row.unsubscribeTokenHash = input.unsubscribeTokenHash;
    row.unsubscribedAt = null;
    return snap(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markUnsubscribed(input: {
    id: string;
    expectedUnsubscribeTokenHash: string | null;
    unsubscribedAt: Date;
  }): Promise<StatusSubscriberRow | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.id === input.id &&
        (input.expectedUnsubscribeTokenHash === null ||
          candidate.unsubscribeTokenHash === input.expectedUnsubscribeTokenHash),
    );
    if (!row) return null;
    row.unsubscribedAt = input.unsubscribedAt;
    return snap(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rotateUnsubscribeTokenHash(input: { id: string; hash: string }): Promise<void> {
    // V-1250 — a missing row is a SILENT NO-OP, mirroring DrizzleStatusSubscribersRepo,
    // whose rotate is a plain `UPDATE … WHERE id = $1`: no rows matched, nothing thrown.
    // This used to throw, so a caller that production lets through quietly would have
    // failed loudly here and nowhere else — the double being stricter than the thing it
    // models is the same parity defect as it being laxer, and harder to notice because
    // it only shows up as a test that fails for a reason production would never produce.
    const row = this.rows.find((r) => r.id === input.id);
    if (!row) return;
    row.unsubscribeTokenHash = input.hash;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listConfirmed(): Promise<StatusSubscriberRow[]> {
    return this.rows
      .filter((r) => r.confirmedAt !== null && r.unsubscribedAt === null)
      .map((r) => snap(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listAll(opts: { limit: number; offset: number }): Promise<StatusSubscriberRow[]> {
    return [...this.rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(opts.offset, opts.offset + opts.limit)
      .map((r) => snap(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getById(id: string): Promise<StatusSubscriberRow | null> {
    return snap(this.rows.find((r) => r.id === id));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listPurgeCandidates(cutoff: Date): Promise<StatusSubscriberRow[]> {
    return this.rows
      .filter((r) => r.unsubscribedAt !== null && r.unsubscribedAt < cutoff && r.email !== null)
      .map((r) => snap(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async purgeEmails(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const row = this.rows.find((r) => r.id === id);
      if (row && row.email !== null) {
        row.email = null;
        row.confirmTokenHash = null;
        row.confirmExpiresAt = null;
        row.unsubscribeTokenHash = null;
        n++;
      }
    }
    return n;
  }

  /** Test-only — exposes raw rows for assertions. */
  /**
   * Test seam — the LIVE rows, deliberately not snapshotted.
   *
   * V-1251 snapshotted this too at first, and that was overreach: `getAll` is not on
   * `StatusSubscribersRepo`, so it models nothing in production, and fixtures use it to ARRANGE
   * state (`getAll()[0]!.unsubscribedAt = …` in the tombstone tests). Handing back copies sent
   * those writes into a throwaway object and the store never changed — two tests went red for a
   * reason that had nothing to do with the parity being fixed.
   *
   * The snapshot rule applies to the INTERFACE, which is what production has to agree with. This
   * is a hatch into the fixture's own state and is allowed to behave like one.
   */
  getAll(): readonly StatusSubscriberRow[] {
    return this.rows;
  }
}
