// Backfill of paid billing periods, from Stripe.
//
// The webhook records a paid invoice from the day it is deployed. This fills in
// what happened BEFORE that day, and repairs what a webhook could not read:
//
//   1. INVOICES. Pages Stripe's PAID invoices of the last 13 months and records
//      each one exactly as the webhook would: same reader, same write, same rule
//      for what a second sighting may change. An invoice already recorded is
//      left as it is, or completed if its row named no line. An invoice is
//      recorded ONLY when it says `status: 'paid'` itself — asking Stripe for
//      paid invoices is not the evidence, and the repair mode (`invoiceIds`)
//      does not even ask: it reads whatever ids it is handed.
//   2. SUBSCRIPTIONS. Walks the mirror rows that have NO period start (every row
//      written before the start was stored), asks Stripe for each subscription,
//      and stores the start it reports. When Stripe no longer knows the
//      subscription, the start is DERIVED — the stored period end minus one
//      interval — and marked as derived. A start a webhook wrote is never
//      touched: only a missing one is filled.
//
// ⛔ NOT RUN AUTOMATICALLY. Nothing schedules this and no route calls it. It is a
// function for an operator-triggered job, and it changes nothing a customer can
// see: no email, no tier, no response.
//
// RESUMABLE, TWICE OVER.
//   · Every write is idempotent, so running it again — after a crash, or on top
//     of a finished run — writes nothing twice. That alone makes a re-run safe.
//   · It also reports a CURSOR after every page, and throws
//     `StripePeriodBackfillInterrupted` carrying the last good cursor when a page
//     fails. Handing that cursor back resumes after the last finished page
//     instead of paging 13 months again.
//   A failure inside a page leaves the cursor at the END OF THE PREVIOUS PAGE, so
//   the resumed run re-reads the interrupted page; its already-written invoices
//   come back 'unchanged'.
//
// Invoices are listed newest first, so invoices raised AFTER a run began sit
// ahead of its cursor and a resumed run does not see them. They do not need it:
// the webhook records them as they are paid.
//
// A Stripe outage is never mistaken for an answer. Only "Stripe does not know
// this subscription" (a 404) falls back to a derived start; any other failure
// interrupts the run.

import { addUtcMonths } from '@driftstack/api-types';
import type { Logger } from '../lib/logger.js';
import {
  reportUnlinkableInvoice,
  type UnlinkableInvoiceReason,
} from '../lib/report-unlinkable-invoice.js';
import type { SentryClient } from '../lib/sentry.js';
import {
  PAID_INVOICE_STATUS,
  readPaidInvoice,
  readSubscriptionPeriodStart,
  type BillingInterval,
  type StripePriceMaps,
} from '../lib/stripe-billing-facts.js';
import type { StripeWebhooksRepo } from './stripe-webhooks.js';

/** How far back paid invoices are read. A year of monthly periods, and one to spare. */
export const BACKFILL_WINDOW_MONTHS = 13;
const DEFAULT_INVOICE_PAGE_SIZE = 25;
const DEFAULT_SUBSCRIPTION_PAGE_SIZE = 50;

/** The three reads the backfill makes. `StripeApiClient` satisfies it. */
export interface StripePeriodBackfillStripe {
  getInvoice(invoiceId: string): Promise<Record<string, unknown>>;
  listInvoices(args: {
    status: 'paid';
    createdGte: Date;
    limit: number;
    startingAfter?: string;
  }): Promise<{ data: Array<Record<string, unknown>>; hasMore: boolean }>;
  getSubscription(subscriptionId: string): Promise<Record<string, unknown>>;
}

export type StripePeriodBackfillRepo = Pick<
  StripeWebhooksRepo,
  | 'findAccountIdFromCustomerOrRef'
  | 'upsertInvoicePayment'
  | 'listSubscriptionsMissingPeriodStart'
  | 'fillSubscriptionPeriodStart'
>;

/**
 * Where a run has got to. Plain data, so a caller can store it between runs.
 * `windowStart` rides along so a resumed run reads the SAME 13 months the
 * interrupted one did, not 13 months counted from a later "now".
 */
export interface StripePeriodBackfillCursor {
  windowStart: string;
  invoices: { done: boolean; after: string | null };
  subscriptions: { done: boolean; after: string | null };
}

