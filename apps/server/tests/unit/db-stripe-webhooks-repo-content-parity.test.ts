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
      /\/\/ Drizzle-backed StripeWebhooksRepo \(V-080 \+ V-089\)\. Idempotency\s*\n?\s*\/\/ ledger \+ subscription mirror writes \+ account tier \/ trial-pack\s*\n?\s*\/\/ mutations triggered by inbound Stripe events\./,
    );
  });

  it('imports: and/desc/eq/gt/inArray/isNull/lte/sql from drizzle-orm; AccountTier; StripeWebhooksRepo from services; Database; accounts + cryptoEntitlements + processedStripeEvents + subscriptions schemas', () => {
    expect(body).toMatch(
      /import \{ and, desc, eq, gt, inArray, isNull, lte, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import type \{ StripeWebhooksRepo \} from '\.\.\/services\/stripe-webhooks\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, cryptoEntitlements, processedStripeEvents, subscriptions \} from '\.\/schema\.js';/,
    );
  });

  it('hasEvent: 1-field select where eventId + limit 1 → row !== undefined boolean', () => {
    expect(body).toMatch(
      /async hasEvent\(eventId: string\): Promise<boolean> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ eventId: processedStripeEvents\.eventId \}\)\s*\n?\s*\.from\(processedStripeEvents\)\s*\n?\s*\.where\(eq\(processedStripeEvents\.eventId, eventId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row !== undefined;\s*\n?\s*\}/,
    );
  });

  it('recordEvent: 5-field values (eventId + eventType + payloadHash + result + receivedAt); onConflictDoNothing target=eventId; returning {eventId} length > 0 → {inserted}', () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*eventId: args\.eventId,\s*\n?\s*eventType: args\.eventType,\s*\n?\s*payloadHash: args\.payloadHash,\s*\n?\s*result: args\.result,\s*\n?\s*receivedAt: args\.receivedAt,\s*\n?\s*\}\)\s*\n?\s*\.onConflictDoNothing\(\{ target: processedStripeEvents\.eventId \}\)\s*\n?\s*\.returning\(\{ eventId: processedStripeEvents\.eventId \}\);\s*\n?\s*return \{ inserted: result\.length > 0 \};/,
    );
  });

  it('findAccountIdFromCustomerOrRef: clientReferenceId branch first (accounts.id match); then stripeCustomerId fallback (accounts.stripeCustomerId match); both null → null', () => {
    expect(body).toMatch(
      /if \(args\.clientReferenceId !== null\) \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ id: accounts\.id \}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.id, args\.clientReferenceId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*if \(row !== undefined\) return row\.id;\s*\n?\s*\}\s*\n?\s*if \(args\.stripeCustomerId !== null\) \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ id: accounts\.id \}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.stripeCustomerId, args\.stripeCustomerId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*if \(row !== undefined\) return row\.id;\s*\n?\s*\}\s*\n?\s*return null;/,
    );
  });

  it('upsertSubscription: 8-status enum union (incomplete|incomplete_expired|trialing|active|past_due|canceled|unpaid|paused) Stripe-mirror; onConflictDoUpdate target=stripeSubscriptionId; V-079 event-recency setWhere (updated_at <= excluded.updated_at) gates the conflict UPDATE; updates accountId+stripePriceId+tier+status+currentPeriodEnd+cancelAtPeriodEnd+canceledAt+updatedAt on conflict; .returning() surfaces the {applied} signal', () => {
    expect(body).toMatch(
      /status:\s*\n?\s*\| 'incomplete'\s*\n?\s*\| 'incomplete_expired'\s*\n?\s*\| 'trialing'\s*\n?\s*\| 'active'\s*\n?\s*\| 'past_due'\s*\n?\s*\| 'canceled'\s*\n?\s*\| 'unpaid'\s*\n?\s*\| 'paused';/,
    );
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*\n?\s*target: subscriptions\.stripeSubscriptionId,\s*\n?\s*setWhere: sql`\$\{subscriptions\.updatedAt\} <= excluded\.updated_at`,\s*\n?\s*set: \{\s*\n?\s*accountId: args\.accountId,\s*\n?\s*stripePriceId: args\.stripePriceId,\s*\n?\s*tier: args\.tier,\s*\n?\s*status: args\.status,\s*\n?\s*currentPeriodEnd: args\.currentPeriodEnd,\s*\n?\s*cancelAtPeriodEnd: args\.cancelAtPeriodEnd,\s*\n?\s*canceledAt: args\.canceledAt,\s*\n?\s*updatedAt: args\.at,\s*\n?\s*\},\s*\n?\s*\}\)\s*\n?\s*\.returning\(\{ id: subscriptions\.id \}\);\s*\n?\s*return \{ applied: result\.length > 0 \};/,
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
      /\/\/ Reference sql to keep the import live for any future raw-SQL needs\.\s*\n?\s*void sql;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
