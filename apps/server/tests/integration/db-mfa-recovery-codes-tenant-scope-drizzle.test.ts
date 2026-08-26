// Recovery-code lookup must never see another account's codes, on real Postgres.
//
// Third of the tenant-scope sweep, and the one with the sharpest consequence.
//
// `MfaService.verify` resolves a submitted recovery code like this:
//
//   const candidates = await this.repo.listUnusedRecoveryCodes(args.accountId);
//   for (const c of candidates) { if (await verifyApiKey(normalized, c.codeHash)) {
//     const consumed = await this.repo.markRecoveryCodeUsed(c.id, new Date());
//
// Two things follow from that shape:
//
//   1. The candidate SET is the entire authorisation boundary. If
//      `listUnusedRecoveryCodes` stopped scoping by account, the loop would
//      scrypt-verify the submitted code against EVERY account's unused codes —
//      turning "guess this account's recovery code" into "guess any live recovery
//      code in the system", which is a different problem by orders of magnitude.
//   2. `markRecoveryCodeUsed(id)` is deliberately unscoped — it consumes by id
//      alone, atomically, so a code can never be spent twice. That is SAFE only
//      because the id it receives came from the scoped query above. The unscoped
//      consume inherits its safety from this predicate; it does not have its own.
//
// Measured before writing this: neutralising the account predicate in
// `listUnusedRecoveryCodes` leaves the MFA credential-issuance and
// enrollment-session-authority integration tests green (12 passed). The sibling
// predicate in `findByAccount` IS covered — one red — so this is a specific hole,
// not an untested module.
//
// The used-filter is pinned in the same arm because it lives in the same WHERE
// and carries the single-use property: a spent code must leave the candidate set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

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
    await client`SELECT 1 FROM account_mfa_recovery_codes LIMIT 0`;
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
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleMfaRepo recovery-code tenant scoping (real Postgres)',
  () => {
    it("CRITICAL listUnusedRecoveryCodes returns only the asking account's unused codes. The candidate set IS the authorisation boundary for recovery-code login, and the atomic consume that follows is unscoped by id — it inherits its safety from this predicate and has none of its own.", async () => {
      if (!dbReachable || !client) {
        // Quiet skip locally, hard failure in CI. A vacuous pass here would
        // report an MFA boundary as proven when nothing ran.
        if (process.env.CI) {
          throw new Error(
            'real-PG MFA tenant-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
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
        await client`INSERT INTO accounts (id, email) VALUES (${id}, ${`mfa-${who}-${id}@test.local`})`;
      }

      const [mineUnused] = await client`
        INSERT INTO account_mfa_recovery_codes (account_id, code_hash)
        VALUES (${owner}, ${`hash-owner-unused-${owner}`}) RETURNING id`;
      const [mineSpent] = await client`
        INSERT INTO account_mfa_recovery_codes (account_id, code_hash, used_at)
        VALUES (${owner}, ${`hash-owner-spent-${owner}`}, now()) RETURNING id`;
      const [theirs] = await client`
        INSERT INTO account_mfa_recovery_codes (account_id, code_hash)
        VALUES (${stranger}, ${`hash-stranger-${stranger}`}) RETURNING id`;

      const candidates = await repo.listUnusedRecoveryCodes(owner);
      const ids = candidates.map((c) => c.id);

      // Positive control first: without it, every assertion below would also pass
      // on a query that returned nothing at all.
      expect(ids, "the owner's own unused code must be a candidate").toContain(
        mineUnused?.id as string,
      );

      // The boundary.
      expect(ids, "another account's code must never be a login candidate").not.toContain(
        theirs?.id as string,
      );

      // The single-use filter, which shares the same WHERE clause.
      expect(ids, 'a spent code must leave the candidate set').not.toContain(
        mineSpent?.id as string,
      );

      // Exact, not a superset — a candidate set that quietly grew would be the
      // failure this file exists to catch.
      expect(ids).toEqual([mineUnused?.id as string]);

      // And the stranger sees exactly their own, so the arms above are a boundary
      // rather than a query that happens to return one row for everyone.
      const theirCandidates = await repo.listUnusedRecoveryCodes(stranger);
      expect(theirCandidates.map((c) => c.id)).toEqual([theirs?.id as string]);
    });

    it("CRITICAL a recovery code can be spent exactly once, on real Postgres — the atomic consume this file's own premise rests on, which until now had only source-text witnesses", async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG MFA single-use test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`mfa-single-use-${accountId}@test.local`})`;

      // ── Sequential replay: the stolen-code case ──────────────────────
      const [replayRow] = await client`
        INSERT INTO account_mfa_recovery_codes (account_id, code_hash)
        VALUES (${accountId}, ${`hash-replay-${accountId}`}) RETURNING id`;
      const replayId = replayRow?.id as string;

      // Positive control first: a method that always returned false would
      // satisfy the refusal below while proving nothing at all.
      expect(
        await repo.markRecoveryCodeUsed(replayId, new Date()),
        'the FIRST spend of an unused code must succeed — without this the refusal below is vacuous',
      ).toBe(true);
      expect(
        await repo.markRecoveryCodeUsed(replayId, new Date()),
        'a recovery code was spent TWICE — a used code stays valid forever, so one leaked code is permanent MFA bypass',
      ).toBe(false);

      // ── Concurrent double-spend: the case no text pin can see ────────
      // The arm above fails when isNull(usedAt) is dropped. This one also fails
      // when the consume is rewritten as a read-then-write that still READS as
      // atomic — the shape a source-text pin cannot distinguish.
      //
      // On its OWN pool: the file's shared client is max:1, which would quietly
      // serialise these eight calls and turn the race into a sequential replay.
      const racePool = postgres(DB_URL, { max: 8 });
      try {
        const raceDb = drizzle(racePool) as unknown as ReturnType<typeof drizzle<typeof schema>>;
        const raceRepo = new DrizzleMfaRepo({
          client: racePool,
          db: raceDb,
          close: async () => {},
        });
        const [raceRow] = await client`
          INSERT INTO account_mfa_recovery_codes (account_id, code_hash)
          VALUES (${accountId}, ${`hash-race-${accountId}`}) RETURNING id`;
        const raceId = raceRow?.id as string;
        const at = new Date();
        const spent = await Promise.all(
          Array.from({ length: 8 }, () => raceRepo.markRecoveryCodeUsed(raceId, at)),
        );
        expect(
          spent.filter(Boolean).length,
          'exactly one concurrent caller may spend a recovery code; more than one is an MFA bypass',
        ).toBe(1);
      } finally {
        await racePool.end({ timeout: 5 });
      }
    });
  },
);
