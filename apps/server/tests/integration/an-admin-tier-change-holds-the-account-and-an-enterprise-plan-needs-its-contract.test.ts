// An admin tier change HOLDS the account while it runs, and an Enterprise plan
// on credits needs the figure its contract says.
//
// Changing an account's tier used to be one bare UPDATE. A tier is now read by
// the monthly AI credits grants — which run under the account's credit-row lock
// — so a tier change racing a refresh could have the refresh read one plan and
// grant against another. It is now ONE TRANSACTION that takes `accounts` and
// then `credit_accounts`, in that order.
//
// ⛔ AND IT TAKES `accounts` AS `FOR NO KEY UPDATE`. A credit writer names no
// `accounts` row in any statement it writes — but every row it inserts carries a
// FOREIGN KEY to one, and Postgres takes `FOR KEY SHARE` on the parent row to
// check it. `FOR UPDATE` is the one strength that conflicts with that, so with
// it the two orders close a cycle and Postgres kills one side with 40P01. That
// was measured, not argued, and the arm THE OTHER ORDER DOES NOT DEADLOCK below
// is what holds it. `FOR NO KEY UPDATE` is what the UPDATE takes anyway, and it
// still conflicts with another tier change and with deleting the account.
//
// Two rules apply, and only to an account that is ON CREDITS (finding M7):
//
//   · ENTERPRISE HAS NO PLAN-WIDE ALLOWANCE. Every other plan's monthly credits
//     are a number in the entitlement table; Enterprise's is whatever the
//     agreement says. Assigning it without that figure would give the customer
//     a plan that includes AI and grants nothing, so it is refused until
//     `monthly_credits` is supplied — written, in the same transaction, as the
//     account's `contract` override.
//     ⛔ AND AN AMENDMENT MOVES THE FIGURE AND NOTHING ELSE. The override is
//     written with an UPSERT, which REPLACES the row, so a second change that
//     names only a new number would otherwise put `anchor_at` back to now(),
//     `own_key_allowed` back to true and the note back to ''. `anchor_at` is
//     the day of the month the credits reset on — the instant the whole month
//     calendar is counted from — so that is a money change, not tidiness.
//   · AN `admin_tier` OVERRIDE ENDS WITH THE TIER IT WAS SET FOR. It IS the
//     plan an admin assigned by hand; once a different one is assigned it would
//     otherwise go on granting the old plan's credits for ever. A `contract`
//     override is the opposite — the figure in a signed agreement, which a tier
//     change does not revoke — so it is never touched.
//
// ⛔ A LEGACY ACCOUNT BEHAVES EXACTLY AS IT DID. The credit row is read, not
// created: an account that has never been on credits has none, the `FOR UPDATE`
// matches nothing, and neither rule applies to it.
//
// ⛔ AND A TIER CHANGE GRANTS NOTHING BY ITSELF. What grants credits is a
// PAYMENT — a paid invoice line, a paid crypto order, or a plan an admin set as
// an override. Putting an account on api_scale with nothing paid gives it no
// credits at all; it stays exactly where it was until somebody sets an
// override (findings M7 and decision 4 of the corrected plan, which reverse the
// earlier plan's "an admin plan change on an account with no payment gets that
// plan's monthly credits").

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountsAdminRepo } from '../../src/db/admin-accounts-repo.js';
import { DrizzleCreditPlanOverridesRepo } from '../../src/db/credit-plan-overrides-repo.js';
import type { CreditLedgerExecutor } from '../../src/db/credit-ledger-repo.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import type { AccountContext } from '../../src/services/auth.js';
import { gate, openLedgerDatabase, waitUntilBlocked } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  newAccountOn,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  adminOverride,
  atHour,
  onCredits,
  overrideOf,
  tierOf,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_admin_tier';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_KEY_ID = '11111111-2222-3333-4444-555555555555';

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let adminDb: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  // One connection each, so "at once" below means two backends.
  harness = grantsHarness(opened.url, { max: 1 });
  adminDb = createDb(opened.url, { max: 1 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
  await adminDb?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

function admin(): Database {
  if (adminDb === null) throw new Error('isolated database unreachable');
  return adminDb;
}

function ctx(): AccountContext {
  return {
    account: { id: ADMIN_KEY_ID },
    apiKey: { id: ADMIN_KEY_ID, scopes: ['driftstack_internal_admin'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

/** The production repo, with the plan-override writer wired as bootstrap wires it. */
function repoWithOverrides(overrides = new DrizzleCreditPlanOverridesRepo(admin())) {
  return new DrizzleAccountsAdminRepo(admin(), overrides);
}

/** The repo as it stands while AI credits are OFF: no override writer at all. */
function repoWithCreditsOff() {
  return new DrizzleAccountsAdminRepo(admin(), null);
}

describe.skipIf(!RUN_DB_TESTS)(
  'an admin tier change holds the account and an enterprise plan needs its contract',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable, and the admin repo and the grants run on separate connections — otherwise the race below would be two calls taking turns on one backend', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      const [a] = await admin().client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const [b] = await h().database.client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      expect(a?.pid).not.toBe(b?.pid);
    });

    it('CRITICAL Enterprise on an account that is on credits is REFUSED without its monthly credits, and nothing moves: the tier is unchanged and no override was written', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      await onCredits(db(), accountId);

      await expect(
        repoWithOverrides().setTier(accountId, 'enterprise', new Date()),
      ).rejects.toThrow(/Enterprise plan has no standard monthly AI credits/i);

      expect(await tierOf(db(), accountId)).toBe('team_manual');
      expect(await overrideOf(db(), accountId)).toBeNull();
    });

    it('CRITICAL Enterprise WITH its monthly credits changes the tier and writes the contract in the SAME transaction — the plan and the allowance it is worth never exist apart', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      await onCredits(db(), accountId);

      const row = await repoWithOverrides().setTier(accountId, 'enterprise', new Date(), {
        monthlyCredits: 42_000,
        setByKeyId: ADMIN_KEY_ID,
        note: 'signed 2026-09',
      });

      expect(row?.tier).toBe('enterprise');
      expect(await tierOf(db(), accountId)).toBe('enterprise');
      expect(await overrideOf(db(), accountId)).toMatchObject({
        monthly_credits: 42_000,
        reason: 'contract',
        live: true,
        set_by_key_id: ADMIN_KEY_ID,
      });
    });

    it('CRITICAL and if the contract cannot be written the TIER DOES NOT MOVE either: a figure the database would refuse rolls the whole change back, rather than leaving an Enterprise account with no allowance', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      await onCredits(db(), accountId);

      await expect(
        // Above credit_plan_overrides_credits_range's ten million.
        repoWithOverrides().setTier(accountId, 'enterprise', new Date(), {
          monthlyCredits: 20_000_000,
        }),
      ).rejects.toThrow();

      expect(await tierOf(db(), accountId)).toBe('team_manual');
      expect(await overrideOf(db(), accountId)).toBeNull();
    });

    it('CRITICAL a LEGACY account is untouched by both rules: it goes to Enterprise with no figure at all, and no override is written for it', async () => {
      const legacy = await newAccountOn(db(), 'team_manual'); // no credit row at all
      const row = await repoWithOverrides().setTier(legacy, 'enterprise', new Date());
      expect(row?.tier).toBe('enterprise');
      expect(await overrideOf(db(), legacy)).toBeNull();

      // …and so is an account that has a credit row but is still billed the old way.
      const stillLegacy = await newAccountOn(db(), 'team_manual');
      await db()`INSERT INTO credit_accounts (account_id) VALUES (${stillLegacy}::uuid)`;
      const [{ mode } = { mode: '' }] = await db()<Array<{ mode: string }>>`
        SELECT billing_mode AS mode FROM credit_accounts WHERE account_id = ${stillLegacy}::uuid`;
      expect(mode).toBe('legacy');
      expect((await repoWithOverrides().setTier(stillLegacy, 'enterprise', new Date()))?.tier).toBe(
        'enterprise',
      );
      expect(await overrideOf(db(), stillLegacy)).toBeNull();
    });

    it('with AI credits switched OFF the repo has no override writer, and a tier change does exactly what it always did — including to Enterprise on an account that happens to be marked as on credits', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      await onCredits(db(), accountId);

      // The Enterprise rule still refuses, because the figure is what is
      // missing; supplying one with no writer wired is a wiring bug and says so.
      await expect(
        repoWithCreditsOff().setTier(accountId, 'enterprise', new Date()),
      ).rejects.toThrow(/monthly AI credits/i);
      await expect(
        repoWithCreditsOff().setTier(accountId, 'enterprise', new Date(), { monthlyCredits: 100 }),
      ).rejects.toThrow(/no plan-override writer wired/i);
      expect(await tierOf(db(), accountId)).toBe('team_manual');

      // Any other tier is the plain UPDATE it has always been.
      expect((await repoWithCreditsOff().setTier(accountId, 'api_scale', new Date()))?.tier).toBe(
        'api_scale',
      );
      expect(await tierOf(db(), accountId)).toBe('api_scale');
    });

    it('CRITICAL an `admin_tier` override ENDS when the tier changes — it is the plan an admin assigned, and it would otherwise go on granting the old plan’s credits under the new one', async () => {
      const accountId = await newAccountOn(db(), 'solo_manual');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 1_500, reason: 'admin_tier' });
      expect(await overrideOf(db(), accountId)).toMatchObject({ live: true });

      await repoWithOverrides().setTier(accountId, 'team_manual', new Date());

      expect(await overrideOf(db(), accountId)).toMatchObject({
        reason: 'admin_tier',
        live: false,
      });
    });

    it('…and is left alone when the tier does not actually change: re-assigning the tier an account already has is not a plan change', async () => {
      const accountId = await newAccountOn(db(), 'solo_manual');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 1_500, reason: 'admin_tier' });

      await repoWithOverrides().setTier(accountId, 'solo_manual', new Date());

      expect(await overrideOf(db(), accountId)).toMatchObject({ live: true, ends_at: null });
    });

    it('CRITICAL a `contract` override is NEVER ended by a tier change: it is the figure in a signed agreement, which changing the plan does not revoke', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 42_000, reason: 'contract' });

      await repoWithOverrides().setTier(accountId, 'api_scale', new Date());

      expect(await overrideOf(db(), accountId)).toMatchObject({
        reason: 'contract',
        monthly_credits: 42_000,
        live: true,
        ends_at: null,
      });
    });

    it('CRITICAL REVIEW B — AN AMENDMENT MOVES THE FIGURE AND NOTHING ELSE: a second Enterprise change carrying only a new number leaves the day the credits reset on, the own-key permission and the note of the agreement that is standing exactly where they were', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      await onCredits(db(), accountId);
      // A signed agreement: anchored 20 days ago (so the reset day is not
      // today), own key switched off by hand, and a note a person wrote.
      await adminOverride(db(), accountId, {
        monthlyCredits: 50_000,
        reason: 'contract',
        anchor: atHour(-480),
        ownKeyAllowed: false,
        note: 'signed 2026-08',
      });
      const before = await overrideOf(db(), accountId);

      await repoWithOverrides().setTier(accountId, 'enterprise', new Date(), {
        monthlyCredits: 60_000,
        setByKeyId: ADMIN_KEY_ID,
      });

      const after = await overrideOf(db(), accountId);
      // The row really was rewritten — without this the three "unchanged"
      // assertions below would hold for the wrong reason.
      expect(after?.monthly_credits, 'the amendment did not land').toBe(60_000);
      expect(after?.set_by_key_id).toBe(ADMIN_KEY_ID);
      expect(
        after!.effective_since.getTime(),
        'effective_since is what records that this figure applies from now',
      ).toBeGreaterThan(before!.effective_since.getTime());
      // ⛔ And the parts of the agreement the amendment never mentioned.
      // `anchor_at` is the instant the whole month calendar is counted from:
      // re-anchoring it to now() moves the customer's reset day and hands them
      // a short window at a full month's level.
      expect(after!.anchor_at.toISOString(), 'the reset day moved').toBe(
        before!.anchor_at.toISOString(),
      );
      expect(after?.own_key_allowed, 'an own-key policy set by hand was re-enabled').toBe(false);
      expect(after?.note).toBe('signed 2026-08');
      expect(after).toMatchObject({ reason: 'contract', live: true, ends_at: null });
    });

    it('…and an amendment that DOES send a note replaces the old one, so a person can correct what was written without losing the calendar with it', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, {
        monthlyCredits: 50_000,
        reason: 'contract',
        anchor: atHour(-480),
        ownKeyAllowed: false,
        note: 'signed 2026-08',
      });
      const before = await overrideOf(db(), accountId);

      await repoWithOverrides().setTier(accountId, 'enterprise', new Date(), {
        monthlyCredits: 60_000,
        note: 'amended 2026-09',
      });

      const after = await overrideOf(db(), accountId);
      expect(after?.note).toBe('amended 2026-09');
      expect(after!.anchor_at.toISOString()).toBe(before!.anchor_at.toISOString());
      expect(after?.own_key_allowed).toBe(false);
    });

    it('CRITICAL an `admin_tier` override carries NOTHING into the contract that replaces it: it is not an agreement, it has just been ended, and the new one is anchored where the database says now is', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, {
        monthlyCredits: 5_000,
        reason: 'admin_tier',
        anchor: atHour(-480),
        ownKeyAllowed: false,
        note: 'temporary',
      });
      const before = await overrideOf(db(), accountId);

      await repoWithOverrides().setTier(accountId, 'enterprise', new Date(), {
        monthlyCredits: 60_000,
      });

      const after = await overrideOf(db(), accountId);
      expect(after).toMatchObject({
        reason: 'contract',
        monthly_credits: 60_000,
        own_key_allowed: true,
        note: '',
        ends_at: null,
        live: true,
      });
      expect(
        after!.anchor_at.getTime(),
        'the ended admin plan’s anchor was carried into the agreement that replaced it',
      ).toBeGreaterThan(before!.anchor_at.getTime());
    });

    it('CRITICAL a tier change GRANTS NOTHING by itself: an account moved to the largest plan with nothing paid and no override has no coverage, so it gets no window, no lot and no credits (M7 — the corrected plan reverses the earlier one here)', async () => {
      const accountId = await newAccountOn(db(), 'free');
      await onCredits(db(), accountId);

      const service = new AccountsAdminService(
        repoWithOverrides(),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        h().grants,
      );
      const updated = await service.changeTier(ctx(), accountId, 'api_scale');

      expect(updated.tier).toBe('api_scale');
      expect(await windowsOf(db(), accountId)).toEqual([]);
      expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    });

    it('a tier change DOES grant what an override already earned: the refresh that follows it picks up coverage the account had and had not been given', async () => {
      const accountId = await newAccountOn(db(), 'free');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 2_500, reason: 'contract' });

      const service = new AccountsAdminService(
        repoWithOverrides(),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        h().grants,
      );
      await service.changeTier(ctx(), accountId, 'team_manual');

      expect(await windowsOf(db(), accountId)).toHaveLength(1);
      expect(await h().ledger.spendableMicro(accountId)).toBe(2_500 * MICRO);
    });

    it('CRITICAL RACE, observed: an admin tier change is open and holding the account; a credits refresh of the same account is seen WAITING on a lock, and when the change commits the refresh reads the world the admin left — not the one it found', async () => {
      const accountId = await newAccountOn(db(), 'solo_manual');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 1_500, reason: 'admin_tier' });
      // The credit row already exists (onCredits wrote it), so creating it is
      // NOT doing the lock's job for us — that is the case the lock is for.
      const [{ pid } = { pid: 0 }] = await h().database.client<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      const [{ pid: adminPid } = { pid: 0 }] = await admin().client<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;

      const holding = gate();
      const release = gate();
      const order: string[] = [];
      // The real override writer, paused after it has ended the override —
      // by which point setTier holds both row locks and has not yet committed.
      class PausingOverrides extends DrizzleCreditPlanOverridesRepo {
        override async endAdminTierOverride(
          id: string,
          on?: CreditLedgerExecutor,
        ): Promise<boolean> {
          const ended = await super.endAdminTierOverride(id, on);
          holding.open();
          await release.opened;
          return ended;
        }
      }
      const changing = repoWithOverrides(new PausingOverrides(admin()))
        .setTier(accountId, 'team_manual', new Date())
        .then((r) => {
          order.push('admin change commits');
          return r;
        });
      await holding.opened;

      const refreshing = h()
        .grants.refreshCredits(accountId)
        .then((r) => {
          order.push('refresh returns');
          return r;
        });
      let blockers: number[] = [];
      try {
        await waitUntilBlocked(db(), pid);
        // Blocked BY WHOM, not merely "blocked": `waitUntilBlocked` reports the
        // wait event, and a refresh stuck on anything at all would satisfy it.
        // A row-lock wait is a wait on the HOLDER's transaction id, so the
        // holder is what Postgres can name here.
        const [row] = await db()<Array<{ blockers: number[] }>>`
          SELECT pg_blocking_pids(${pid}) AS blockers`;
        blockers = row?.blockers ?? [];
      } finally {
        release.open();
      }
      // ⚠️ THIS WAS CORROBORATION AND IS NOW THE PROOF, because the account
      // row became `FOR NO KEY UPDATE`. It used to be neither: with the credit
      // row's `FOR UPDATE` removed the refresh still waited a moment, through
      // the foreign key from `credit_accounts` to the `accounts` row the change
      // held `FOR UPDATE`. `FOR NO KEY UPDATE` does not conflict with that
      // foreign key's `FOR KEY SHARE` — which is exactly why it is used — so
      // the credit row's own lock is the ONLY thing left that makes the refresh
      // wait. Re-measured with `.for('update')` removed from the credit row:
      // `waitUntilBlocked` reports "never blocked on a lock" and three arms go
      // red — this one, THE OTHER ORDER DOES NOT DEADLOCK, and the
      // content-parity pin. The ORDER asserted below is still what the lock is
      // FOR; it is no longer the only assertion that notices it is gone.
      expect(blockers, 'the refresh was not waiting on the open admin change').toContain(adminPid);
      await changing;
      const refreshed = await refreshing;

      expect(order).toEqual(['admin change commits', 'refresh returns']);
      // The override the admin ended is gone, so there is no coverage and
      // nothing is granted. A refresh that had read around the open change
      // would have found the override live and granted a month of it.
      expect(
        refreshed.window,
        'the refresh granted from coverage the admin had just ended',
      ).toEqual({ outcome: 'none' });
      expect(await windowsOf(db(), accountId)).toEqual([]);
      expect(await tierOf(db(), accountId)).toBe('team_manual');
    });

    it('CRITICAL THE OTHER ORDER DOES NOT DEADLOCK: a credits refresh that already holds the credit row, and an admin tier change that arrives while it runs, both COMMIT — because the tier change holds the account only as strongly as its own UPDATE needs, and every credit writer reaches that same account row through a foreign key', async () => {
      const accountId = await newAccountOn(db(), 'solo_manual');
      await onCredits(db(), accountId);
      // Coverage, so the refresh really writes a window — the write whose
      // foreign key to `accounts` is the second half of the cycle. A
      // `contract` override, so the admin change never ends it and the
      // refresh has something to grant on either side of the race.
      await adminOverride(db(), accountId, { monthlyCredits: 1_500, reason: 'contract' });
      const [{ pid: adminPid } = { pid: 0 }] = await admin().client<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;

      const holding = gate();
      const release = gate();
      // The refresh, opened out so the admin change can arrive in the middle of
      // it: `lockAccount` is what every credit writer does FIRST, and the
      // window/lot/ledger writes that follow all carry a foreign key to
      // `accounts`, which takes a FOR KEY SHARE lock on that row.
      const refreshing = h()
        .ledger.transaction(async (tx) => {
          await h().ledger.lockAccount(tx, accountId);
          holding.open();
          await release.opened;
          return h().grants.refreshCreditsIn(tx, accountId);
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      await holding.opened;

      // The admin change now takes `accounts` and then waits for the credit row
      // the refresh is holding. Release the refresh only once it is waiting, so
      // the two lock requests are genuinely crossed.
      const changing = repoWithOverrides()
        .setTier(accountId, 'team_manual', new Date())
        .then(
          () => null,
          (err: unknown) => err,
        );
      try {
        await waitUntilBlocked(db(), adminPid);
      } finally {
        release.open();
      }
      const [refreshFailure, changeFailure] = await Promise.all([refreshing, changing]);

      // Drizzle wraps the driver's error, so the SQLSTATE is on the cause: read
      // through the chain, or a deadlock would be reported as an opaque
      // "Failed query" and could be mistaken for an unrelated failure.
      const codeOf = (err: unknown): string => {
        for (let e = err; e !== null && e !== undefined; e = (e as { cause?: unknown }).cause) {
          const code = (e as { code?: unknown }).code;
          if (typeof code === 'string') return code;
        }
        return err === null
          ? ''
          : `no SQLSTATE: ${err instanceof Error ? err.message : JSON.stringify(err)}`;
      };
      expect(
        [codeOf(refreshFailure), codeOf(changeFailure)],
        'the admin tier change and a credits refresh of one account deadlocked (40P01)',
      ).toEqual(['', '']);
      // And the ordering the lock is there for still holds: the change waited
      // for the credit writer rather than reading around it.
      expect(await tierOf(db(), accountId)).toBe('team_manual');
      expect(await windowsOf(db(), accountId)).toHaveLength(1);
      expect(await h().ledger.spendableMicro(accountId)).toBe(1_500 * MICRO);
    });

    it('the race above could have gone the other way: the SAME setup, refreshed before the admin change, does grant the override’s month — so "nothing was granted" means the refresh waited, not that there was never anything to grant', async () => {
      const accountId = await newAccountOn(db(), 'solo_manual');
      await onCredits(db(), accountId);
      await adminOverride(db(), accountId, { monthlyCredits: 1_500, reason: 'admin_tier' });

      const refreshed = await h().grants.refreshCredits(accountId);

      expect(refreshed.window.outcome).toBe('created');
      expect(await h().ledger.spendableMicro(accountId)).toBe(1_500 * MICRO);
    });
  },
);
