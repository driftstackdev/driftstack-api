// A dispute recorded before migration 0139 is refused loudly, not read as "no
// dispute" (S17 audit 4 #11, coordinator ruling R14).
//
// 0139 gave every credit window its UNDISPUTED level and every dispute's own
// clawback rows the amount it disputed. A row written before it has neither: a
// window whose level a standing dispute lowered reads its lowered level as the
// undisputed one, and the dispute's own row carries no amount. The fourth audit
// built a database at 0138, gave it such a dispute and migrated it: a second
// dispute of 1,000 then set the payment's disputed amount to 1,000 (the legacy
// 4,900 was skipped), and the dispute event itself granted 2,000 credits — the
// lowered level read as undisputed, so the full month looked like an upgrade.
//
// Production's credit tables were empty when 0139 shipped, so there is nothing
// to backfill. Of the two answers R14 allows, this file proves the one chosen:
// such a row is REFUSED — the reversal, the win and the refresh each throw, the
// error names what a person must review, nothing moves, and the refresh's
// caller alerts — rather than guessed at.
//
// The database is built by the real migrator from a copy of the migrations
// folder cut at 0138, the legacy rows are written as the 0138 code wrote them,
// and then the whole chain is applied.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { CreditClawbacksService } from '../../src/services/credit-clawbacks.js';
import { refreshCreditsAfter } from '../../src/services/credit-grants.js';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { recreateEmptyIsolatedDatabase } from './_helpers/fresh-isolated-database.js';
import { grantsHarness, type GrantsHarness } from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_legacy_dispute';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
const MICRO = 1_000_000;
const LAST_BEFORE_0139 = '0138_web_session_actor_columns';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

let folderAt0138: string | null = null;
let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let service: CreditClawbacksService | null = null;
let setupFailure: string | null = 'setup never ran';
const alerts: SentryMessage[] = [];
const logged: Record<string, unknown>[] = [];

/** The legacy account: a starter month disputed IN FULL before 0139. */
const legacy = {
  accountId: '0a0a0a0a-1111-4222-8333-444444444444',
  invoiceId: 'in_legacy_0138',
  chargeId: 'ch_legacy_0138',
  subscriptionId: 'sub_legacy_0138',
  disputeId: 'dp_legacy_0138',
  windowId: '0b0b0b0b-1111-4222-8333-444444444444',
  lotId: '0c0c0c0c-1111-4222-8333-444444444444',
};

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  // A copy of the migrations folder that stops at 0138.
  folderAt0138 = mkdtempSync(join(tmpdir(), 'legacy-dispute-0138-'));
  cpSync(MIGRATIONS, folderAt0138, { recursive: true });
  const journalPath = join(folderAt0138, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const cut = journal.entries.findIndex((e) => e.tag === LAST_BEFORE_0139);
  if (cut < 0) throw new Error('0138 is not in the journal');
  journal.entries = journal.entries.slice(0, cut + 1);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  const url = await recreateEmptyIsolatedDatabase(ISOLATED_DB_NAME);
  if (url === null) return;
  const candidate = postgres(url, { max: 2, onnotice: () => undefined });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
  try {
    await migrate(drizzle(candidate), { migrationsFolder: folderAt0138 });
    await writeLegacyDispute(candidate);
    // Then the whole chain, 0139 onwards, exactly as a deploy would apply it.
    await migrate(drizzle(candidate), { migrationsFolder: MIGRATIONS });
    setupFailure = null;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    setupFailure = (e.cause?.message ?? e.message ?? String(err)).slice(0, 300);
    return;
  }
  harness = grantsHarness(url, { max: 4 });
  const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  service = new CreditClawbacksService({
    ledger: harness.ledger,
    windows: harness.windows,
    grants: harness.grants,
    logger: quiet as unknown as Logger,
    sentry: { captureMessage: (msg) => void alerts.push(msg) },
  });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
  if (folderAt0138 !== null) rmSync(folderAt0138, { recursive: true, force: true });
});

/**
 * What the 0138 code left behind for a starter month (3,000 credits for 4,900)
 * disputed in full: the payment's disputed amount, the window's level lowered to
 * nothing (0138 had no undisputed level), the month's lot funded and then taken
 * back whole, and the dispute's own clawback row (0138 had no amount column).
 */
