// Concurrent transfers of the SAME profile to DIFFERENT recipients (real Postgres).
//
// The defect this pins was reproduced by forcing the interleave: transferProfile
// used to `insertWithLimit(recipient)` and then `delete(source)`, discarding the
// delete's boolean. Two transfers of one profile to two different recipients take
// DIFFERENT account-row locks, so nothing serialised them — both inserted, both
// "deleted" (the second matching zero rows), and one profile became TWO owned by
// two accounts, with both callers told they had succeeded.
//
//     outcomes = fulfilled, fulfilled
//     copies_in_recipients = 2
//     source_remaining = 1 (soft-deleted)
//
// The fix makes the source retire a CLAIM inside the same transaction as the
// insert: the loser matches zero rows and returns before writing anything. This
// test drives the two transfers on SEPARATE connections so Postgres, not the
// event loop, decides the order.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let a: ReturnType<typeof postgres> | null = null;
let b: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

function repoOn(client: ReturnType<typeof postgres>): DrizzleProfilesRepo {
  return new DrizzleProfilesRepo({
    client,
    db: drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>,
    close: async () => {},
  });
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  a = postgres(DB_URL, { max: 1 });
  b = postgres(DB_URL, { max: 1 });
  try {
    await a`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    await a.end({ timeout: 1 }).catch(() => {});
    await b.end({ timeout: 1 }).catch(() => {});
    a = null;
    b = null;
  }
});

afterAll(async () => {
  if (a) {
    for (const accountId of seeded) {
      await a`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await a`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await a.end({ timeout: 5 });
  }
  if (b) await b.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'concurrent profile transfers to different recipients (real Postgres)',
  () => {
    it('CRITICAL one profile cannot become two: exactly one transfer wins, the loser writes nothing', async () => {
      if (!a || !b) {
        if (process.env.CI) {
          throw new Error(
            'real-PG transfer-concurrency test: database unreachable/unmigrated in CI — a vacuous pass is forbidden',
          );
        }
        return;
      }
      const src = randomUUID();
      const rcpt1 = randomUUID();
      const rcpt2 = randomUUID();
      seeded.push(src, rcpt1, rcpt2);
      for (const id of [src, rcpt1, rcpt2]) {
        await a`INSERT INTO accounts (id, email) VALUES (${id}, ${`xfer-${id}@test.local`})`;
      }
      const profileId = randomUUID();
      await a`INSERT INTO profiles (id, account_id, name, archetype)
              VALUES (${profileId}, ${src}, ${'to-transfer'}, ${'default'})`;

      // Two transfers of the SAME source to DIFFERENT recipients — the case that
      // takes two different account-row locks and therefore used to interleave.
      const [r1, r2] = await Promise.all([
        repoOn(a).transferAtomic({
          source: { id: profileId, accountId: src },
          insert: {
            id: randomUUID(),
            accountId: rcpt1,
            name: 'copy-1',
            archetype: 'default',
            description: null,
          },
          limit: null,
        }),
        repoOn(b).transferAtomic({
          source: { id: profileId, accountId: src },
          insert: {
            id: randomUUID(),
            accountId: rcpt2,
            name: 'copy-2',
            archetype: 'default',
            description: null,
          },
          limit: null,
        }),
      ]);

      const won = [r1, r2].filter((r) => 'record' in r);
      const lost = [r1, r2].filter((r) => 'sourceAlreadyRetired' in r);
      expect(won, 'exactly one transfer may win').toHaveLength(1);
      expect(lost, 'the other must report the source already retired').toHaveLength(1);

      // The outcome that matters: one profile, not two.
      const copies = await a`SELECT account_id FROM profiles
                             WHERE account_id IN (${rcpt1}, ${rcpt2}) AND deleted_at IS NULL`;
      expect(copies.length, 'the profile exists in exactly one recipient account').toBe(1);

      // …and the source left its account exactly once.
      const source = await a`SELECT deleted_at FROM profiles WHERE id = ${profileId}`;
      expect(source.length).toBe(1);
      expect(source[0]?.['deleted_at'], 'the source is retired').not.toBeNull();
    });
  },
);
