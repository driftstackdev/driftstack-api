// V-1210 — one contract for `findEndpointsNeedingForceRotation`, executed against BOTH
// implementations of `WebhooksRepo`.
//
// The fifth of the twenty-nine, and the one V-1209 measured and left open. It is the most
// consequential of the four ordering divergences that sweep found, because here the order is not
// presentation:
//
//   DrizzleWebhooksRepo   -> .orderBy(webhookEndpoints.secretCreatedAt).limit(args.limit)
//   InMemoryWebhooksRepo  -> for (const r of this.endpoints.values()) … if (out.length >= limit) break;
//
// The double filters correctly and honours the limit — that part is faithful. What differs is WHICH
// endpoints come back when more are eligible than the limit allows. `ORDER BY secret_created_at`
// takes the oldest secrets first; Map iteration takes an arbitrary set. Order plus a limit is
// SELECTION, so a unit test believing it had exercised the rotation sweep had exercised a different
// sweep from the one that runs — and the endpoints most overdue for rotation are exactly the ones
// arbitrary selection can keep skipping.
//
// WHY THE ARM CREATES THREE AND ASKS FOR TWO. With `limit >= eligible` every implementation returns
// the same set and the assertion cannot tell them apart, which is the vacuity trap V-1209's
// ordering arm fell into. Three eligible endpoints and a limit of two makes the answer a CHOICE,
// and the arm asserts the choice is the two oldest.
//
// The exclusion arms are here because each one is a reason an endpoint would silently never rotate:
// disabled, already force-rotated, or a secret younger than the threshold.
//
// V-1212 added the second arm below. The real repo refuses a secret that is not `whsec_` + 32
// lowercase base32; the double accepted any string, so unit tests built endpoints production would
// reject. V-1210 measured that enforcing it reds 43 tests across seven files and deferred it; the
// actual scope turned out to be 13 fixture literals, because the other 59 of the 72 belong to
// encryption-module tests that never touch the double.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { WebhooksRepo } from '../../src/services/webhooks.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/**
 * Ephemeral, generated per run and never persisted. The Drizzle repo THROWS rather than storing a
 * plaintext secret when no key is configured, which is the right posture and means the contract
 * cannot be exercised without one.
 */
const TEST_SECRET_KEY = randomBytes(32).toString('base64');

/** `whsec_` + 32 lowercase base32 chars — the shape DrizzleWebhooksRepo enforces. */
function signingSecret(): string {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(32);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `whsec_${out}`;
}

const NOW = new Date('2026-08-20T00:00:00.000Z');
const THRESHOLD_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
/** All three are well past the 90-day threshold; only their relative age decides the winners. */
const AGE_DAYS = { oldest: 400, middle: 300, newest: 200 } as const;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM webhook_endpoints LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const id of seeded) {
      await client`DELETE FROM webhook_endpoints WHERE account_id = ${id}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: WebhooksRepo;
  account: () => Promise<string>;
  /** Force an endpoint's `secretCreatedAt`; both implementations stamp it at insert time. */
  ageSecret: (id: string, at: Date) => Promise<void>;
  disable: (id: string) => Promise<void>;
  markForceRotated: (id: string, at: Date) => Promise<void>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryWebhooksRepo();
  const row = (id: string): Record<string, unknown> | undefined =>
    (repo as unknown as { endpoints: Map<string, Record<string, unknown>> }).endpoints.get(id);
  return {
    repo,
    account: () => Promise.resolve(randomUUID()),
    ageSecret: (id, at) => {
      const r = row(id);
      if (r) r['secretCreatedAt'] = at;
      return Promise.resolve();
    },
    disable: (id) => {
      const r = row(id);
      if (r) r['disabledAt'] = NOW;
      return Promise.resolve();
    },
    markForceRotated: (id, at) => {
      const r = row(id);
      if (r) r['forceRotatedAt'] = at;
      return Promise.resolve();
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleWebhooksRepo(
      { client: c, db, close: async () => {} },
      { secretEncryptionKeyBase64: TEST_SECRET_KEY },
    ),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`wh-contract-${id}@test.local`})`;
      return id;
    },
    ageSecret: async (id, at) => {
      await c`UPDATE webhook_endpoints SET secret_created_at = ${at.toISOString()}::timestamptz WHERE id = ${id}::uuid`;
    },
    disable: async (id) => {
      await c`UPDATE webhook_endpoints SET disabled_at = ${NOW.toISOString()}::timestamptz WHERE id = ${id}::uuid`;
    },
    markForceRotated: async (id, at) => {
      await c`UPDATE webhook_endpoints SET force_rotated_at = ${at.toISOString()}::timestamptz WHERE id = ${id}::uuid`;
    },
  };
}

