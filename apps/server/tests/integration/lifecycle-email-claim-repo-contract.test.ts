// V-1225 — one contract for the customer-email dedup claims, against BOTH implementations of
// `AccountLifecycleRepo`.
//
// The fifteenth of the twenty-nine. Every method here answers one question — "am I the caller that
// gets to send this email?" — and the cost of getting it wrong is a customer receiving the same
// mail twice, or not at all.
//
// A FOURTH SINGLE-USE MECHANISM, which is the reason this file is worth its own entry. Across four
// contracts the same guarantee now appears four different ways:
//
//   V-1220  compare a monotonic counter          last_used_totp_counter < $n
//   V-1221  stamp a consumed_at                  SET consumed_at WHERE consumed_at IS NULL
//   V-1224  null the token you matched on        SET confirm_token_hash = NULL WHERE hash = $x
//   V-1225  win an INSERT                        ON CONFLICT (stripe_event_id, kind) DO NOTHING
//                                                RETURNING …  -> rows.length > 0
//
// and alongside the fourth, the plainest one: `SET … WHERE first_failure_email_sent_at IS NULL`.
// None of them looks like the others, so none of them is covered by another's test, and a reader
// who has internalised one shape will not recognise the next as the same promise.
//
// THE COMPOSITE KEY IS THE ARM THAT MATTERS. `claimBillingEmail` dedups on
// (stripe_event_id, KIND), not on the event alone. One Stripe event legitimately drives more than
// one kind of mail, so a claim keyed on the event id would let the first kind sent suppress every
// other kind for that event — a customer charged and never told, because the renewal reminder for
// the same event went out first. The double keys a Set on `${stripeEventId}:${kind}`; the SQL names
// both columns as its conflict target. Same key, no shared code, nothing asserting they agree.
//
// The two flag claims are pinned as INDEPENDENT of each other for the same reason: they are separate
// columns, and an implementation that collapsed them into one "welcome email sent" flag would
// silence the first-success mail for any customer whose first session failed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AccountLifecycleRepo } from '../../src/services/account-lifecycle.js';
import { DrizzleAccountLifecycleRepo } from '../../src/db/account-lifecycle-repo.js';
import { InMemoryAccountLifecycleRepo } from './_helpers/in-memory-account-lifecycle-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-20T12:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];
const seededEvents: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM billing_email_sends LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const e of seededEvents) {
      await client`DELETE FROM billing_email_sends WHERE stripe_event_id = ${e}`.catch(() => {});
    }
    for (const a of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: AccountLifecycleRepo;
  account: () => Promise<string>;
  event: () => string;
}

function eventId(track: boolean): string {
  const id = `evt_lifecycle_${randomUUID().replace(/-/g, '')}`;
  if (track) seededEvents.push(id);
  return id;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryAccountLifecycleRepo();
  return {
    repo,
    account: () => {
      const id = randomUUID();
      repo.upsert({ id, email: `lifecycle-${id}@test.local` });
      return Promise.resolve(id);
    },
    event: () => eventId(false),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAccountLifecycleRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seededAccounts.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`lifecycle-${id}@test.local`})`;
      return id;
    },
    event: () => eventId(true),
  };
}

function lifecycleEmailContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AccountLifecycleRepo email-claim contract — ${label}`, () => {
    it('CRITICAL the first-failure email is claimed exactly once, in both. The boolean IS the permission to send, so an implementation returning true twice mails the customer the same "your first session failed" notice twice.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();

      expect(
        await s.repo.markFirstFailureEmailSent(account, NOW),
        'the first claim was refused',
      ).toBe(true);
      expect(
        await s.repo.markFirstFailureEmailSent(account, NOW),
        'the same first-failure email was claimed twice',
      ).toBe(false);
    });

    it('CRITICAL the first-success and first-failure claims are INDEPENDENT, in both. They are separate columns for separate mails, and an implementation collapsing them into one flag would silence the first-success notice for every customer whose first session happened to fail.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.repo.markFirstFailureEmailSent(account, NOW);

      expect(
        await s.repo.markFirstSuccessEmailSent(account, NOW),
        'claiming the failure email also consumed the success email',
      ).toBe(true);
    });

    it('CRITICAL a billing email is claimed per (event, KIND), so one Stripe event can still drive a second KIND of mail, in both. Keyed on the event alone, the first kind sent would suppress every other kind for that event — a customer charged and never told, because the renewal reminder went out first.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const stripeEventId = s.event();

      expect(
        await s.repo.claimBillingEmail({
          stripeEventId,
          kind: 'billing-receipt',
          accountId: account,
          at: NOW,
        }),
        'the receipt claim was refused',
      ).toBe(true);
      expect(
        await s.repo.claimBillingEmail({
          stripeEventId,
          kind: 'billing-renewal-reminder',
          accountId: account,
          at: NOW,
        }),
        'a different KIND of mail for the same event was suppressed',
      ).toBe(true);
    });

    it('CRITICAL the SAME (event, kind) is claimed only once, in both. Stripe retries deliveries, so without this the same receipt is mailed on every retry.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const stripeEventId = s.event();
      const args = {
        stripeEventId,
        kind: 'billing-receipt',
        accountId: account,
        at: NOW,
      } as const;

      expect(await s.repo.claimBillingEmail(args), 'the first claim was refused').toBe(true);
      expect(await s.repo.claimBillingEmail(args), 'the same receipt was claimed twice').toBe(
        false,
      );
    });

    it("CRITICAL claims are per-account, in both. One customer receiving their first-failure notice must not consume another customer's.", async () => {
      if (!enabled()) return;
      const s = make();
      const first = await s.account();
      const second = await s.account();
      await s.repo.markFirstFailureEmailSent(first, NOW);

      expect(
        await s.repo.markFirstFailureEmailSent(second, NOW),
        "one account's claim consumed another account's",
      ).toBe(true);
    });
  });
}

lifecycleEmailContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AccountLifecycleRepo email-claim contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    lifecycleEmailContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