async function writeLegacyDispute(sql: postgres.Sql): Promise<void> {
  const l = legacy;
  const start = "date_trunc('second', now()) - interval '5 days'";
  const end = `((${start}) AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO accounts (id, email, tier)
      VALUES (${l.accountId}::uuid, 'legacy-0138@example.test', 'api_starter'::account_tier)`;
    await tx`
      INSERT INTO subscriptions (account_id, stripe_subscription_id, stripe_price_id, tier, status)
      VALUES (${l.accountId}::uuid, ${l.subscriptionId}, 'price_api_starter',
              'api_starter'::account_tier, 'active'::subscription_status)`;
    await tx.unsafe(
      `INSERT INTO billing_invoice_payments
         (stripe_invoice_id, account_id, stripe_subscription_id, billing_reason, amount_paid_minor,
          currency, line_kind, line_stripe_price_id, line_tier, line_interval, line_period_start,
          line_period_end, paid_at, refunded_minor, disputed_minor, stripe_charge_id)
       VALUES ($1, $2, $3, 'subscription_cycle', 4900, 'usd', 'period', 'price_api_starter',
               'api_starter'::account_tier, 'month', ${start}, ${end}, now(), 0, 4900, $4)`,
      [l.invoiceId, l.accountId, l.subscriptionId, l.chargeId],
    );
    await tx`INSERT INTO credit_accounts (account_id) VALUES (${l.accountId}::uuid)`;
    await tx.unsafe(
      `INSERT INTO credit_windows
         (id, account_id, source, source_ref, natural_start, natural_end, window_start, window_end,
          tier, level_micro)
       VALUES ($1, $2, 'stripe_invoice', $3, ${start}, ${end}, ${start}, ${end},
               'api_starter'::account_tier, 0)`,
      [l.windowId, l.accountId, l.invoiceId],
    );
    await tx.unsafe(
      `INSERT INTO credit_lots
         (id, account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
       VALUES ($1, $2, 'monthly', 0, $3, $4, ${String(3_000 * MICRO)}, ${start}, ${end})`,
      [l.lotId, l.accountId, l.windowId, `window:${l.windowId}`],
    );
    await tx`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      VALUES (${l.accountId}::uuid, 'grant', ${l.lotId}::uuid, ${String(3_000 * MICRO)}::bigint,
              ${`grant:${l.lotId}`}, 'system')`;
    const target = `window:${l.windowId}:${l.invoiceId}`;
    await tx`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor, reason)
      VALUES (${l.accountId}::uuid, 'refund_clawback', ${l.lotId}::uuid, ${String(-3_000 * MICRO)}::bigint,
              ${`clawback:stripe_dispute:${l.disputeId}:${target}:${l.lotId}`}, 'system', 'stripe_dispute')`;
    await tx`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, amount_micro, state, clawed_micro,
         pending_micro, debt_micro)
      VALUES (${l.accountId}::uuid, 'stripe_dispute', ${l.disputeId}, ${target},
              ${String(3_000 * MICRO)}::bigint, 'applied', ${String(3_000 * MICRO)}::bigint, 0, 0)`;
  });
}

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function h(): GrantsHarness {
  if (harness === null) throw new Error(`setup failed: ${setupFailure ?? 'unknown'}`);
  return harness;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error(`setup failed: ${setupFailure ?? 'unknown'}`);
  return service;
}

/** Everything a reversal or a refresh could move, for the legacy account. */
async function footprint(): Promise<string> {
  const id = legacy.accountId;
  const [row] = await db()<Array<Record<string, string>>>`
    SELECT (SELECT count(*)::text FROM credit_lots WHERE account_id = ${id}::uuid) AS lots,
           (SELECT count(*)::text FROM credit_ledger WHERE account_id = ${id}::uuid) AS ledger,
           (SELECT count(*)::text FROM credit_clawbacks WHERE account_id = ${id}::uuid) AS clawbacks,
           (SELECT string_agg(level_micro::text || '/' || level_seq::text, ',' ORDER BY id)
              FROM credit_windows WHERE account_id = ${id}::uuid) AS windows,
           (SELECT refunded_minor::text || '/' || disputed_minor::text
              FROM billing_invoice_payments WHERE stripe_invoice_id = ${legacy.invoiceId}) AS payment,
           (SELECT COALESCE(sum(remaining_micro), 0)::text FROM credit_lots
             WHERE account_id = ${id}::uuid) AS remaining,
           (SELECT debt_micro::text FROM credit_accounts WHERE account_id = ${id}::uuid) AS debt`;
  return JSON.stringify(row);
}