export interface StripePeriodBackfillReport {
  invoices: {
    seen: number;
    inserted: number;
    completed: number;
    unchanged: number;
    /**
     * The invoice does not say `status: 'paid'` (it is open, void, written off, a
     * draft — or says nothing). Not recorded, whatever else it carries.
     */
    notPaid: number;
    /** The invoice's customer is no account here. Not recorded. */
    unknownCustomer: number;
    /** No id, currency, whole non-negative amount, or date. Not recorded. */
    unreadable: number;
    /** Recorded against another account already. Not re-attributed. */
    accountMismatch: number;
    /** Recorded, but tied to no subscription line. */
    unlinked: number;
  };
  subscriptions: {
    seen: number;
    filledFromStripe: number;
    filledDerived: number;
    /** No start from Stripe and none derivable, or the row changed meanwhile. */
    notFilled: number;
  };
  cursor: StripePeriodBackfillCursor;
}

export interface StripePeriodBackfillDeps {
  stripe: StripePeriodBackfillStripe;
  repo: StripePeriodBackfillRepo;
  maps: StripePriceMaps;
  logger: Logger;
  sentry?: Pick<SentryClient, 'captureMessage'>;
}

export interface StripePeriodBackfillOptions {
  /** Defaults to the wall clock. The 13-month window is counted back from it. */
  now?: Date;
  /** Resume a run from the cursor it last reported. */
  resumeFrom?: StripePeriodBackfillCursor;
  /**
   * Record exactly these invoices (each read with getInvoice) INSTEAD of paging
   * the window: the repair for an invoice named in an alert's log line. The
   * subscription walk is skipped.
   */
  invoiceIds?: readonly string[];
  invoicePageSize?: number;
  subscriptionPageSize?: number;
  /** Called after every finished page, with the cursor to resume from. */
  onProgress?: (report: StripePeriodBackfillReport) => void | Promise<void>;
}

/** A page failed. `report.cursor` resumes after the last page that finished. */
export class StripePeriodBackfillInterrupted extends Error {
  readonly report: StripePeriodBackfillReport;

  constructor(report: StripePeriodBackfillReport, cause: unknown) {
    super('Stripe period backfill interrupted; resume from report.cursor', { cause });
    this.name = 'StripePeriodBackfillInterrupted';
    this.report = report;
  }
}

/**
 * A caller's page size, or the default when it is not a positive whole number.
 * Not a nicety: the subscription walk ends on "a page came back short", and a
 * page of 0 rows is never short of 0 — read as given, it would ask the database
 * for the same empty page for ever.
 */
function pageSize(requested: number | undefined, fallback: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested >= 1
    ? requested
    : fallback;
}

function isStripeNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'StripeApiError' &&
    (err as { status?: unknown }).status === 404
  );
}

function copyReport(report: StripePeriodBackfillReport): StripePeriodBackfillReport {
  return {
    invoices: { ...report.invoices },
    subscriptions: { ...report.subscriptions },
    cursor: {
      windowStart: report.cursor.windowStart,
      invoices: { ...report.cursor.invoices },
      subscriptions: { ...report.cursor.subscriptions },
    },
  };
}

export async function runStripePeriodBackfill(
  deps: StripePeriodBackfillDeps,
  options: StripePeriodBackfillOptions = {},
): Promise<StripePeriodBackfillReport> {
  const now = options.now ?? new Date();
  const report: StripePeriodBackfillReport = {
    invoices: {
      seen: 0,
      inserted: 0,
      completed: 0,
      unchanged: 0,
      notPaid: 0,
      unknownCustomer: 0,
      unreadable: 0,
      accountMismatch: 0,
      unlinked: 0,
    },
    subscriptions: { seen: 0, filledFromStripe: 0, filledDerived: 0, notFilled: 0 },
    cursor: options.resumeFrom ?? {
      windowStart: addUtcMonths(now, -BACKFILL_WINDOW_MONTHS).toISOString(),
      invoices: { done: false, after: null },
      subscriptions: { done: false, after: null },
    },
  };
  // The caller's cursor object is never written to: the report owns its own.
  report.cursor = copyReport(report).cursor;

  const progress = async (): Promise<void> => {
    if (options.onProgress !== undefined) await options.onProgress(copyReport(report));
  };
  const alerts: AlertCounts = new Map();

  try {
    if (options.invoiceIds !== undefined) {
      for (const invoiceId of options.invoiceIds) {
        await recordInvoice(deps, report, alerts, await deps.stripe.getInvoice(invoiceId));
      }
    } else {
      await backfillInvoices(deps, options, report, alerts, progress);
      await backfillSubscriptions(deps, options, report, progress);
    }
  } catch (err) {
    throw new StripePeriodBackfillInterrupted(copyReport(report), err);
  } finally {
    // Once per reason per run, not once per invoice: the count says how many.
    for (const [reason, count] of alerts) {
      reportUnlinkableInvoice(deps.sentry, { reason, source: 'backfill', count });
    }
  }
  return copyReport(report);
}