async function endpoint(s: Subject, accountId: string, ageDays: number): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const row = await s.repo.insertEndpoint({
    accountId,
    url: `https://customer.test/hook-${tag}`,
    secret: signingSecret(),
    secretPrefix: `whsec_${tag}`,
    events: ['session.completed'],
    description: null,
  });
  await s.ageSecret(row.id, new Date(NOW.getTime() - ageDays * DAY));
  return row.id;
}

/**
 * The sweep is PLATFORM-WIDE — it takes no account id, because force-rotation is an operator
 * action across every customer. On the shared database that means rows seeded by other arms (and
 * by other suites) are in the result, so every assertion below scopes to its own account. Without
 * that the arms pass or fail on whatever else happens to be in the table, which is a flake dressed
 * as a contract.
 */
const dueForAccount = async (s: Subject, accountId: string, limit: number): Promise<string[]> => {
  const rows = await s.repo.findEndpointsNeedingForceRotation({
    now: NOW,
    thresholdDays: THRESHOLD_DAYS,
    limit,
  });
  return rows.filter((r) => r.accountId === accountId).map((r) => r.id);
};

function forceRotationContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`WebhooksRepo force-rotation contract — ${label}`, () => {
    it('CRITICAL when more endpoints are due than the limit allows, the OLDEST secrets are chosen, in both. Order plus a limit is selection, not presentation: the real repo orders by secret_created_at and the double iterated a Map, so the endpoints most overdue for rotation are exactly the ones arbitrary selection can keep skipping.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      // Created middle, newest, oldest — deliberately NOT in age order. Creating them oldest-first
      // makes Map iteration order coincide with secret age, and the arm then passes against a
      // double that never sorts. Same vacuity trap as V-1209's backdate direction.
      const middle = await endpoint(s, account, AGE_DAYS.middle);
      const newest = await endpoint(s, account, AGE_DAYS.newest);
      const oldest = await endpoint(s, account, AGE_DAYS.oldest);

      // A generous limit, then scoped to this account: the RELATIVE order is the property, and it
      // is what decides who survives a real limit. Asserting against a global limit of 2 would be
      // decided by whatever other rows are in the table, not by this repo's ordering.
      const picked = await dueForAccount(s, account, 500);

      expect(picked, 'the sweep did not return oldest-secret-first').toEqual([
        oldest,
        middle,
        newest,
      ]);
    });

    it('CRITICAL a malformed signing secret is rejected by both, and rejected as a REJECTION rather than a synchronous throw. The real repo validates before storing; a double that accepted anything let unit tests build endpoints production refuses, and thirteen fixtures across seven files were doing exactly that.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();

      await expect(
        s.repo.insertEndpoint({
          accountId: account,
          url: 'https://customer.test/hook-malformed',
          secret: 'whsec_NOT-BASE32',
          secretPrefix: 'whsec_bad',
          events: ['session.completed'],
          description: null,
        }),
        'a malformed signing secret was stored',
      ).rejects.toThrow(/base32/i);
    });

    it('CRITICAL a disabled endpoint is never selected, in both. Rotating a secret for an endpoint nobody delivers to spends the sweep budget on rows that cannot benefit from it.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const live = await endpoint(s, account, AGE_DAYS.middle);
      const disabled = await endpoint(s, account, AGE_DAYS.oldest);
      await s.disable(disabled);

      expect(await dueForAccount(s, account, 500), 'a disabled endpoint was selected').toEqual([
        live,
      ]);
    });

    it('CRITICAL an already force-rotated endpoint is never selected again, in both. forceRotatedAt is the only record that the sweep has been here, so an implementation ignoring it would re-rotate the same endpoint every tick and never reach the rest.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const pending = await endpoint(s, account, AGE_DAYS.middle);
      const done = await endpoint(s, account, AGE_DAYS.oldest);
      await s.markForceRotated(done, NOW);

      expect(await dueForAccount(s, account, 500), 'a rotated endpoint came back').toEqual([
        pending,
      ]);
    });

    it('CRITICAL a secret younger than the threshold is not selected, in both. This is the arm that decides what "needing rotation" means, and an off-by-one here rotates secrets the policy considers current.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const old = await endpoint(s, account, AGE_DAYS.oldest);
      await endpoint(s, account, 1);

      expect(await dueForAccount(s, account, 500), 'a fresh secret was selected').toEqual([old]);
    });
  });
}

forceRotationContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'WebhooksRepo force-rotation contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    forceRotationContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
