// V-994 — disabling MFA for one account must not delete anyone else's, on real Postgres.
//
// Fourth of the tenant-scope sweep, and the sibling `db-mfa-recovery-codes-tenant-scope`
// did not cover: that file guards the READ path (`listUnusedRecoveryCodes`), and says
// so. `deleteForAccount` is the WRITE path, and nothing drove it.
//
// `MfaService.disable` calls `repo.deleteForAccount(accountId)`, which deletes from
// `account_mfa_recovery_codes` and `account_mfa` inside one transaction under the
// per-account advisory lock. Both statements carry `.where(eq(…accountId, accountId))`,
// and those two predicates are the entire boundary: without them, one customer turning
// MFA off removes every customer's second factor and every unused recovery code in the
// table. The accounts stay authenticable by password alone and nobody is told.
//
// **Measured before writing this, which is why it exists.** Deleting BOTH predicates
// left green:
//
//   • 73 tests over the four MFA unit guards, including
//     `db-mfa-repo-content-parity`, whose `deleteForAccount` arm pins
//     `.delete(accountMfaRecoveryCodes)` and `await tx.delete(accountMfa)` — the
//     delete CALLS, not the WHERE clauses. The very next arm in that same file pins
//     `listUnusedRecoveryCodes`'s whole body including its account predicate, so the
//     omission is specific rather than a house style.
//   • 67 tests over the ten MFA integration files against real Postgres, including
//     `db-mfa-recovery-codes-tenant-scope-drizzle` itself.
//
// The method was also cold in the per-function coverage of `src/db` — one of 19
// account-scoped repo functions whose SQL no integration test executes — which is how
// it was found. The source is correct today; what was missing is anything that would
// notice if it stopped being.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const CIPHER = { ciphertext: 'ct', iv: 'iv', tag: 'tag' } as const;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM account_mfa LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_mfa_recovery_codes WHERE account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM account_mfa WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleMfaRepo.deleteForAccount tenant scoping (real Postgres)',
  () => {
    it("CRITICAL deleteForAccount removes the asking account's MFA enrollment and recovery codes, and leaves every other account's untouched. Both DELETEs carry the account predicate and neither is pinned by anything executable — dropping them turns one customer disabling MFA into a silent second-factor wipe across the whole table.", async () => {
      if (!dbReachable || !client) {
        // Quiet skip locally, hard failure in CI. A vacuous pass here would report
        // an MFA boundary as proven when nothing ran.
        if (process.env.CI) {
          throw new Error(
            'real-PG MFA delete-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);

      for (const [id, who] of [
        [owner, 'owner'],
        [stranger, 'stranger'],
      ] as const) {
        await client`INSERT INTO accounts (id, email) VALUES (${id}, ${`mfa-del-${who}-${id}@test.local`})`;
        await client`
          INSERT INTO account_mfa (account_id, totp_secret_ciphertext, totp_secret_iv, totp_secret_tag, enrolled_at)
          VALUES (${id}, ${CIPHER.ciphertext}, ${CIPHER.iv}, ${CIPHER.tag}, now())`;
        await client`
          INSERT INTO account_mfa_recovery_codes (account_id, code_hash)
          VALUES (${id}, ${`hash-${who}-${id}`})`;
      }

      // Captured after the guard above: the narrowing does not reach into a
      // closure, and the counts are read through the raw client rather than the
      // repo so the assertion cannot inherit the bug it is checking for.
      const sql = client;
      const countFor = async (id: string): Promise<{ enrol: number; codes: number }> => {
        const [e] = await sql`SELECT count(*)::int AS n FROM account_mfa WHERE account_id = ${id}`;
        const [c] =
          await sql`SELECT count(*)::int AS n FROM account_mfa_recovery_codes WHERE account_id = ${id}`;
        return { enrol: (e?.n as number) ?? 0, codes: (c?.n as number) ?? 0 };
      };

      // Positive control first: without it every assertion below would also pass
      // against a seed that never landed.
      expect(await countFor(owner), 'the owner was seeded with MFA').toEqual({
        enrol: 1,
        codes: 1,
      });
      expect(await countFor(stranger), 'the stranger was seeded with MFA').toEqual({
        enrol: 1,
        codes: 1,
      });

      await repo.deleteForAccount(owner);

      // It did the job it is for.
      expect(await countFor(owner), "the owner's MFA enrollment and codes are gone").toEqual({
        enrol: 0,
        codes: 0,
      });

      // The boundary — this is the arm the missing predicates would red.
      expect(
        await countFor(stranger),
        "another account's MFA enrollment and recovery codes must survive a neighbour disabling MFA",
      ).toEqual({ enrol: 1, codes: 1 });
    });
  },
);
