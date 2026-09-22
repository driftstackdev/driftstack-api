// No write on the Stripe dispatch path may be additive.
//
// `StripeWebhooksService.handle` runs `dispatch(event)` BEFORE the
// `INSERT … ON CONFLICT DO NOTHING` whose `inserted` flag resolves a concurrent
// delivery. The comment there is accurate about what that flag does — it decides
// which delivery OWNS the event — but it is worth being exact about what it does
// not do: under a real race both deliveries have already executed the side
// effects. Only the reported outcome is deduped.
//
// That is safe today, and for a specific reason rather than by luck: every handler
// on the path is an upsert or a set — `upsertSubscription`, `setAccountTier`,
// `activateCryptoEntitlement` under a row lock with documented lock ordering — so
// running it twice lands on the same state. Measured when the SQL-level replay
// guard was written: eleven write statements across the two files, seven `.set(`
// calls, zero additive writes.
//
// Writes are not the only side effect on this path, and the sentence above used to
// read as though they were. `dispatch` also SENDS EMAIL: `invoice.payment_succeeded`
// and `invoice.payment_failed` call into AccountLifecycleService, and a send is not
// an upsert — under the same race both deliveries would send. That is safe by a
// different mechanism entirely, in a different file: the C6 `claimBillingEmail`
// INSERT … ON CONFLICT DO NOTHING taken BEFORE each send, enforced by
// `every-lifecycle-email-is-send-once.test.ts`. Said here because a reader
// checking whether this race is safe should not conclude from this file that
// writes are the whole question.
//
// Which is also why the scan below follows the call, not the file. `dispatch`
// reaches exactly two collaborators that WRITE — `this.repo` and
// `this.accountLifecycle` — and an accumulation behind the second would double
// under this race while being invisible to a scan of the first. Both are in scope.
// Measured on adding them: account-lifecycle contributes 3 writes and 2 `.set(`
// calls, zero additive.
//
// Following the call went one step further when paid invoices were recorded. The
// statement that writes `billing_invoice_payments` is in the repo, but the VALUES
// it writes on a second sighting are computed somewhere else: the merge rule in
// `lib/invoice-payment-record.ts`, from facts read by `lib/stripe-billing-facts.ts`.
// A rule there that summed the two sightings' amounts would double under this race
// with the repo's own text unchanged, and this scan — four files, listed by hand —
// would not have looked. Both are in scope now.
//
// And the list is no longer only remembered. The last arm reads what the two Stripe
// files IMPORT and requires every one of this server's source files among them to
// be either scanned or left out for a stated reason, so the next collaborator is a
// decision somebody makes rather than a file nobody scanned.
//
// The property is therefore CONDITIONAL, and nothing enforced the condition. Add
// one `balance = balance + delta` to a handler and the documented, accepted race
// silently becomes a double-credit — with the idempotency test still green,
// because that test asserts the flag, not the arithmetic.
//
// Scope is deliberately the Stripe dispatch path only. The NowPayments/crypto IPN
// path has its own idempotency and its own race analysis; asserting over it here
// would make this guard about a property it has not established.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const DISPATCH_PATH_FILES = [
  'services/stripe-webhooks.ts',
  'db/stripe-webhooks-repo.ts',
  // Reached from dispatch via `this.accountLifecycle.emit` on the two invoice
  // events. An additive write here runs twice under the same race.
  'services/account-lifecycle.ts',
  'db/account-lifecycle-repo.ts',
  // Reached from `repo.upsertInvoicePayment`. What a later sighting of a paid
  // invoice writes is decided by the merge rule in the first of these, from the
  // facts the second reads out of the payload.
  'lib/invoice-payment-record.ts',
  'lib/stripe-billing-facts.ts',
  // Imported for a value by one of the two Stripe files, and small enough to scan
  // rather than argue about.
  'lib/report-unlinkable-invoice.ts',
  'db/subscription-status-sets.ts',
  // Reached from the subscription and paid-invoice handlers while AI credits are
  // switched on: each ends by refreshing the account's monthly credits. A grant
  // is an INSERT, which this line detector cannot see at all, so what makes it
  // safe to run twice is stated where it is called (`refreshCredits` in
  // stripe-webhooks.ts) and PROVED as a race against Postgres in
  // two-refreshes-of-one-account-at-once-grant-the-month-exactly-once: the
  // account's credit lock runs the two deliveries one after the other, and the
  // database refuses a second window over the same time and a second funding row
  // for the same lot. Scanned here all the same, for the shape this detector
  // does see.
  'services/credit-grants.ts',
  // S17 — reached from the three reversal events (`charge.refunded`,
  // `charge.dispute.*`) while AI credits are on. What makes each of its writes
  // safe to run twice is stated in its header: every ledger row is keyed, the
  // clawback row is unique on (source, source_ref, target_key), the refund's
  // cumulative is compared under the account lock and written only when it
  // rose, and a level change is conditional on the step it was read at.
  'services/credit-clawbacks.ts',
] as const;

/** The two files whose imports define the path: the handlers, and the writes behind them. */
const STRIPE_DISPATCH_ROOTS = [
  'services/stripe-webhooks.ts',
  'db/stripe-webhooks-repo.ts',
] as const;

/**
 * Source files the two roots import that are NOT scanned, each with the reason. A
 * file earns a place here by being unable to hold a write that runs twice — not by
 * tripping the detector. The list may only name files that are really imported.
 */
