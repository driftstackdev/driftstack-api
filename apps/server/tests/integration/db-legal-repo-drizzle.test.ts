// Drizzle-backed integration test for DrizzleLegalRepo against a REAL Postgres.
//
// Why this exists: the repo had ZERO line coverage (item 5e), and its read path
// is RAW SQL passed through drizzle's `execute()` —
//
//     SELECT DISTINCT ON (document_key) … ORDER BY document_key, accepted_at DESC, id DESC
//
// A raw string is not type-checked against the schema. A renamed column or a
// mistyped alias compiles, passes lint, and fails at runtime; nothing under
// vitest had ever executed it. That is the strongest argument for an integration
// test there is, and it applies to exactly one other repo in this directory.
//
// What the rows mean matters too. `legal_acceptances` is how the business proves
// a customer accepted a specific version of a specific document, with the
// content hash of what they were shown. Returning the wrong row is not a display
// bug: it is a claim about consent that the record does not support.
//
// Shared-database discipline, as in db-admin-accounts-repo-drizzle: every arm is
// scoped to accounts this file seeded. Nothing counts rows globally, because
// every other db-* file is inserting into the same tables concurrently.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine migrated; this always runs.
//   - Local: skips unless DATABASE_URL is set.
//
// MUTATION-PROVED against legal-repo.ts — control 7/7 green, each mutation
// applied alone against a scratchpad snapshot and reverted:
//
//   the `id DESC` tiebreaker dropped                            1 red
//   the OLDEST acceptance wins instead of the newest            2 red
//   the account predicate dropped                               3 red
//   DISTINCT ON removed (all history returned, not the latest)  2 red
//
// Ledger written 2026-08-15. The proof was run when this file was written, but
// the result went to the agent bus instead of into the file, so nothing in the
// repository evidenced it — and an unrecorded proof is indistinguishable from
// an unperformed one to the next reader. Re-measured rather than transcribed
// from memory, which would have reintroduced exactly that problem.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleLegalRepo } from '../../src/db/legal-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleLegalRepo | null = null;
const seededAccountIds: string[] = [];

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`legalrepo-${id.slice(0, 8)}@example.test`}, ${'Legal Fixture'},
            'free'::account_tier, 'active'::account_status, now(), now())`;
  seededAccountIds.push(id);
  return id;
}

/** Insert an acceptance with a CALLER-CHOSEN id, so id order can be controlled. */
async function seedAcceptanceWithId(
  id: string,
  accountId: string,
  documentKey: string,
  version: string,
  acceptedAt: Date,
): Promise<string> {
  if (!client) throw new Error('no client');
  await client`
    INSERT INTO legal_acceptances
      (id, account_id, document_key, version, content_hash, accepted_at)
    VALUES (${id}, ${accountId}, ${documentKey}, ${version},
            ${`hash-${version}`}, ${acceptedAt.toISOString()}::timestamptz)`;
  return id;
}

/** Insert an acceptance with an explicit accepted_at, bypassing the repo. */
async function seedAcceptance(
  accountId: string,
  documentKey: string,
  version: string,
  acceptedAt: Date,
): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO legal_acceptances
      (id, account_id, document_key, version, content_hash, accepted_at)
    VALUES (${id}, ${accountId}, ${documentKey}, ${version},
            ${`hash-${version}`}, ${acceptedAt.toISOString()}::timestamptz)`;
  return id;
}

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
    await client`SELECT 1 FROM legal_acceptances LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleLegalRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    // legal_acceptances.account_id cascades, so deleting the accounts is enough.
    for (const id of seededAccountIds) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleLegalRepo (raw DISTINCT ON against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and legal_acceptances present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL recordAcceptance persists the row and returns what it wrote. The content hash is the evidence of WHAT the customer was shown; a returned record that does not match the stored one would let the acceptance response disagree with the audit trail.', async () => {
      if (!dbReachable || !repo || !client) return;
      const accountId = await seedAccount();
      const returned = await repo.recordAcceptance({
        accountId,
        documentKey: 'tos',
        version: '1.0.0',
        contentHash: 'abc123',
        acceptedFromIp: '203.0.113.7',
        acceptedUserAgent: 'fixture/1.0',
      });

      expect(returned.documentKey, 'document key round-trips').toBe('tos');
      expect(returned.contentHash, 'content hash round-trips').toBe('abc123');
      expect(returned.acceptedFromIp, 'forensic ip round-trips').toBe('203.0.113.7');

      const [stored] = await client<{ content_hash: string; version: string }[]>`
        SELECT content_hash, version FROM legal_acceptances WHERE id = ${returned.id}`;
      expect(stored?.content_hash, 'and matches what is stored').toBe('abc123');
      expect(stored?.version, 'version stored').toBe('1.0.0');
    });

    it('CRITICAL the raw DISTINCT ON returns the LATEST acceptance per document, not the latest overall. This is the compliance claim: with tos accepted twice and privacy once, reporting the newest single row would say the customer never accepted privacy.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      const base = Date.now();
      await seedAcceptance(accountId, 'tos', '1.0.0', new Date(base - 3000));
      await seedAcceptance(accountId, 'privacy', '1.0.0', new Date(base - 2000));
      await seedAcceptance(accountId, 'tos', '2.0.0', new Date(base - 1000));

      const latest = await repo.latestAcceptancesForAccount(accountId);
      expect([...latest.keys()].sort(), 'one entry per document key').toEqual(['privacy', 'tos']);
      expect(latest.get('tos')?.version, 'tos resolves to the newer acceptance').toBe('2.0.0');
      expect(latest.get('privacy')?.version, 'privacy survives despite being older').toBe('1.0.0');
    });

    it('CRITICAL a tie on accepted_at resolves deterministically by id DESC. accepted_at is not unique — two acceptances written in one request share it — and without the tiebreaker the row returned would depend on Postgres plan order, so the same account could report different accepted versions on successive reads.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      const tie = new Date();

      // Insertion order is made to DISAGREE with id order on purpose. Without
      // the `id DESC` tiebreaker Postgres is free to return either tied row and
      // in practice returns the one it scans first, which is the one inserted
      // first — so seeding the LOWER id first makes the two implementations give
      // different answers. Seeding in random order does not: the first version
      // of this arm passed with the tiebreaker removed, which is a test that
      // asserts nothing.
      const [lower, higher] = [randomUUID(), randomUUID()].sort();
      await seedAcceptanceWithId(lower!, accountId, 'dpa', 'lower-id', tie);
      await seedAcceptanceWithId(higher!, accountId, 'dpa', 'higher-id', tie);

      for (let i = 0; i < 3; i += 1) {
        const latest = await repo.latestAcceptancesForAccount(accountId);
        expect(
          latest.get('dpa')?.version,
          `read ${String(i)} picks the higher id despite it being inserted last`,
        ).toBe('higher-id');
      }
    });

    it("CRITICAL one account's acceptances never appear in another's. The WHERE is the only thing scoping this query, and a legal-acceptance record attributed to the wrong customer is a false consent claim in both directions.", async () => {
      if (!dbReachable || !repo) return;
      const mine = await seedAccount();
      const theirs = await seedAccount();
      await seedAcceptance(theirs, 'aup', '9.9.9', new Date());

      const latest = await repo.latestAcceptancesForAccount(mine);
      expect(latest.has('aup'), "the other account's acceptance does not leak").toBe(false);

      const theirLatest = await repo.latestAcceptancesForAccount(theirs);
      expect(theirLatest.get('aup')?.version, 'and is visible to its own account').toBe('9.9.9');
    });

    it('CRITICAL an account with no acceptances returns an empty map rather than throwing. The consent gate reads this on every request from a fresh account.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      const latest = await repo.latestAcceptancesForAccount(accountId);
      expect(latest.size, 'no acceptances yet').toBe(0);
    });

    it('CRITICAL a row written through recordAcceptance is the one the read path returns. The two halves are separate statements — one Drizzle insert, one raw SELECT — so this is the only arm that proves they agree about column names.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      const written = await repo.recordAcceptance({
        accountId,
        documentKey: 'privacy',
        version: '3.1.4',
        contentHash: 'deadbeef',
        acceptedFromIp: null,
        acceptedUserAgent: null,
      });
      const latest = await repo.latestAcceptancesForAccount(accountId);
      const read = latest.get('privacy');
      expect(read?.id, 'same row id').toBe(written.id);
      expect(read?.contentHash, 'same content hash').toBe('deadbeef');
      expect(read?.acceptedAt.getTime(), 'same timestamp').toBe(written.acceptedAt.getTime());
    });
  },
);