/** Invoices to raise an alert about, by reason, gathered over one run. */
type AlertCounts = Map<UnlinkableInvoiceReason, number>;

function countAlert(alerts: AlertCounts, reason: UnlinkableInvoiceReason): void {
  alerts.set(reason, (alerts.get(reason) ?? 0) + 1);
}

async function backfillInvoices(
  deps: StripePeriodBackfillDeps,
  options: StripePeriodBackfillOptions,
  report: StripePeriodBackfillReport,
  alerts: AlertCounts,
  progress: () => Promise<void>,
): Promise<void> {
  const createdGte = new Date(report.cursor.windowStart);
  const limit = pageSize(options.invoicePageSize, DEFAULT_INVOICE_PAGE_SIZE);
  while (!report.cursor.invoices.done) {
    const after = report.cursor.invoices.after;
    const page = await deps.stripe.listInvoices({
      status: 'paid',
      createdGte,
      limit,
      ...(after !== null ? { startingAfter: after } : {}),
    });
    let last: string | null = null;
    for (const invoice of page.data) {
      const id = await recordInvoice(deps, report, alerts, invoice);
      if (id !== null) last = id;
    }
    // The cursor moves only once the whole page is written.
    if (last !== null) report.cursor.invoices.after = last;
    // A page with no usable id cannot be stepped past; stop rather than loop on it.
    report.cursor.invoices.done = !page.hasMore || last === null;
    await progress();
  }
}

/** Record one invoice. Returns its id (for the cursor), or null when it has none. */
async function recordInvoice(
  deps: StripePeriodBackfillDeps,
  report: StripePeriodBackfillReport,
  alerts: AlertCounts,
  invoice: Record<string, unknown>,
): Promise<string | null> {
  const counts = report.invoices;
  counts.seen += 1;
  const facts = readPaidInvoice(invoice, deps.maps);
  const stripeInvoiceId = facts.stripeInvoiceId;
  // ⛔ THE INVOICE MUST SAY IT WAS PAID. Paging asks Stripe for paid invoices
  // only, but `invoiceIds` reads whatever it is handed, and nothing else here is
  // evidence of payment: an open or voided invoice reads as a perfectly good
  // period with $0 paid — and a $0 row counts as covered. Silence refuses too.
  if (facts.status !== PAID_INVOICE_STATUS) {
    counts.notPaid += 1;
    deps.logger.error(
      { component: 'stripe-period-backfill', stripeInvoiceId, status: facts.status },
      'invoice is not paid; not recorded',
    );
    return stripeInvoiceId;
  }
  const paidAt = facts.paidAt ?? facts.createdAt;
  if (
    stripeInvoiceId === null ||
    facts.currency === null ||
    facts.amountPaidMinor === null ||
    paidAt === null
  ) {
    counts.unreadable += 1;
    deps.logger.error(
      { component: 'stripe-period-backfill', stripeInvoiceId },
      'paid invoice could not be read; not recorded',
    );
    return stripeInvoiceId;
  }

  const accountId = await deps.repo.findAccountIdFromCustomerOrRef({
    stripeCustomerId: facts.stripeCustomerId,
    clientReferenceId: null,
  });
  if (accountId === null) {
    counts.unknownCustomer += 1;
    return stripeInvoiceId;
  }

  const { outcome, linked } = await deps.repo.upsertInvoicePayment({
    stripeInvoiceId,
    accountId,
    stripeSubscriptionId: facts.stripeSubscriptionId,
    billingReason: facts.billingReason,
    amountPaidMinor: facts.amountPaidMinor,
    currency: facts.currency,
    stripePaymentIntentId: facts.stripePaymentIntentId,
    stripeChargeId: facts.stripeChargeId,
    line: facts.line,
    paidAt,
  });
  if (outcome === 'account_mismatch') {
    counts.accountMismatch += 1;
    countAlert(alerts, 'account_mismatch');
    deps.logger.error(
      { component: 'stripe-period-backfill', stripeInvoiceId },
      'paid invoice is already recorded against another account; left as it is',
    );
    return stripeInvoiceId;
  }
  if (outcome === 'inserted') counts.inserted += 1;
  else if (outcome === 'completed') counts.completed += 1;
  else counts.unchanged += 1;
  if (!linked) {
    counts.unlinked += 1;
    countAlert(alerts, facts.unlinkedReason ?? 'no_subscription_line');
    deps.logger.error(
      { component: 'stripe-period-backfill', stripeInvoiceId, reason: facts.unlinkedReason },
      'paid invoice is tied to no billing period',
    );
  }
  return stripeInvoiceId;
}

