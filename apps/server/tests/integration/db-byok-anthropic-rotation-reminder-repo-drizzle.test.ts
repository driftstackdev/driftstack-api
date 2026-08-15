// Drizzle-backed integration test for DrizzleByokAnthropicRotationReminderRepo.
//
// Seventh of the zero-coverage repos (item 5e), and the second found by the
// import-vs-pin sweep rather than by the coverage report: this repo has a
// content-parity pin naming its source path and no test that imports it, so it
// never executed. Same shape validation-schedules-repo turned out to be in.
//
// What this query decides is how often a customer is emailed about rotating
// their BYOK Anthropic key, and the whole decision sits in one `and` of three
// predicates. Each has a distinct and opposite failure:
//
//   not(isNull(setAt))          a customer with NO key configured has nothing
//                               to rotate. Drop it and we email people about a
//                               key they never gave us.
//
//   lt(setAt, thresholdCutoff)  the age gate. Drop it and every BYOK customer
//                               is reminded on the first sweep after setting a
//                               key — a rotation notice for a key set that
//                               morning.
//
//   or(isNull(lastReminderAt),  the dedupe. This is the one that matters most,
//      lt(lastReminderAt,       and it is an OR, so the two halves fail in
//         cooldownCutoff))      OPPOSITE directions and no single arm can cover
//                               both. Lose the `lt` half and a customer who has
//                               ever been reminded is never reminded again, so
//                               the 90-day rotation notice fires exactly once in
//                               the lifetime of the account. Lose the `isNull`
//                               half and a customer who has NEVER been reminded
//                               is never eligible — the reminder never fires at
//                               all, for anyone, which is the failure that looks
//                               like "the feature works, nobody complained".
//                               Lose the whole clause and every sweep re-emails
//                               every overdue customer, daily.
//
// The ordering is oldest-key-first under a limit, the same starvation shape as
// the validation-harness due query: reversed, the customer whose key is most
// overdue is the last to ever be told, while newer keys are reminded ahead of
// them every sweep.
//
// Shared-database discipline: `accounts` is the busiest shared table in the
// suite and this query has no per-caller scope, so every arm filters the result
// to account ids this run seeded and asserts membership or relative order.
// Asserting a global count, or a head-of-list position, would pass alone and
// fail in a full run.
//
// MUTATION-PROVED against byok-anthropic-rotation-reminder-repo.ts, running BOTH
// this file and the existing content-parity pin against each mutation.
// Controls: 11/11 here, 8/8 on the pin.
//
//                                                       here      the pin
//   drops not(isNull(setAt))                          0 red       1 red
//   drops the age gate                                1 red       1 red
//   drops the whole dedupe clause                     3 red       1 red
//   dedupe keeps only isNull                          1 red       1 red
//   dedupe keeps only lt                              5 red       1 red
//   orders newest-key-first                          10 red       1 red
//   markReminderSent loses its account predicate      1 red       1 red
//   markReminderSent stamps the wrong column          2 red       1 red
//
// ⚠️ The first row is NOT a hole in this file. `not(isNull(setAt))` is REDUNDANT:
// the age gate `lt(setAt, thresholdCutoff)` is in the same `and`, and in SQL's
// three-valued logic `NULL < <timestamp>` is NULL, not TRUE, so a row with no
// key is already excluded without it. Confirmed against the database rather than
// argued from semantics:
//
//     SELECT (NULL::timestamptz < now()) IS TRUE;   -- f
//
// Removing that predicate therefore changes no result set, so NO behavioural
// test can detect it — and the arm above still earns its place by pinning the
// observable rule rather than the redundant clause implementing it. (The same
// redundancy explains the `.filter(… !== null)` in the mapping, which exists to
// narrow the nullable column's TYPE, not to change the rows.)
//
// ⭐ That makes this repo the MIRROR of validation-schedules-repo, where the
// source pin was blind to four behavioural inversions. Here the pin catches all
// eight, including the one no execution test can — because a redundant predicate
// has text but no behaviour. Neither instrument dominates: the pin sees changes
// that do not move behaviour, and only execution distinguishes WHICH way a
// change broke. Note that both dedupe halves red the pin identically at 1 arm,
// while they red 1 and 5 arms here — the pin reports that the text moved, not
// that customers would now be spammed rather than silenced.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleByokAnthropicRotationReminderRepo } from '../../src/db/byok-anthropic-rotation-reminder-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-15T12:00:00.000Z');
const THRESHOLD_DAYS = 90;
const COOLDOWN_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** Relative to NOW, so every fixture reads as an age rather than a date. */
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleByokAnthropicRotationReminderRepo | null = null;
const seeded: string[] = [];

