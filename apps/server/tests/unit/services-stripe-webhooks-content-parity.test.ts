// W406.B — drift guard for apps/server/src/services/stripe-webhooks.ts.
// Inbound Stripe webhook handler. V-089 idempotency via
// processed_stripe_events ledger; V-202b lifecycle dispatch; V-082
// trial-pack provisioning. Drift here either breaks the 3-day
// re-delivery idempotency window (double-charge / double-email) or
// bypasses the tier-change short-circuit (Stripe sends
// subscription.updated for non-tier mutations).
//
//   • V-089 framing pinned: processed_stripe_events ledger +
//     duplicate short-circuit at 200 OK + 3-day re-delivery window.
//   • Signature verification is route's responsibility (route holds
//     raw body); service receives parsed verified event.
//   • DispatchOutcome 3-union: 'handled' | 'ignored' | `error:${string}`.
//   • DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299 (per ADR-003 $2.99);
//     DEFAULT_TRIAL_PACK_WINDOW_MS = 14 days.
//   • STATUS_VALUES: 8-literal Stripe subscription status enum
//     (incomplete / incomplete_expired / trialing / active /
//     past_due / canceled / unpaid / paused).
//   • handle(): hasEvent short-circuit → 'duplicate'; concurrent-
//     duplicate-race resolved via recordEvent.inserted flag.
//   • handleSubscriptionUpsert: tier change only on active|trialing;
//     V-202b dispatches subscription.tier_changed lifecycle event
//     when wired (audit + tier-changed email at one call site).
//   • handleSubscriptionDeleted: downgrade default 'trial_pack' (V-
//     202b cancel handler).
//   • V-082 handleCheckoutCompleted: payment-mode → trial-pack
//     provision via client_reference_id or customer lookup;
//     dispatches subscription.trial_pack_purchased lifecycle only
//     on first apply (idempotency gate).
//   • V-202d trial_pack.expired scheduled-job enqueue on first
//     apply (dedupOnAccountAndType prevents dup-enqueue across
//     Stripe redelivery).
//   • V-327 handleInvoiceUpcoming: decode amount+currency+customer
//     → dispatch subscription.renewal_reminder lifecycle event
//     (~7d before renewal); bails silently on missing fields /
//     unknown customer.
//   • Invoice events V-202b decision: receipt emails fire from
//     Stripe (Driftstack-branded receipts deferred — TD-001);
//     payment_succeeded / payment_failed / finalized handled+logged
//     without email side.
//   • dispatch try/catch: errors → error:<short> outcome, ledger
//     still records, Stripe gets 200 (retrying won't help if code
//     bug).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W406.B apps/server/src/services/stripe-webhooks.ts content parity', () => {
  const body = read(LIB);

  it('V-089 framing pinned: processed_stripe_events ledger + duplicate short-circuit + 3-day re-delivery window', () => {
    expect(body).toMatch(
      /Idempotency — `processed_stripe_events` records each handled\s*\n?\s*\/\/\s*`event\.id`\. Duplicates short-circuit at 200 OK without re-running\s*\n?\s*\/\/\s*the handler\. Stripe re-delivers within 3 days; the table is the\s*\n?\s*\/\/\s*durable record of "we've already seen this\."/,
    );
    expect(body).toMatch(
      /Signature verification is the route's job \(it has the raw body\); this\s*\n?\s*\/\/\s*service receives a verified, parsed event\./,
    );
  });

  it('DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299 (ADR-003); DEFAULT_TRIAL_PACK_WINDOW_MS = 14 days', () => {
    expect(body).toMatch(/const DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299;/);
    expect(body).toMatch(/const DEFAULT_TRIAL_PACK_WINDOW_MS = 14 \* 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(/Trial-pack credit cents \(default 299 = \$2\.99 per ADR-003\)\./);
    expect(body).toMatch(
      /Trial-pack window length in milliseconds \(default 14 days per ADR-003\)\./,
    );
  });

  it('STATUS_VALUES: 8-literal Stripe subscription status enum (incomplete|incomplete_expired|trialing|active|past_due|canceled|unpaid|paused)', () => {
    expect(body).toMatch(
      /const STATUS_VALUES = \[\s*\n?\s*'incomplete',\s*\n?\s*'incomplete_expired',\s*\n?\s*'trialing',\s*\n?\s*'active',\s*\n?\s*'past_due',\s*\n?\s*'canceled',\s*\n?\s*'unpaid',\s*\n?\s*'paused',\s*\n?\s*\] as const;/,
    );
  });

  it("DispatchOutcome: 'handled' | 'ignored' | `error:${string}` template-literal union", () => {
    expect(body).toMatch(
      /export type DispatchOutcome = 'handled' \| 'ignored' \| `error:\$\{string\}`;/,
    );
  });

  it("handle(): hasEvent short-circuit → 'duplicate'; concurrent-duplicate-race resolved via recordEvent.inserted flag", () => {
    expect(body).toMatch(
      /if \(await this\.repo\.hasEvent\(event\.id\)\) \{[\s\S]+?'duplicate Stripe event — short-circuit',\s*\n?\s*\);\s*\n?\s*return 'duplicate';/,
    );
    expect(body).toMatch(
      /\/\/ Race: a concurrent delivery could insert the same row between our\s*\n?\s*\/\/ hasEvent check above and this insert\. recordEvent's `inserted` flag\s*\n?\s*\/\/ resolves the race — if false, the other delivery handled it first\./,
    );
    expect(body).toMatch(
      /if \(!inserted\) \{[\s\S]+?'concurrent duplicate — other delivery won the race',\s*\n?\s*\);\s*\n?\s*return 'duplicate';/,
    );
  });

  it('dispatch try/catch: handler throws → error:<short> outcome; ledger records with error marker; Stripe gets 200', () => {
    expect(body).toMatch(
      /Route the event to its handler\. Returns `'handled' \| 'ignored' \|\s*\n?\s*\*\s*'error:<short>'`\. Errors from handlers are caught and surfaced as\s*\n?\s*\*\s*the `error:` outcome[\s\S]+?retrying via Stripe won't\s*\n?\s*\*\s*help if it's a code bug/,
    );
    expect(body).toMatch(/return `error:\$\{code\}`;/);
  });

  it('V-202b handleSubscriptionUpsert: tier change only on active|trialing; lifecycle dispatch when wired', () => {
    expect(body).toMatch(
      /case 'customer\.subscription\.created':\s*\n?\s*case 'customer\.subscription\.updated':\s*\n?\s*return await this\.handleSubscriptionUpsert\(event\);/,
    );
    expect(body).toMatch(
      /\/\/ Tier change only when the subscription is in an active-paying\s*\n?\s*\/\/ state\. Trialing counts as active for our purposes \(the customer\s*\n?\s*\/\/ gets the tier; Stripe handles the dunning\)\.\s*\n?\s*if \(tier !== undefined && \(status === 'active' \|\| status === 'trialing'\)\) \{/,
    );
    expect(body).toMatch(
      /\/\/ V-202b — lifecycle dispatcher fans this out into audit emit \+\s*\n?\s*\/\/ tier-changed email at one call site\./,
    );
    expect(body).toMatch(
      /await this\.accountLifecycle\.emit\(accountId, \{\s*\n?\s*kind: 'subscription\.tier_changed',\s*\n?\s*fromTier: previousTier,\s*\n?\s*toTier: tier,/,
    );
  });

  it("handleSubscriptionDeleted: downgrade default 'trial_pack'; cancel-handler dispatches tier_changed lifecycle", () => {
    expect(body).toMatch(
      /const downgradeTier = this\.config\.cancelDowngradeTier \?\? 'trial_pack';/,
    );
    expect(body).toMatch(
      /kind: 'subscription\.tier_changed',\s*\n?\s*fromTier: previousTier,\s*\n?\s*toTier: downgradeTier,/,
    );
  });

  it('V-327 handleInvoiceUpcoming: decode amount+currency+customer → dispatch subscription.renewal_reminder lifecycle; bails silently on missing/unknown', () => {
    expect(body).toMatch(
      /V-327 — `invoice\.upcoming` handler\. Decodes the invoice, resolves\s*\n?\s*\*\s*the customer to a local account, and dispatches the renewal_\s*\n?\s*\*\s*reminder lifecycle event\./,
    );
    expect(body).toMatch(/'invoice\.upcoming missing required fields; skipping renewal reminder',/);
    expect(body).toMatch(
      /kind: 'subscription\.renewal_reminder',\s*\n?\s*amountCents: amountDue,\s*\n?\s*currency,\s*\n?\s*renewalDate: renewalUnix,\s*\n?\s*stripeEventId: event\.id,\s*\n?\s*stripeInvoiceId,/,
    );
  });

  it('V-082 handleCheckoutCompleted: subscription mode informational (V-089 subscription.created does mirror write); payment mode → trial-pack via client_reference_id or customer fallback', () => {
    expect(body).toMatch(
      /\/\/ Subscription path: customer\.subscription\.created arrives separately\s*\n?\s*\/\/ and does the actual mirror write\. checkout\.session\.completed for\s*\n?\s*\/\/ subscription mode is informational here\./,
    );
    expect(body).toMatch(
      /\/\/ payment-mode → trial pack purchase per V-082 metadata convention\.\s*\n?\s*\/\/ We use client_reference_id as the source of truth; fall back to\s*\n?\s*\/\/ customer lookup if absent\./,
    );
  });

  it('V-202b trial-pack-purchased + V-202d trial_pack.expired enqueue: only when applied=true (first-apply idempotency); dedupOnAccountAndType', () => {
    expect(body).toMatch(
      /\/\/ V-202b — fire trial-pack-purchased email only on first apply\s*\n?\s*\/\/ \(the repo's idempotency gate ensures `applied=false` on a\s*\n?\s*\/\/ duplicate Stripe event re-delivery, so this skips correctly\)\./,
    );
    expect(body).toMatch(
      /if \(applied && this\.accountLifecycle !== null\) \{\s*\n?\s*await this\.accountLifecycle\.emit\(accountId, \{\s*\n?\s*kind: 'subscription\.trial_pack_purchased',/,
    );
    expect(body).toMatch(
      /\/\/ V-202d — schedule the expiry email at expiresAt\. dedupOnAccountAndType\s*\n?\s*\/\/ ensures one pending trial_pack\.expired job per account regardless\s*\n?\s*\/\/ of how many times the purchase webhook re-fires/,
    );
    expect(body).toMatch(
      /jobType: 'trial_pack\.expired',\s*\n?\s*accountId,\s*\n?\s*payload: \{ trial_pack_expires_at: expiresAt\.toISOString\(\) \},\s*\n?\s*runAt: expiresAt,\s*\n?\s*dedupOnAccountAndType: true,/,
    );
  });

  it('Invoice events V-202b decision: receipt emails fire from Stripe (Driftstack-branded receipts deferred — TD-001)', () => {
    expect(body).toMatch(
      /\/\/ V-202b decision \(founder verdict 2026-05-05\): receipt emails\s*\n?\s*\/\/ fire from Stripe's own infrastructure\. Driftstack-branded\s*\n?\s*\/\/ billing receipts deferred post-launch — see TD-001 in\s*\n?\s*\/\/ docs\/tech-debt\.md\./,
    );
    expect(body).toMatch(
      /case 'invoice\.payment_succeeded':\s*\n?\s*case 'invoice\.payment_failed':\s*\n?\s*case 'invoice\.finalized':/,
    );
  });

  it('ApplyTrialPackPurchase: idempotent — no-op when trial_pack_purchased_at already set; ADR-003 299¢/14d window framing', () => {
    expect(body).toMatch(
      /Provision a trial-pack purchase per ADR-003: 299¢ credit, 14-day\s*\n?\s*\*\s*window, redeemed=false\. Idempotent: if `trial_pack_purchased_at`\s*\n?\s*\*\s*is already set, no-op\./,
    );
    expect(body).toMatch(
      /applyTrialPackPurchase\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*creditCents: number;\s*\n?\s*expiresAt: Date;\s*\n?\s*at: Date;\s*\n?\s*\}\): Promise<\{ applied: boolean \}>;/,
    );
  });

  it('setAccountTier: returns previousTier so callers detect real change (V-226 audit emit only fires on previousTier !== new tier)', () => {
    expect(body).toMatch(
      /Returns the previous tier so callers can detect a real change\s*\n?\s*\*\s*\(V-226 audit emit only fires when previousTier !== new tier\)\./,
    );
    expect(body).toMatch(
      /setAccountTier\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*tier: AccountTier;\s*\n?\s*at: Date;\s*\n?\s*\}\): Promise<\{ previousTier: AccountTier \| null \}>;/,
    );
  });

  it('readSubscriptionPriceId helper: extracts subscription.items.data[0].price.id; null on missing/non-array', () => {
    expect(body).toMatch(
      /Subscription price id lives at `subscription\.items\.data\[0\]\.price\.id`\s*\n?\s*\*\s*in the Stripe object\./,
    );
    expect(body).toMatch(
      /function readSubscriptionPriceId\(sub: Record<string, unknown>\): string \| null \{\s*\n?\s*const items = sub\.items as \{ data\?: unknown \} \| undefined;\s*\n?\s*if \(!items \|\| !Array\.isArray\(items\.data\) \|\| items\.data\.length === 0\) return null;/,
    );
  });

  it("stripeStatusToLocal: unknown status defaults to 'incomplete' (defensive — accept any string but normalize)", () => {
    expect(body).toMatch(
      /function stripeStatusToLocal\(s: string\): LocalStatus \{\s*\n?\s*return \(STATUS_VALUES as readonly string\[\]\)\.includes\(s\) \? \(s as LocalStatus\) : 'incomplete';\s*\n?\s*\}/,
    );
  });

  it('imports: createHash + AccountTier + Logger + AccountLifecycleService + ScheduledJobsService types', () => {
    expect(body).toMatch(/import \{ createHash \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import type \{ AccountLifecycleService \} from '\.\/account-lifecycle\.js';/,
    );
    expect(body).toMatch(/import type \{ ScheduledJobsService \} from '\.\/scheduled-jobs\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