async function backfillSubscriptions(
  deps: StripePeriodBackfillDeps,
  options: StripePeriodBackfillOptions,
  report: StripePeriodBackfillReport,
  progress: () => Promise<void>,
): Promise<void> {
  const limit = pageSize(options.subscriptionPageSize, DEFAULT_SUBSCRIPTION_PAGE_SIZE);
  while (!report.cursor.subscriptions.done) {
    const rows = await deps.repo.listSubscriptionsMissingPeriodStart({
      afterStripeSubscriptionId: report.cursor.subscriptions.after,
      limit,
    });
    for (const row of rows) {
      await fillOne(deps, report, row);
    }
    // The `after` cursor is what steps past a row that could not be filled: it
    // still has no start, so it would otherwise head every later page.
    const last = rows.at(-1);
    if (last !== undefined) report.cursor.subscriptions.after = last.stripeSubscriptionId;
    report.cursor.subscriptions.done = rows.length < limit;
    await progress();
  }
}

function intervalOf(maps: StripePriceMaps, priceId: string): BillingInterval | null {
  return Object.hasOwn(maps.priceToInterval, priceId)
    ? (maps.priceToInterval[priceId] ?? null)
    : null;
}

async function fillOne(
  deps: StripePeriodBackfillDeps,
  report: StripePeriodBackfillReport,
  row: { stripeSubscriptionId: string; stripePriceId: string; currentPeriodEnd: Date | null },
): Promise<void> {
  const counts = report.subscriptions;
  counts.seen += 1;
  const billingInterval = intervalOf(deps.maps, row.stripePriceId);

  let fromStripe: Date | null = null;
  try {
    fromStripe = readSubscriptionPeriodStart(
      await deps.stripe.getSubscription(row.stripeSubscriptionId),
    );
  } catch (err) {
    // "Stripe does not know it" is an answer. Anything else is not, and stops the run.
    if (!isStripeNotFound(err)) throw err;
  }

  if (fromStripe !== null) {
    const { filled } = await deps.repo.fillSubscriptionPeriodStart({
      stripeSubscriptionId: row.stripeSubscriptionId,
      currentPeriodStart: fromStripe,
      source: 'stripe',
      billingInterval,
    });
    if (filled) {
      counts.filledFromStripe += 1;
      return;
    }
    // Stripe's period is not the stored one (the mirror is behind). Deriving
    // from the stored end is still right FOR the stored end, so fall through.
  }

  if (row.currentPeriodEnd !== null && billingInterval !== null) {
    const { filled } = await deps.repo.fillSubscriptionPeriodStart({
      stripeSubscriptionId: row.stripeSubscriptionId,
      currentPeriodStart: addUtcMonths(row.currentPeriodEnd, billingInterval === 'year' ? -12 : -1),
      source: 'derived',
      billingInterval,
    });
    if (filled) {
      counts.filledDerived += 1;
      return;
    }
  }
  counts.notFilled += 1;
}