/** What a call threw, by name and message; 'no error' when it returned. */
async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error';
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return `${e.name ?? 'Error'}: ${e.message ?? String(err)}`;
  }
}

const REFUSED = /^CreditLegacyDisputeError: .*dispute recorded before migration 0139/;

describe.skipIf(!RUN_DB_TESTS)(
  'a dispute recorded before 0139 is refused loudly, not read as no dispute',
  () => {
    it('the database was built at 0138, given a legacy dispute, and migrated to the end', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(setupFailure).toBeNull();
    });

    it('CRITICAL a second dispute on the invoice is refused, and neither the payment nor the credit moves (the audit’s P14: it had set the disputed amount to 1,000 and granted 2,000)', async () => {
      const before = await footprint();
      const outcome = await thrown(() =>
        svc().applyStripeDispute({
          disputeId: 'dp_second_after_0139',
          chargeId: legacy.chargeId,
          stripeInvoiceId: null,
          amountMinor: 1_000,
        }),
      );
      expect(outcome).toMatch(REFUSED);
      expect(await footprint()).toBe(before);
    });

    it('CRITICAL a refresh is refused before it grants the lowered level back as an "upgrade", and its caller alerts', async () => {
      const before = await footprint();
      expect(await thrown(() => h().grants.refreshCredits(legacy.accountId))).toMatch(REFUSED);
      expect(await footprint()).toBe(before);
      // The path every billing event and task reserve takes: logged and
      // alerted, never swallowed silently, and the caller's own work stands.
      const alertsBefore = alerts.length;
      await refreshCreditsAfter(h().grants, legacy.accountId, {
        trigger: 'stripe_webhook',
        rethrowTransient: true,
        logger: { error: (obj) => void logged.push(obj) },
        sentry: { captureMessage: (msg) => void alerts.push(msg) },
      });
      expect(alerts.length - alertsBefore).toBe(1);
      expect(alerts[alerts.length - 1]?.tags).toEqual({
        kind: 'ai_credits_refresh_failed',
        trigger: 'stripe_webhook',
      });
      expect(JSON.stringify(logged[logged.length - 1])).toContain('CreditLegacyDisputeError');
      expect(await footprint()).toBe(before);
    });

    it('CRITICAL the legacy dispute’s own win is refused rather than handing back a guessed amount', async () => {
      const before = await footprint();
      expect(
        await thrown(() =>
          svc().reinstateDispute({
            disputeId: legacy.disputeId,
            chargeId: legacy.chargeId,
            stripeInvoiceId: null,
            amountMinor: 4_900,
          }),
        ),
      ).toMatch(REFUSED);
      expect(await footprint()).toBe(before);
    });

    it('the standing-disputes read itself refuses a dispute row with no amount, while a stand-alone cover’s share row (no amount by design, written with a ledger mark) is passed over', async () => {
      const outcome = await thrown(() =>
        h().ledger.transaction((tx) =>
          h().windows.standingDisputes(tx, legacy.accountId, legacy.invoiceId),
        ),
      );
      expect(outcome).toMatch(REFUSED);
      // A row with no amount but a ledger mark is how 0140 writes a dispute's
      // take from ANOTHER payment's share of a month: not this payment's
      // dispute, and not legacy.
      await db()`
        UPDATE credit_clawbacks SET state = 'reversed'
         WHERE account_id = ${legacy.accountId}::uuid AND source_ref = ${legacy.disputeId}`;
      await db()`
        INSERT INTO credit_clawbacks
          (account_id, source, source_ref, target_key, amount_micro, state, clawed_micro,
           pending_micro, debt_micro, ledger_mark)
        VALUES (${legacy.accountId}::uuid, 'stripe_dispute', 'dp_other_payment',
                ${`window:${legacy.windowId}:${legacy.invoiceId}`}, ${String(MICRO)}::bigint,
                'applied', ${String(MICRO)}::bigint, 0, 0, 1)`;
      const standing = await h().ledger.transaction((tx) =>
        h().windows.standingDisputes(tx, legacy.accountId, legacy.invoiceId),
      );
      expect(standing).toEqual([]);
    });
  },
);