/**
 * An account with a BYOK key of a given age and reminder history.
 *
 * `setAt: null` means no key configured at all — the case the first predicate
 * exists for.
 */
async function seedAccount(opts: {
  setAt: Date | null;
  lastReminderAt?: Date | null;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at,
                          byok_anthropic_api_key_set_at,
                          byok_anthropic_api_key_last_reminder_sent_at)
    VALUES (${id}, ${`byokrot-${id.slice(0, 8)}@example.test`}, ${'BYOK Rotation Fixture'},
            'free'::account_tier, 'active'::account_status, now(), now(),
            ${opts.setAt === null ? null : opts.setAt.toISOString()}::timestamptz,
            ${
              opts.lastReminderAt === null || opts.lastReminderAt === undefined
                ? null
                : opts.lastReminderAt.toISOString()
            }::timestamptz)`;
  seeded.push(id);
  return id;
}

/** The due set, restricted to accounts this run created. */
async function dueIds(limit = 500): Promise<string[]> {
  if (!repo) throw new Error('no repo');
  const rows = await repo.findAccountsNeedingRotationReminder({
    now: NOW,
    thresholdDays: THRESHOLD_DAYS,
    cooldownDays: COOLDOWN_DAYS,
    limit,
  });
  return rows.map((r) => r.accountId).filter((id) => seeded.includes(id));
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
    await client`SELECT byok_anthropic_api_key_set_at FROM accounts LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleByokAnthropicRotationReminderRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    for (const id of seeded) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleByokAnthropicRotationReminderRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the column present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL an overdue key that has never been reminded IS selected. This is the ordinary case the whole sweep exists to serve, and every exclusion arm below would also pass against a query that returned nothing at all — so this one is what stops them being vacuous.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: daysAgo(200), lastReminderAt: null });
      expect(await dueIds(), 'the overdue, never-reminded account is due').toContain(id);
    });

    it('CRITICAL an account with NO BYOK key configured is never selected. There is nothing to rotate, so a missing null-check would email customers about a key they never gave us — and the row carries no key to name in the message.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: null, lastReminderAt: null });
      expect(await dueIds(), 'no key means nothing to remind about').not.toContain(id);
    });

    it('CRITICAL a key younger than the threshold is not selected. Without the age gate every BYOK customer is reminded on the first sweep after configuring a key, so someone who set one this morning is told it is overdue for rotation.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: daysAgo(10), lastReminderAt: null });
      expect(await dueIds(), 'a ten-day-old key is not due for rotation').not.toContain(id);
    });

    it('CRITICAL an overdue key reminded INSIDE the cooldown is suppressed. This is the anti-spam half of the dedupe: without it every sweep re-emails every overdue customer, so a daily job turns a quarterly rotation notice into a daily one — and it arrives fastest to the customers already furthest behind.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: daysAgo(200), lastReminderAt: daysAgo(3) });
      expect(await dueIds(), 'reminded three days ago, cooldown is thirty').not.toContain(id);
    });

    it('CRITICAL an overdue key reminded BEFORE the cooldown is selected again. This is the opposite half of the same OR, and it fails in the opposite direction: lose it and any customer who has ever been reminded is never reminded again, so the notice fires exactly once in the lifetime of the account and the key is never actually rotated.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: daysAgo(200), lastReminderAt: daysAgo(60) });
      expect(await dueIds(), 'last reminded sixty days ago, cooldown is thirty').toContain(id);
    });

    it('CRITICAL the due set is ordered oldest-key-first. The sweep takes only `limit` accounts, so ordering decides who is dropped when more are overdue than one run can email. Oldest-first means the longest-overdue key is told first; reversed, that customer is last every sweep while newer keys are reminded ahead of them — the key most in need of rotation is the one never mentioned.', async () => {
      if (!dbReachable || !repo) return;
      // Seeded newest-first so insertion order disagrees with the expected order.
      const newer = await seedAccount({ setAt: daysAgo(120), lastReminderAt: null });
      const older = await seedAccount({ setAt: daysAgo(400), lastReminderAt: null });

      const ids = await dueIds();
      const iOlder = ids.indexOf(older);
      const iNewer = ids.indexOf(newer);
      expect(iOlder, 'the oldest key is in the due set').toBeGreaterThanOrEqual(0);
      expect(iNewer, 'and so is the newer one').toBeGreaterThanOrEqual(0);
      // Relative position only — other accounts in a shared database sort between.
      expect(iOlder, 'the older key is offered before the newer one').toBeLessThan(iNewer);
    });

    it('CRITICAL the limit is honoured. The sweep sizes this to what one run can email, and a limit that leaked would send the entire overdue backlog in a single tick.', async () => {
      if (!dbReachable || !repo) return;
      await seedAccount({ setAt: daysAgo(300), lastReminderAt: null });
      await seedAccount({ setAt: daysAgo(310), lastReminderAt: null });

      const rows = await repo.findAccountsNeedingRotationReminder({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        cooldownDays: COOLDOWN_DAYS,
        limit: 1,
      });
      expect(rows.length, 'at most one account per run').toBeLessThanOrEqual(1);
    });

    it('CRITICAL the selected row carries the fields the email needs. The reminder is addressed and dated from this row, so a null address or a missing set-at date is an email that cannot be sent or one that states the wrong key age.', async () => {
      if (!dbReachable || !repo) return;
      const setAt = daysAgo(150);
      const id = await seedAccount({ setAt, lastReminderAt: null });

      const rows = await repo.findAccountsNeedingRotationReminder({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        cooldownDays: COOLDOWN_DAYS,
        limit: 500,
      });
      const mine = rows.find((r) => r.accountId === id);
      expect(mine, 'the seeded account came back').toBeDefined();
      expect(mine?.accountEmail, 'an address to send to').toMatch(/@example\.test$/);
      expect(mine?.byokAnthropicApiKeySetAt.getTime(), 'the key age the email states').toBe(
        setAt.getTime(),
      );
      expect(mine?.byokAnthropicApiKeyLastReminderSentAt, 'never reminded').toBeNull();
    });

    it('CRITICAL markReminderSent removes the account from the due set. It is the write that closes the loop, and if it did not land the next sweep would select the same account again — the dedupe column is the only thing standing between a quarterly notice and a daily one.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ setAt: daysAgo(200), lastReminderAt: null });
      expect(await dueIds(), 'due before the send').toContain(id);

      await repo.markReminderSent({ accountId: id, now: NOW });
      expect(await dueIds(), 'and suppressed after it').not.toContain(id);
    });

    it('CRITICAL markReminderSent is scoped to its account. The update carries a single `eq` on the id; without it one send would stamp every account in the table, silencing the entire overdue backlog for a full cooldown after a single email.', async () => {
      if (!dbReachable || !repo) return;
      const sent = await seedAccount({ setAt: daysAgo(210), lastReminderAt: null });
      const untouched = await seedAccount({ setAt: daysAgo(220), lastReminderAt: null });

      await repo.markReminderSent({ accountId: sent, now: NOW });

      const ids = await dueIds();
      expect(ids, 'the one we emailed is suppressed').not.toContain(sent);
      expect(ids, "but the neighbour's reminder is still owed").toContain(untouched);
    });
  },
);
