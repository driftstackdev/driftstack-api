// V-1229 — one contract for legal-acceptance resolution, against BOTH implementations of
// `LegalRepo`.
//
// The nineteenth of the twenty-nine. `latestAcceptancesForAccount` answers "which version of each
// document did this customer accept?" — the record produced if anyone ever has to show that a
// specific human agreed to a specific text. An account accumulates a row per acceptance, so the
// question is really WHICH ROW WINS per document key.
//
//   Drizzle  SELECT DISTINCT ON (document_key) …
//            WHERE account_id = $1
//            ORDER BY document_key, accepted_at DESC, id DESC
//
//   double   sort by (acceptedAt DESC, id DESC), then first-hit-per-documentKey wins
//
// `DISTINCT ON` and a first-hit loop over a sorted list are not obviously the same thing, and
// nothing asserted that they resolve to the same row.
//
// THE `id DESC` TIEBREAK IS THE ARM WORTH HAVING, and V-1228 is why it is written the way it is.
// `accepted_at` is not monotonic-unique: two acceptances recorded in one request — a customer
// clicking through terms and privacy together — can share a timestamp. When they tie, `id DESC`
// decides, deterministically, on BOTH sides.
//
// But a tie cannot be forced through this interface: `recordAcceptance` stamps `accepted_at`
// itself, and Postgres microseconds do not tie where a JavaScript millisecond Date does — the exact
// resolution mismatch that made V-1228's first ordering arm a coin flip. So the arms below assert
// what is deterministic on both: with DISTINCT timestamps, the NEWEST acceptance wins. The tiebreak
// is exercised where it can be exercised honestly, in the Drizzle-only block, by writing the two
// rows with an identical `accepted_at` through raw SQL — which no double can be made to do.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { LegalRepo } from '../../src/services/legal.js';
import { DrizzleLegalRepo } from '../../src/db/legal-repo.js';
import { InMemoryLegalRepo } from './_helpers/in-memory-legal-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TERMS = 'terms-of-service';
const PRIVACY = 'privacy-policy';

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM legal_acceptances LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM legal_acceptances WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: LegalRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryLegalRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

async function seedAccount(c: ReturnType<typeof postgres>): Promise<string> {
  const id = randomUUID();
  seeded.push(id);
  await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`legal-${id}@test.local`})`;
  return id;
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleLegalRepo({ client: c, db, close: async () => {} }),
    account: () => seedAccount(c),
  };
}

async function accept(s: Subject, accountId: string, documentKey: string, version: string) {
  return s.repo.recordAcceptance({
    accountId,
    documentKey,
    version,
    contentHash: `hash-${version}`,
    acceptedFromIp: null,
    acceptedUserAgent: null,
  });
}

function legalContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`LegalRepo acceptance contract — ${label}`, () => {
    it('CRITICAL the NEWEST acceptance of a document wins, in both. An account accumulates a row per acceptance, so resolving to an older one would record the customer as having agreed to text they superseded — the opposite of what the log exists to prove.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await accept(s, account, TERMS, 'v1');
      await new Promise((r) => setTimeout(r, 5));
      await accept(s, account, TERMS, 'v2');

      const latest = await s.repo.latestAcceptancesForAccount(account);
      expect(latest.get(TERMS)?.version, 'an older acceptance won over a newer one').toBe('v2');
    });

    it('CRITICAL each document key resolves INDEPENDENTLY, in both. Terms and privacy are accepted separately and versioned separately, so collapsing them would report a customer as having accepted a privacy policy they never saw.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await accept(s, account, TERMS, 'terms-v3');
      await accept(s, account, PRIVACY, 'privacy-v1');

      const latest = await s.repo.latestAcceptancesForAccount(account);
      expect(latest.get(TERMS)?.version, 'the terms acceptance was lost').toBe('terms-v3');
      expect(latest.get(PRIVACY)?.version, 'the privacy acceptance was lost').toBe('privacy-v1');
    });

    it("CRITICAL acceptances are account-scoped, in both. This is the record that one specific human agreed to one specific text; another account's appearing in it makes the whole log worthless as evidence.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      await accept(s, stranger, TERMS, 'theirs');

      expect(
        (await s.repo.latestAcceptancesForAccount(owner)).size,
        "another account's acceptance was returned",
      ).toBe(0);
    });

    it('CRITICAL an account with no acceptances resolves to an empty map, in both. The caller treats a missing key as "not accepted" and gates on it, so an implementation inventing a row would let an unaccepted customer through.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();

      expect(
        (await s.repo.latestAcceptancesForAccount(account)).size,
        'an account with no acceptances resolved to something',
      ).toBe(0);
    });
  });
}

legalContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'LegalRepo acceptance contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    legalContract('drizzle', drizzleSubject, () => dbReachable);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // DRIZZLE-ONLY, because the tie cannot be produced through the shared interface.
    // `recordAcceptance` stamps `accepted_at` itself, and a JavaScript millisecond Date ties where
    // a Postgres microsecond timestamp does not — the mismatch that made V-1228's first ordering
    // arm a coin flip. Writing both rows with an IDENTICAL accepted_at through raw SQL is the only
    // honest way to exercise the tiebreak, and no double can be made to do it.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    it('CRITICAL when two acceptances share an accepted_at, `id DESC` decides — deterministically. accepted_at is not monotonic-unique: a customer clicking through terms and privacy in one request can produce two rows with the same timestamp. Without the tiebreak, DISTINCT ON picks whichever row the scan reaches first, and the version this account is recorded as accepting changes between reads of the same data.', async () => {
      if (!process.env.CI && !dbReachable) return;
      const c = client;
      if (!c) return;
      const s = drizzleSubject();
      const account = await seedAccount(c);
      const sharedAt = new Date('2026-08-20T12:00:00.000Z').toISOString();

      const lowId = '00000000-0000-4000-8000-000000000001';
      const highId = 'ffffffff-0000-4000-8000-000000000002';
      for (const [id, version] of [
        [lowId, 'loser'],
        [highId, 'winner'],
      ] as const) {
        await c`INSERT INTO legal_acceptances
                  (id, account_id, document_key, version, content_hash, accepted_at)
                VALUES (${id}::uuid, ${account}::uuid, ${TERMS}, ${version},
                        ${`hash-${version}`}, ${sharedAt}::timestamptz)`;
      }

      const latest = await s.repo.latestAcceptancesForAccount(account);
      expect(
        latest.get(TERMS)?.version,
        'the tie resolved to the lower id — the tiebreak is not id DESC, so the recorded version ' +
          'depends on scan order',
      ).toBe('winner');
    });
  },
);
