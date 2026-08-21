// V-1214 — one contract, executed against BOTH implementations of the Stripe webhook ledger and
// tier transitions.
//
// The eighth of the twenty-nine, chosen for the consequence rather than a suspected defect: this is
// the money path. `recordEvent` is the replay guard for every Stripe webhook, and Stripe retries
// aggressively — an event processed twice is a tier granted twice or a receipt sent twice.
//
// The two properties that carry it:
//
//   recordEvent            INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING event_id
//                          -> { inserted: result.length > 0 }
//   setAccountTierIfUpgrade only applies when isCryptoTierUpgrade(previous, next); otherwise
//                          reports applied: false and leaves the tier alone
//
// `inserted` is not a convenience flag. It is the caller's ONLY signal that this delivery is the
// first one, so an implementation that returned `true` for a replay would re-run the side effects
// the ledger exists to suppress, and one that returned `false` for a first delivery would drop the
// event entirely. Both directions are asserted.
//
// WHAT THIS CONTRACT DOES NOT CLAIM TO HAVE FOUND. Both implementations already agree, and the
// upgrade rule is shared rather than reimplemented — both call `isCryptoTierUpgrade`, which is the
// structure that prevents the V-1197 divergence in the first place. This file pins the agreement so
// a later edit to either side has to break an assertion to land; it is owed work, not a finding,
// and recording it as a finding would be dishonest.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-20T12:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededEvents: string[] = [];
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM processed_stripe_events LIMIT 0`;
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
      await client`DELETE FROM processed_stripe_events WHERE event_id = ${e}`.catch(() => {});
    }
    for (const a of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** Only the slice of the repo this contract speaks to — both classes implement far more. */
interface LedgerSubject {
  hasEvent: (id: string) => Promise<boolean>;
  recordEvent: (args: {
    eventId: string;
    eventType: string;
    payloadHash: string;
    result: string;
    receivedAt: Date;
  }) => Promise<{ inserted: boolean }>;
  getAccountTier: (accountId: string) => Promise<string | null>;
  setAccountTierIfUpgrade: (args: {
    accountId: string;
    tier: 'solo_manual' | 'team_manual' | 'agency_manual';
    at: Date;
  }) => Promise<{ previousTier: string | null; applied: boolean }>;
  /** Seeds an account at `tier` and returns its id. */
  account: (tier: 'free' | 'solo_manual' | 'team_manual') => Promise<string>;
}

function eventId(): string {
  const id = `evt_contract_${randomUUID().replace(/-/g, '')}`;
  seededEvents.push(id);
  return id;
}

function inMemorySubject(): LedgerSubject {
  const repo = new InMemoryStripeWebhooksRepo();
  return {
    hasEvent: (id) => repo.hasEvent(id),
    recordEvent: (a) => repo.recordEvent(a),
    getAccountTier: (id) => repo.getAccountTier(id),
    setAccountTierIfUpgrade: (a) => repo.setAccountTierIfUpgrade(a),
    account: (tier) => {
      const id = randomUUID();
      // stripeCustomerId is required by the seam even though this contract never reads it —
      // vitest accepted the omission because esbuild does not type-check; strict tsc did not.
      repo.registerAccount({ accountId: id, stripeCustomerId: null, tier });
      return Promise.resolve(id);
    },
  };
}

function drizzleSubject(): LedgerSubject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleStripeWebhooksRepo({ client: c, db, close: async () => {} });
  return {
    hasEvent: (id) => repo.hasEvent(id),
    recordEvent: (a) => repo.recordEvent(a),
    getAccountTier: (id) => repo.getAccountTier(id),
    setAccountTierIfUpgrade: (a) => repo.setAccountTierIfUpgrade(a),
    account: async (tier) => {
      const id = randomUUID();
      seededAccounts.push(id);
      await c`INSERT INTO accounts (id, email, tier)
              VALUES (${id}, ${`stripe-contract-${id}@test.local`}, ${tier})`;
      return id;
    },
  };
}

function stripeLedgerContract(
  label: string,
  make: () => LedgerSubject,
  enabled: () => boolean,
): void {
  describe(`Stripe webhook ledger contract — ${label}`, () => {
    it("CRITICAL a first delivery reports inserted, in both. This flag is the caller's only signal that the side effects have not run yet, so an implementation reporting false here drops a real Stripe event on the floor.", async () => {
      if (!enabled()) return;
      const s = make();
      const id = eventId();

      const first = await s.recordEvent({
        eventId: id,
        eventType: 'customer.subscription.updated',
        payloadHash: 'hash-1',
        result: 'ok',
        receivedAt: NOW,
      });

      expect(first.inserted, 'a first delivery did not report inserted').toBe(true);
      expect(await s.hasEvent(id), 'a recorded event is not visible to hasEvent').toBe(true);
    });

    it('CRITICAL a REPLAY of the same event id reports inserted false, in both. Stripe retries aggressively, and this is the whole replay guard: reporting true a second time re-runs the side effects the ledger exists to suppress — a tier granted twice, a receipt sent twice.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = eventId();
      const args = {
        eventId: id,
        eventType: 'customer.subscription.updated',
        payloadHash: 'hash-1',
        result: 'ok',
        receivedAt: NOW,
      };

      await s.recordEvent(args);
      const replay = await s.recordEvent(args);

      expect(replay.inserted, 'a replayed event reported as newly inserted').toBe(false);
    });

    it('CRITICAL a replay carrying a DIFFERENT payload is still suppressed, in both. The ledger is keyed on the event id alone, so a retry whose body differs must not slip past as a new event — the conflict target is the id and nothing else.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = eventId();

      await s.recordEvent({
        eventId: id,
        eventType: 'customer.subscription.updated',
        payloadHash: 'hash-original',
        result: 'ok',
        receivedAt: NOW,
      });
      const replay = await s.recordEvent({
        eventId: id,
        eventType: 'customer.subscription.deleted',
        payloadHash: 'hash-DIFFERENT',
        result: 'error',
        receivedAt: new Date(NOW.getTime() + 60_000),
      });

      expect(replay.inserted, 'a differing payload bypassed the replay guard').toBe(false);
    });

    it('CRITICAL an unrecorded event id is not reported as seen, in both. hasEvent answering true for an event nobody delivered would suppress a real one.', async () => {
      if (!enabled()) return;
      const s = make();
      expect(
        await s.hasEvent(`evt_never_${randomUUID()}`),
        'an unseen event reported as seen',
      ).toBe(false);
    });

    it('CRITICAL setAccountTierIfUpgrade raises a tier and reports the previous one, in both. The previous tier is what the audit trail and the tier-changed email are built from, so losing it turns a billing change into an unexplained one.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account('free');

      const result = await s.setAccountTierIfUpgrade({
        accountId: account,
        tier: 'team_manual',
        at: NOW,
      });

      expect(result.applied, 'a genuine upgrade was refused').toBe(true);
      expect(result.previousTier, 'the previous tier was not reported').toBe('free');
      expect(await s.getAccountTier(account), 'the upgrade did not persist').toBe('team_manual');
    });

    it('CRITICAL setAccountTierIfUpgrade refuses to LOWER a tier and leaves it untouched, in both. A late or out-of-order Stripe delivery for a cheaper plan must not strip entitlements the customer is still paying for, and `applied: false` is what tells the caller nothing happened.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account('team_manual');

      const result = await s.setAccountTierIfUpgrade({
        accountId: account,
        tier: 'solo_manual',
        at: NOW,
      });

      expect(result.applied, 'a downgrade was applied through the upgrade-only path').toBe(false);
      expect(
        await s.getAccountTier(account),
        'the tier moved despite the call reporting it had not',
      ).toBe('team_manual');
    });
  });
}

stripeLedgerContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'Stripe webhook ledger contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    stripeLedgerContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