const IMPORTED_BUT_NOT_SCANNED = new Map<string, string>([
  ['lib/logger.ts', 'type only — a log line is not a write'],
  [
    'lib/sentry.ts',
    'type only — an alert is not a write. Two racing deliveries may both alert; one issue per reason absorbs it',
  ],
  [
    'lib/transient-error.ts',
    'classifies an error that was thrown; nothing it computes is written (its loop counter trips a line detector built for handlers)',
  ],
  [
    'services/auth-cache.ts',
    'type only — invalidation deletes a cache entry, and deleting it twice is deleting it once',
  ],
  [
    'services/crypto-tier-activation.ts',
    'two pure rank helpers are imported from it; the rest is the crypto IPN path, which this guard deliberately does not judge (see the header)',
  ],
  ['db/client.ts', 'type only — the database handle'],
  [
    'db/schema.ts',
    'table definitions: no handler lives here, and a CHECK that adds an interval reads as accumulation to a line detector',
  ],
]);

/** This server's source files that `rel` imports — static, re-exported or dynamic; type or value. */
function importedSourceFiles(rel: string): string[] {
  const here = dirname(resolve(SRC, rel));
  return [
    ...codeOnly(read(rel)).matchAll(/(?:\bfrom|\bimport\s*\()\s*'(\.{1,2}\/[^']+)\.js'/g),
  ].map((m) => relative(SRC, resolve(here, `${m[1] ?? ''}.ts`)));
}

/**
 * An additive write: a column read back into its own update, a compound
 * assignment, or an explicitly named increment. Matches the SHAPE of accumulation
 * rather than any particular column, so a new balance-like field is covered the
 * day it appears.
 */
const ADDITIVE = /sql`[^`]*\$\{[^}]*\}\s*[+-]|[+-]=\s|\bincrement\b|\bdecrement\b/;

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

describe('Stripe dispatch path carries no additive write', () => {
  it('the detector detects — a guard whose pattern matches nothing would pass forever', () => {
    // Anti-vacuity on the INSTRUMENT, which is the part that silently rots. Both
    // directions: it must catch the shapes that would break the race analysis, and
    // must ignore the ordinary writes that fill these files.
    expect(
      ADDITIVE.test('.set({ balanceMinutes: sql`${accounts.balanceMinutes} + ${delta}` })'),
    ).toBe(true);
    expect(ADDITIVE.test('totalCredits += args.amount;')).toBe(true);
    expect(ADDITIVE.test('.set({ tier: args.tier, updatedAt: now })')).toBe(false);
    expect(ADDITIVE.test('const label = prefix + suffix;')).toBe(false);
  });

  it('the scan reaches real files with real writes, so "clean" means checked rather than not looked', () => {
    const writes = DISPATCH_PATH_FILES.reduce(
      (n, rel) => n + (read(rel).match(/\.(insert|update)\(/g)?.length ?? 0),
      0,
    );
    // Floors below the measured 14 writes / 9 sets, so ordinary edits do not trip
    // them while a scan that stopped seeing the files does.
    expect(writes, 'write statements found on the dispatch path').toBeGreaterThanOrEqual(10);
    expect(read('db/stripe-webhooks-repo.ts')).toContain('onConflictDoNothing');
    // Per-file, because a total floor is satisfied by the Stripe pair alone: the
    // lifecycle files could stop contributing entirely and the sum would still
    // clear it, leaving the extension above decorative.
    expect(
      read('db/account-lifecycle-repo.ts').match(/\.(insert|update)\(/g)?.length ?? 0,
      'the lifecycle repo stopped contributing writes, so extending the scan to it now proves nothing',
    ).toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL no additive write exists on the path. dispatch() runs BEFORE the idempotency insert, so a concurrent delivery executes every handler twice — that is only harmless while each one is an upsert or a set. One accumulation here turns an accepted race into a double-credit, and the idempotency test stays green because it asserts the flag, not the arithmetic.', () => {
    const offenders: string[] = [];
    for (const rel of DISPATCH_PATH_FILES) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (ADDITIVE.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    expect(offenders, 'additive write(s) on a path that runs twice under a race').toEqual([]);
  });

  it('CRITICAL every source file the two Stripe dispatch files import is scanned, or left out for a stated reason. The scan above is a hand-written list, and a hand-written list is silent about whatever is not on it: recording paid invoices moved the arithmetic of a dispatch-path write into a new file, and the list did not notice. A new collaborator now fails HERE until somebody decides which it is.', () => {
    const imported = new Set(STRIPE_DISPATCH_ROOTS.flatMap(importedSourceFiles));
    // Anti-vacuity: the reader really reads imports — from both files, whether
    // they are imported for a type, for a value, or split over several lines.
    expect(imported.size, 'imports found in the two Stripe dispatch files').toBeGreaterThanOrEqual(
      10,
    );
    expect([...imported]).toEqual(
      expect.arrayContaining([
        'services/account-lifecycle.ts',
        'lib/invoice-payment-record.ts',
        'db/schema.ts',
      ]),
    );

    const scanned = new Set<string>(DISPATCH_PATH_FILES);
    const undecided = [...imported]
      .filter((f) => !scanned.has(f) && !IMPORTED_BUT_NOT_SCANNED.has(f))
      .sort();
    expect(
      undecided,
      'imported on the Stripe dispatch path, and neither scanned for additive writes nor left out ' +
        'for a stated reason — add each to DISPATCH_PATH_FILES, or to IMPORTED_BUT_NOT_SCANNED with why ' +
        'it cannot hold a write that runs twice:',
    ).toEqual([]);

    const stale = [...IMPORTED_BUT_NOT_SCANNED.keys()].filter((f) => !imported.has(f)).sort();
    expect(stale, 'left out of the scan, but no longer imported by either file:').toEqual([]);
    const both = [...IMPORTED_BUT_NOT_SCANNED.keys()].filter((f) => scanned.has(f)).sort();
    expect(both, 'both scanned and excused — one of the two entries is wrong:').toEqual([]);
  });
});
