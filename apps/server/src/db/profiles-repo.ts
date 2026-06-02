// Drizzle-backed ProfilesRepo (V-081).

import { and, count, desc, eq, lt, or } from 'drizzle-orm';
import type {
  ListProfilesArgs,
  ListProfilesPage,
  NewProfileInput,
  ProfileRecord,
  ProfileUpdates,
  ProfilesRepo,
} from '../services/profiles.js';
import type { Database } from './client.js';
import { accounts, profiles } from './schema.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

function toRecord(r: typeof profiles.$inferSelect): ProfileRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    archetype: r.archetype,
    description: r.description,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class DrizzleProfilesRepo implements ProfilesRepo {
  constructor(private readonly database: Database) {}

  async insert(input: NewProfileInput): Promise<ProfileRecord> {
    const [row] = await this.database.db
      .insert(profiles)
      .values({
        accountId: input.accountId,
        name: input.name,
        archetype: input.archetype,
        description: input.description,
      })
      .returning();
    if (!row) throw new Error('insert profile: no row returned');
    return toRecord(row);
  }

  async countByAccount(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(profiles)
      .where(eq(profiles.accountId, accountId));
    return row?.n ?? 0;
  }

  // V-714 — atomic tier-limit check + insert. The plain count-then-insert in
  // the service is a TOCTOU: N concurrent creates all read count < limit, all
  // insert, and the per-tier profile cap (free = 1) is exceeded. Here the
  // count + insert run inside ONE transaction under a `FOR UPDATE` lock on the
  // owning accounts row, so concurrent creates for the same account serialize
  // — the loser reads the post-insert count and is refused. Mirrors
  // stripe-webhooks-repo.setAccountTier's lock idiom; locks the accounts row
  // FIRST (consistent ordering with every other account-row-locking txn →
  // deadlock-safe; nothing locks profiles-then-accounts). `limit === null` is
  // an unmetered tier → no lock/count needed, just insert.
  async insertWithLimit(
    input: NewProfileInput,
    limit: number | null,
  ): Promise<{ record: ProfileRecord } | { limitExceeded: true; current: number }> {
    return this.database.db.transaction(async (tx) => {
      if (limit !== null) {
        await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, input.accountId))
          .for('update')
          .limit(1);
        const [c] = await tx
          .select({ n: count() })
          .from(profiles)
          .where(eq(profiles.accountId, input.accountId));
        const current = c?.n ?? 0;
        if (current >= limit) {
          return { limitExceeded: true as const, current };
        }
      }
      const [row] = await tx
        .insert(profiles)
        .values({
          accountId: input.accountId,
          name: input.name,
          archetype: input.archetype,
          description: input.description,
        })
        .returning();
      if (!row) throw new Error('insertWithLimit profile: no row returned');
      return { record: toRecord(row) };
    });
  }

  async findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findByAccountAndName(args: {
    accountId: string;
    name: string;
  }): Promise<ProfileRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.accountId, args.accountId), eq(profiles.name, args.name)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(args: ListProfilesArgs): Promise<ListProfilesPage> {
    const limit = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE);

    let cursorWhere;
    if (args.cursor !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: profiles.createdAt, id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.id, args.cursor), eq(profiles.accountId, args.accountId)))
        .limit(1);
      if (cursorRow !== undefined) {
        cursorWhere = or(
          lt(profiles.createdAt, cursorRow.createdAt),
          and(eq(profiles.createdAt, cursorRow.createdAt), lt(profiles.id, cursorRow.id)),
        );
      }
    }

    const rows = await this.database.db
      .select()
      .from(profiles)
      .where(
        cursorWhere !== undefined
          ? and(eq(profiles.accountId, args.accountId), cursorWhere)
          : eq(profiles.accountId, args.accountId),
      )
      .orderBy(desc(profiles.createdAt), desc(profiles.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toRecord);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return { data, hasMore, nextCursor };
  }

  async update(args: {
    id: string;
    accountId: string;
    updates: ProfileUpdates;
  }): Promise<ProfileRecord> {
    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (args.updates.name !== undefined) sets.name = args.updates.name;
    if (args.updates.description !== undefined) sets.description = args.updates.description;

    const [row] = await this.database.db
      .update(profiles)
      .set(sets)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId)))
      .returning();
    if (!row) throw new Error('update profile: no row returned');
    return toRecord(row);
  }

  async delete(args: { id: string; accountId: string }): Promise<boolean> {
    const result = await this.database.db
      .delete(profiles)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId)))
      .returning({ id: profiles.id });
    return result.length > 0;
  }

  async touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    await this.database.db
      .update(profiles)
      .set({ lastUsedAt: args.at })
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId)));
  }
}
