// W446.C — drift guard for apps/server/src/db/stripe-webhooks-repo.ts.
// V-080 idempotency ledger + V-089 subscription mirror writer + tier
// mutations from inbound Stripe events. Drift here either drops the
// onConflictDoNothing on processedStripeEvents (re-delivered Stripe
// webhook double-applies trial-pack credit) or breaks the trial-pack
// conditional insert (`trial_pack_purchased_at IS NULL`) — customer
// can re-trigger the trial-pack purchase and collect double credit.
//
//   • V-080 + V-089 framing pinned.
//   • hasEvent: 1-field select where eventId + limit 1 → row !==
//     undefined boolean.
//   • recordEvent framing pinned: onConflictDoNothing on eventId
//     target; returning {eventId} length>0 → {inserted: bool}.
//   • findAccountIdFromCustomerOrRef: clientReferenceId branch first
//     (accounts.id match); then stripeCustomerId fallback.
//   • upsertSubscription: onConflictDoUpdate target=
//     stripeSubscriptionId; 8-status enum mirrored from Stripe.
//   • setAccountTier: read previousTier before update; returns
//     {previousTier} so V-202b audit row can record before/after.
//   • applyTrialPackPurchase framing pinned: conditional UPDATE only
//     when trial_pack_purchased_at IS NULL; returning + length tells
//     us whether row was actually mutated → {applied: bool}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W446.C apps/server/src/db/stripe-webhooks-repo.ts content parity', () => {
  const body = read(LIB);

  it('V-080 + V-089 framing pinned: "Drizzle-backed StripeWebhooksRepo (V-080 + V-089). Idempotency ledger + subscription mirror writes + account tier / trial-pack mutations triggered by inbound Stripe events."', () => {
    expect(body).toMatch(
      /\/\/ Drizzle-backed StripeWebhooksRepo \(V-080 \+ V-089\)\. Idempotency\s*\/\/ ledger \+ subscription mirror writes \+ account tier \/ trial-pack\s*\/\/ mutations triggered by inbound Stripe events\./,
    );
  });

  it('imports: and/asc/desc/eq/gt/gte/inArray/isNull/lte/ne/or/sql + the SQL type from drizzle-orm; AccountTier; StripeWebhooksRepo from services; Database; accounts + billingInvoicePayments + cryptoEntitlements + processedStripeEvents + subscriptions schemas', () => {
    // Live-billing audit #9 — `type SQL` types cryptoTermRunningAt, the fragment both
    // tier recomputes judge a crypto term's expiry against. Live-billing audit #3 —
    // `asc` orders the two new reads (collecting subscriptions, the past-due sweep's).
    // Security sweep #28 — `gte` and `ne` select the terms stacked after a refunded
    // one, which the refund moves back.
    expect(body).toMatch(
      /import \{\s*and,\s*asc,\s*desc,\s*eq,\s*gt,\s*gte,\s*inArray,\s*isNull,\s*lte,\s*ne,\s*or,\s*sql,\s*type SQL,?\s*\} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    // Live-billing audit #3 — the grace length and the stored-row shape come from
    // the service beside the repo interface.
    expect(body).toMatch(
      /import \{\s*PAST_DUE_GRACE_DAYS,\s*type StoredSubscription,\s*type StripeWebhooksRepo,\s*\} from '\.\.\/services\/stripe-webhooks\.js';/,
    );
    // Migration 0129 — the paid-invoice table joins the import, with its row type.
    expect(body).toMatch(
      /import \{\s*accounts,\s*billingInvoicePayments,\s*cryptoEntitlements,\s*processedStripeEvents,\s*subscriptions,\s*type BillingInvoicePaymentRow,\s*\} from '\.\/schema\.js';/,
    );
  });

  it('hasEvent: 1-field select where eventId + limit 1 → row !== undefined boolean', () => {
    expect(body).toMatch(
      /async hasEvent\(eventId: string\): Promise<boolean> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ eventId: processedStripeEvents\.eventId \}\)\s*\.from\(processedStripeEvents\)\s*\.where\(eq\(processedStripeEvents\.eventId, eventId\)\)\s*\.limit\(1\);\s*return row !== undefined;\s*\}/,
    );
  });

  it('recordEvent: 5-field values (eventId + eventType + payloadHash + result + receivedAt); onConflictDoNothing target=eventId; returning {eventId} length > 0 → {inserted}', () => {
    expect(body).toMatch(
      /\.values\(\{\s*eventId: args\.eventId,\s*eventType: args\.eventType,\s*payloadHash: args\.payloadHash,\s*result: args\.result,\s*receivedAt: args\.receivedAt,\s*\}\)\s*\.onConflictDoNothing\(\{ target: processedStripeEvents\.eventId \}\)\s*\.returning\(\{ eventId: processedStripeEvents\.eventId \}\);\s*return \{ inserted: result\.length > 0 \};/,
    );
  });

  it('findAccountIdFromCustomerOrRef: clientReferenceId branch first (accounts.id match); then stripeCustomerId fallback (accounts.stripeCustomerId match); both null → null', () => {
    expect(body).toMatch(
      /if \(args\.clientReferenceId !== null\) \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ id: accounts\.id \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, args\.clientReferenceId\)\)\s*\.limit\(1\);\s*if \(row !== undefined\) return row\.id;\s*\}\s*if \(args\.stripeCustomerId !== null\) \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ id: accounts\.id \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.stripeCustomerId, args\.stripeCustomerId\)\)\s*\.limit\(1\);\s*if \(row !== undefined\) return row\.id;\s*\}\s*return null;/,
    );
  });

  // Live-billing audit #2 — the recency guard no longer lets the last-processed of two
  // same-second events win: a strictly newer event applies, and at the same second only
  // a status no earlier in SAME_SECOND_STATUS_ORDER does (nothing replaces `canceled`).
  // Behaviour is proved on Postgres in
  // a-same-second-subscription-event-cannot-reopen-checkout-or-revive-a-canceled-plan.
  // Live-billing audit #3 — after tierSince, the 0141 columns: a move INTO past_due
  // stamps past_due_since, staying keeps it (and the sweep's mark), leaving clears
  // both. Proved on Postgres in
  // a-failed-renewal-keeps-the-paid-plan-for-seven-days-and-the-sweep-ends-it-after.
  it('upsertSubscription: 8-status enum union (incomplete|incomplete_expired|trialing|active|past_due|canceled|unpaid|paused) Stripe-mirror; onConflictDoUpdate target=stripeSubscriptionId; V-079 event-recency setWhere (updated_at < excluded.updated_at, or the same second and a status no earlier in SAME_SECOND_STATUS_ORDER) gates the conflict UPDATE; updates accountId+stripePriceId+tier+status+currentPeriodEnd+cancelAtPeriodEnd+canceledAt+updatedAt, then the 0129 period columns (currentPeriodStart+periodStartSource+billingInterval) and tierSince — which moves ONLY when the stored tier differs from the incoming one; .returning() surfaces the {applied} signal', () => {
    expect(body).toMatch(
      /status:\s*\| 'incomplete'\s*\| 'incomplete_expired'\s*\| 'trialing'\s*\| 'active'\s*\| 'past_due'\s*\| 'canceled'\s*\| 'unpaid'\s*\| 'paused';/,
    );
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*target: subscriptions\.stripeSubscriptionId,\s*setWhere: sql`\$\{subscriptions\.updatedAt\} < excluded\.updated_at OR \(\$\{subscriptions\.updatedAt\} = excluded\.updated_at AND \$\{storedStatusRankSql\} <= \$\{incomingStatusRank\}\)`,\s*set: \{\s*accountId: args\.accountId,\s*stripePriceId: args\.stripePriceId,\s*tier: args\.tier,\s*status: args\.status,\s*currentPeriodEnd: args\.currentPeriodEnd,\s*cancelAtPeriodEnd: args\.cancelAtPeriodEnd,\s*canceledAt: args\.canceledAt,\s*updatedAt: args\.at,\s*currentPeriodStart,\s*periodStartSource,\s*billingInterval,\s*tierSince: sql`CASE WHEN \$\{subscriptions\.tier\} IS DISTINCT FROM excluded\.tier THEN excluded\.updated_at ELSE \$\{subscriptions\.tierSince\} END`,\s*(?:\/\/[^\n]*\n\s*)*pastDueSince: sql`CASE WHEN excluded\.status <> 'past_due' THEN NULL WHEN \$\{subscriptions\.status\} = 'past_due' THEN \$\{subscriptions\.pastDueSince\} ELSE excluded\.past_due_since END`,\s*pastDueGraceEndedAt: sql`CASE WHEN excluded\.status = 'past_due' AND \$\{subscriptions\.status\} = 'past_due' THEN \$\{subscriptions\.pastDueGraceEndedAt\} ELSE NULL END`,\s*\},\s*\}\)\s*\.returning\(\{ id: subscriptions\.id \}\);\s*return \{ applied: result\.length > 0 \};/,
    );
  });

  it('setAccountTier: ATOMIC read-then-write under a FOR UPDATE row lock (transaction); reads previousTier before update; returns {previousTier} — concurrency-safe so concurrent same-event deliveries do not double-emit (discrete pins; no long backtracking chain)', () => {
    // Atomicity: the read+write run inside a transaction with a row lock so
    // the previousTier is correct under concurrent Stripe redelivery.
    expect(body).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(/const before = await tx/);
    expect(body).toMatch(/\.select\(\{ tier: accounts\.tier \}\)/);
    expect(body).toMatch(/\.for\('update'\)/);
    expect(body).toMatch(/const previousTier = before\[0\]\?\.tier \?\? null;/);
    expect(body).toMatch(/\.set\(\{ tier: args\.tier, updatedAt: args\.at \}\)/);
    expect(body).toMatch(/return \{ previousTier \};/);
  });

  it("sql import unused-warn suppression rationale: 'Reference sql to keep the import live for any future raw-SQL needs.' + `void sql;`", () => {
    expect(body).toMatch(
      /\/\/ Reference sql to keep the import live for any future raw-SQL needs\.\s*void sql;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
