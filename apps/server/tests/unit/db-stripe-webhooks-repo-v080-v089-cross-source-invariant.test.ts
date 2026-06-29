// W1003 — db/stripe-webhooks-repo V-080 + V-089 cross-source
// invariant. Three-hundred-twenty-ninth in the drift-guard series.
// Pins the apps/server/src/db/stripe-webhooks-repo.ts Drizzle
// Stripe-webhooks repo primitive:
//
//   V-080 + V-089 anchor — 'Drizzle-backed StripeWebhooksRepo
//   (V-080 + V-089). Idempotency ledger + subscription mirror writes
//   + account tier / trial-pack mutations triggered by inbound Stripe
//   events'.
//
//   6-method surface:
//     - hasEvent(eventId): idempotency check.
//     - recordEvent(args): insert into processedStripeEvents with
//       onConflictDoNothing(eventId).
//     - findAccountIdFromCustomerOrRef(args): 2-path account lookup.
//     - upsertSubscription(args): subscription mirror upsert via
//       onConflictDoUpdate(stripeSubscriptionId).
//     - setAccountTier(args): tier swap with previousTier capture.
//     - applyTrialPackPurchase(args): ADR-003 trial-pack apply with
//       isNull(trialPackPurchasedAt) once-per-account guard.
//
//   recordEvent uses onConflictDoNothing(target: eventId) + returning
//     ({eventId}).length > 0 boolean. The inserted-or-not signal lets
//     the service decide whether to process the event.
//
//   findAccountIdFromCustomerOrRef 2-path lookup framing — try
//     clientReferenceId first (eq(accounts.id)), then stripeCustomerId
//     (eq(accounts.stripeCustomerId)). The 2-path order matches Stripe
//     webhook payload conventions (Checkout sets client_reference_id;
//     ongoing invoices use customer-id).
//
//   upsertSubscription 9-field SET clause — accountId + stripePriceId
//     + tier + status + currentPeriodEnd + cancelAtPeriodEnd +
//     canceledAt + updatedAt (no stripeSubscriptionId in SET — it's
//     the conflict target).
//
//   setAccountTier captures previousTier from SELECT before UPDATE +
//     returns { previousTier }. The previous-then-update sequence
//     gives services material to log/audit the transition.
//
//   applyTrialPackPurchase ADR-003 once-per-account framing —
//     'Conditional update: only set trial-pack fields if not already
//     set (trial_pack_purchased_at IS NULL). Returning + length tells
//     us whether the row was actually mutated'.
//
//   applyTrialPackPurchase 5-field SET — trialPackPurchasedAt +
//     trialPackCreditCents + trialPackExpiresAt + trialPackRedeemed
//     (=false) + updatedAt.
//
//   8-value subscription status union — incomplete + incomplete_
//     expired + trialing + active + past_due + canceled + unpaid +
//     paused.
//
// stays in lockstep across apps/server/src/db/stripe-webhooks-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1003 db/stripe-webhooks-repo V-080 + V-089 cross-source invariant', () => {
  // ─── V-080 + V-089 anchor ────────────────────────────────────

  it("CRITICAL apps/server/src/db/stripe-webhooks-repo.ts header pins V-080 + V-089 — 'Drizzle-backed StripeWebhooksRepo (V-080 + V-089). Idempotency ledger + subscription mirror writes + account tier / trial-pack mutations triggered by inbound Stripe events'. The 3-responsibility (ledger + mirror + mutation) design is the V-080+V-089 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed StripeWebhooksRepo \(V-080 \+ V-089\)\./);
    expect(p).toMatch(/Idempotency/);
    expect(p).toMatch(/\/\/ ledger \+ subscription mirror writes \+ account tier \/ trial-pack/);
    expect(p).toMatch(/\/\/ mutations triggered by inbound Stripe events\./);
    expect(p).toMatch(/export class DrizzleStripeWebhooksRepo implements StripeWebhooksRepo \{/);
  });

  // ─── 6-method surface ────────────────────────────────────────

  it('CRITICAL 5-method surface — hasEvent + recordEvent + findAccountIdFromCustomerOrRef + upsertSubscription + setAccountTier (applyTrialPackPurchase removed 2026-05-27). The 5-method shape covers the full Stripe-webhook side-effect set.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/async hasEvent\(eventId: string\): Promise<boolean> \{/);
    expect(p).toMatch(/async recordEvent\(args: \{/);
    expect(p).toMatch(/async findAccountIdFromCustomerOrRef\(args: \{/);
    expect(p).toMatch(/async upsertSubscription\(args: \{/);
    expect(p).toMatch(/async setAccountTier\(args: \{/);
    expect(p).not.toMatch(/applyTrialPackPurchase/);
  });

  // ─── hasEvent narrow projection ──────────────────────────────

  it("CRITICAL hasEvent uses narrow projection — '.select({eventId: processedStripeEvents.eventId})' + 'return row !== undefined'. The narrow select keeps the idempotency check cheap.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\.select\(\{ eventId: processedStripeEvents\.eventId \}\)/);
    expect(p).toMatch(/\.where\(eq\(processedStripeEvents\.eventId, eventId\)\)/);
    expect(p).toMatch(/return row !== undefined;/);
  });

  // ─── recordEvent onConflictDoNothing + boolean ───────────────

  it('CRITICAL recordEvent uses onConflictDoNothing(target: eventId) + returning({eventId}).length > 0 → {inserted}. The idempotent-insert signal lets the service decide whether to process the Stripe event.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\.onConflictDoNothing\(\{ target: processedStripeEvents\.eventId \}\)/);
    expect(p).toMatch(/\.returning\(\{ eventId: processedStripeEvents\.eventId \}\);/);
    expect(p).toMatch(/return \{ inserted: result\.length > 0 \};/);
  });

  it('CRITICAL recordEvent 5-field values — eventId + eventType + payloadHash + result + receivedAt. The 5-field ledger row covers the V-080 idempotency-evidence shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/eventId: args\.eventId,/);
    expect(p).toMatch(/eventType: args\.eventType,/);
    expect(p).toMatch(/payloadHash: args\.payloadHash,/);
    expect(p).toMatch(/result: args\.result,/);
    expect(p).toMatch(/receivedAt: args\.receivedAt,/);
  });

  // ─── findAccountIdFromCustomerOrRef 2-path ───────────────────

  it('CRITICAL findAccountIdFromCustomerOrRef 2-path lookup — clientReferenceId first (eq(accounts.id)), then stripeCustomerId (eq(accounts.stripeCustomerId)), else null. The 2-path order matches Stripe Checkout-then-invoice payload conventions.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/if \(args\.clientReferenceId !== null\) \{/);
    expect(p).toMatch(/\.where\(eq\(accounts\.id, args\.clientReferenceId\)\)/);
    expect(p).toMatch(/if \(args\.stripeCustomerId !== null\) \{/);
    expect(p).toMatch(/\.where\(eq\(accounts\.stripeCustomerId, args\.stripeCustomerId\)\)/);
    expect(p).toMatch(/return null;/);
  });

  // ─── upsertSubscription onConflictDoUpdate ───────────────────

  it('CRITICAL upsertSubscription onConflictDoUpdate target = stripeSubscriptionId. The conflict-on-stripeSubscriptionId enforces 1-mirror-per-Stripe-subscription uniqueness.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\.onConflictDoUpdate\(\{/);
    expect(p).toMatch(/target: subscriptions\.stripeSubscriptionId,/);
    expect(p).toMatch(/set: \{/);
  });

  it("CRITICAL upsertSubscription SET 8-field — accountId + stripePriceId + tier + status + currentPeriodEnd + cancelAtPeriodEnd + canceledAt + updatedAt. The SET excludes stripeSubscriptionId (it's the conflict target).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    // SET clause field names (anchored on ` set: {` then closing `},` of the
    // onConflictDoUpdate object — which is now followed by `)` then a chained
    // `.returning(...)` for the V-079 event-recency `applied` signal).
    const setMatch = p.match(/set: \{([\s\S]+?)\},\s*\}\)\s*\.returning\(/);
    expect(setMatch).toBeTruthy();
    const setBlock = setMatch?.[1] ?? '';
    expect(setBlock).toMatch(/accountId: args\.accountId,/);
    expect(setBlock).toMatch(/stripePriceId: args\.stripePriceId,/);
    expect(setBlock).toMatch(/tier: args\.tier,/);
    expect(setBlock).toMatch(/status: args\.status,/);
    expect(setBlock).toMatch(/currentPeriodEnd: args\.currentPeriodEnd,/);
    expect(setBlock).toMatch(/cancelAtPeriodEnd: args\.cancelAtPeriodEnd,/);
    expect(setBlock).toMatch(/canceledAt: args\.canceledAt,/);
    expect(setBlock).toMatch(/updatedAt: args\.at,/);
  });

  // ─── 8-value subscription status union ───────────────────────

  it("CRITICAL 8-value subscription status union — 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'. The 8-status union matches Stripe's Subscription status enum.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\| 'incomplete'/);
    expect(p).toMatch(/\| 'incomplete_expired'/);
    expect(p).toMatch(/\| 'trialing'/);
    expect(p).toMatch(/\| 'active'/);
    expect(p).toMatch(/\| 'past_due'/);
    expect(p).toMatch(/\| 'canceled'/);
    expect(p).toMatch(/\| 'unpaid'/);
    expect(p).toMatch(/\| 'paused';/);
  });

  // ─── setAccountTier previousTier capture ─────────────────────

  it('CRITICAL setAccountTier reads previousTier from SELECT before UPDATE + returns { previousTier }, now ATOMIC under a FOR UPDATE row lock (transaction) so concurrent same-event deliveries do not double-emit. The before-then-update sequence gives services material for audit logging tier transitions.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(p).toMatch(/const before = await tx/);
    expect(p).toMatch(/\.for\('update'\)/);
    expect(p).toMatch(/\.select\(\{ tier: accounts\.tier \}\)/);
    expect(p).toMatch(/const previousTier = before\[0\]\?\.tier \?\? null;/);
    expect(p).toMatch(/\.update\(accounts\)/);
    expect(p).toMatch(/\.set\(\{ tier: args\.tier, updatedAt: args\.at \}\)/);
    expect(p).toMatch(/return \{ previousTier \};/);
  });

  // ─── applyTrialPackPurchase ADR-003 once-per-account ─────────

  // ─── void sql keepalive ──────────────────────────────────────

  it("CRITICAL 'void sql;' at module bottom keeps sql import live — 'Reference sql to keep the import live for any future raw-SQL needs'. The pragma avoids 'unused import' lint without a TODO marker.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/stripe-webhooks-repo.ts'));
    expect(p).toMatch(/\/\/ Reference sql to keep the import live for any future raw-SQL needs\./);
    expect(p).toMatch(/void sql;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-stripe-webhooks-repo-v080-v089-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
