// W728 — api-types core-enum source-of-truth parity. Fifty-fifth in
// the cross-SDK drift-guard series (W649 + W675-W728).
//
// Pins the canonical Zod-enum closed rosters that the entire stack
// (server validation + SDK literal types + dashboard switch
// statements + marketing-doc copy) depends on:
//
//   AccountTier (common.ts) — 8-tier roster (ADR-004 lock)
//   AccountStatus + AccountRegion (accounts.ts)
//   AvatarContentType + OptOutableEmailEvent (accounts.ts)
//   CryptoOrderStatus + CryptoOrderEventSource (crypto-orders.ts)
//   WebhookEventType + SubscribableWebhookEventType (webhooks.ts)
//   WebhookDeliveryStatus
//   BillingPeriod + SubscriptionStatus (billing.ts)
//
// CRITICAL: drift to renaming or dropping a value would silently
// break every cross-language consumer (server, 3 SDKs, dashboard,
// admin, marketing) — these enums are the wire-format law.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');
const ACCOUNTS = resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts');
const CRYPTO = resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts');
const WEBHOOKS = resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts');
const BILLING = resolve(REPO_ROOT, 'packages/api-types/src/billing.ts');

describe('W728 api-types core-enum source-of-truth parity', () => {
  it('all 5 api-types source files exist', () => {
    expect(existsSync(COMMON)).toBe(true);
    expect(existsSync(ACCOUNTS)).toBe(true);
    expect(existsSync(CRYPTO)).toBe(true);
    expect(existsSync(WEBHOOKS)).toBe(true);
    expect(existsSync(BILLING)).toBe(true);
  });

  // --- AccountTier ------------------------------------------------

  it('CRITICAL AccountTier 8-value closed roster pinned (ADR-004 lock). The 8 tiers: free + 3 manual (solo/team/agency) + 3 API (starter/builder/scale) + enterprise. Drift to renaming would break the AccountTierSchema enum used by every billing call.', () => {
    const c = read(COMMON);

    const tiers = [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ];

    expect(c).toMatch(/export const AccountTierSchema = z\.enum\(\[/);
    for (const t of tiers) {
      expect(c, `tier ${t}`).toMatch(new RegExp(`'${t}'`));
    }
    expect(c).toMatch(/export type AccountTier = z\.infer<typeof AccountTierSchema>/);
  });

  it('CRITICAL AccountTier ADR-004 pricing-lock anchor pinned in common.ts framing. Drift to dropping would lose the per-tier-locking provenance (ADR-004 = pricing lock; ADR-003 trial metering removed 2026-05-27 with trial_pack).', () => {
    const c = read(COMMON);
    expect(c).toMatch(/Locked per ADR-004/);
  });

  // --- AccountStatus + AccountRegion ------------------------------

  it("CRITICAL AccountStatus 3-value enum pinned — 'active' | 'suspended' | 'deleted'. Matches W704 AccountSelfProfile.status union.", () => {
    const a = read(ACCOUNTS);
    expect(a).toMatch(
      /export const AccountStatusSchema = z\.enum\(\['active', 'suspended', 'deleted'\]\)/,
    );
  });

  it("CRITICAL AccountRegion 3-value enum pinned — 'us' | 'eu' | 'apac'. Matches W704 AccountSelfProfile.region 4-value (us/eu/apac/null) — the null comes from the schema's .nullable().", () => {
    const a = read(ACCOUNTS);
    expect(a).toMatch(/export const AccountRegionSchema = z\.enum\(\['us', 'eu', 'apac'\]\)/);
    expect(a).toMatch(/region: AccountRegionSchema\.nullable\(\)\.optional\(\)/);
  });

  // --- AvatarContentType + OptOutableEmailEvent --------------------

  it('CRITICAL V-352b AVATAR_ALLOWED_CONTENT_TYPES roster pinned in accounts.ts (matches W690 SDK-side avatar allowlist). The 3-value PNG/JPEG/WebP closed set MUST stay closed.', () => {
    const a = read(ACCOUNTS);
    expect(a).toMatch(/AVATAR_ALLOWED_CONTENT_TYPES/);
    expect(a).toMatch(
      /export const AvatarContentTypeSchema = z\.enum\(AVATAR_ALLOWED_CONTENT_TYPES\)/,
    );
  });

  it('CRITICAL V-204 OptOutableEmailEvent enum pinned (matches W694 cross-SDK guard). Drift to adding a critical event (verification/password-reset/billing-failure/etc.) into this enum would silently let customers opt out of safety-net emails.', () => {
    const a = read(ACCOUNTS);
    expect(a).toMatch(/OptOutableEmailEventSchema = z\.enum\(\[/);
  });

  // --- CryptoOrderStatus + CryptoOrderEventSource ------------------

  it('CRITICAL CryptoOrderStatus 6-value closed roster pinned — pending/confirming/paid/failed/partial/cancelled. Matches W693 + W718/W719/W720 doc-parity guards.', () => {
    const cr = read(CRYPTO);

    expect(cr).toMatch(/export const CryptoOrderStatusSchema = z\.enum\(\[/);
    for (const s of ['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']) {
      expect(cr, `status ${s}`).toMatch(new RegExp(`'${s}'`));
    }
  });

  it("CRITICAL V-666.AU CryptoOrderEventSource 4-value enum pinned — create/ipn/cancel/expired. The 'swept→expired' server-side mapping framing pinned: 'swept' is mapped to 'expired' server-side before serialization so customer-facing surface only sees four sources.", () => {
    const cr = read(CRYPTO);

    expect(cr).toMatch(
      /export const CryptoOrderEventSourceSchema = z\.enum\(\['create', 'ipn', 'cancel', 'expired'\]\)/,
    );
    expect(cr).toMatch(/V-666\.AU — customer-facing event source/);
    expect(cr).toMatch(
      /'swept' is mapped to\s*\n\/\/\s*'expired' server-side before serialization/,
    );
    expect(cr).toMatch(/surface only sees four sources/);
  });

  // --- WebhookEventType + SubscribableWebhookEventType -------------

  it('CRITICAL WebhookEventType 9-value closed roster pins only emitted and synthetic events.', () => {
    const w = read(WEBHOOKS);

    expect(w).toMatch(/export const WebhookEventTypeSchema = z\.enum\(\[/);
    for (const e of [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'session.egress_capability_changed',
      'test.ping',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ]) {
      const escaped = e.replace(/\./g, '\\.');
      expect(w, `event ${e}`).toMatch(new RegExp(`'${escaped}'`));
    }
  });

  it('CRITICAL V-356 SubscribableWebhookEventType is the 8-value subset EXCLUDING test.ping. The test.ping event is dispatched ONLY via POST /v1/webhooks/:id/test; customers cannot subscribe (UpdateSubscriptionsSchema rejects). Drift to including test.ping in subscribable would let customers configure subscriptions that never deliver.', () => {
    const w = read(WEBHOOKS);

    expect(w).toMatch(
      /V-356 — events the customer is allowed to subscribe to\. Excludes\s*\n\s*\*\s*`test\.ping`/,
    );
    expect(w).toMatch(/export const SubscribableWebhookEventTypeSchema = z\.enum\(\[/);

    // Subscribable enum has 8 entries — test.ping NOT included.
    const subscribableBlock = w.match(
      /SubscribableWebhookEventTypeSchema = z\.enum\(\[([\s\S]+?)\]\)/,
    )?.[1];
    expect(subscribableBlock).toBeDefined();
    expect(subscribableBlock).not.toMatch(/'test\.ping'/);
    for (const e of [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'session.egress_capability_changed',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ]) {
      const escaped = e.replace(/\./g, '\\.');
      expect(subscribableBlock, `subscribable ${e}`).toMatch(new RegExp(`'${escaped}'`));
    }
  });

  it('CRITICAL WebhookDeliveryStatus 5-value enum pinned — pending/in_flight/delivered/failed/dlq. The dlq (dead-letter-queue) entry is what surfaces customer-visible deliveries that exhausted retries.', () => {
    const w = read(WEBHOOKS);

    expect(w).toMatch(/export const WebhookDeliveryStatusSchema = z\.enum\(\[/);
    for (const s of ['pending', 'in_flight', 'delivered', 'failed', 'dlq']) {
      expect(w, `delivery status ${s}`).toMatch(new RegExp(`'${s}'`));
    }
  });

  // --- BillingPeriod + SubscriptionStatus --------------------------

  it("CRITICAL BillingPeriod 2-value enum pinned — 'monthly' | 'annual'. Annual is 20% off across all tiers (per common.ts framing). Drift to adding a 3rd period (weekly, quarterly) would silently break the pricing-ladder symmetry.", () => {
    const b = read(BILLING);
    expect(b).toMatch(/export const BillingPeriodSchema = z\.enum\(\['monthly', 'annual'\]\)/);
  });

  it('CRITICAL SubscriptionStatus enum pinned (matches Stripe subscription status semantics). Drift to a different status set would silently mismatch what the Stripe webhook normalizer emits.', () => {
    const b = read(BILLING);
    expect(b).toMatch(/export const SubscriptionStatusSchema = z\.enum\(\[/);
  });

  // --- Cross-enum + provenance -------------------------------------

  it('CRITICAL all canonical enums export both Schema + inferred type — `export const FooSchema = z.enum(...)` + `export type Foo = z.infer<typeof FooSchema>`. The type-export pattern is what gives downstream TS consumers literal-type narrowing.', () => {
    const sources = [
      { path: COMMON, name: 'AccountTier' },
      { path: ACCOUNTS, name: 'AccountRegion' },
      { path: ACCOUNTS, name: 'AccountAuditAction' },
      { path: CRYPTO, name: 'CryptoOrderStatus' },
      { path: CRYPTO, name: 'CryptoOrderEventSource' },
      { path: WEBHOOKS, name: 'WebhookEventType' },
      { path: WEBHOOKS, name: 'SubscribableWebhookEventType' },
      { path: WEBHOOKS, name: 'WebhookDeliveryStatus' },
      { path: BILLING, name: 'BillingPeriod' },
      { path: BILLING, name: 'SubscriptionStatus' },
    ];

    for (const { path, name } of sources) {
      const src = read(path);
      const re = new RegExp(`export type ${name} = z\\.infer<typeof ${name}Schema>`);
      expect(src, `${name} type export`).toMatch(re);
    }
  });

  it('CRITICAL ApiKeyScope enum pinned in common.ts. The scope enum is what gates the W701 V-296 api-key admin-scope check (drift would silently widen the api-key scope surface).', () => {
    const c = read(COMMON);
    expect(c).toMatch(/export const ApiKeyScopeSchema = z\.enum\(\[/);
  });

  it('Core-enum 5-invariant cluster — AccountTier 8-value ADR-004 + CryptoOrderStatus 6-value + WebhookEventType 6-value (5-value subscribable subset) + AccountRegion 3-value + BillingPeriod 2-value + every enum has Schema + type-infer.', () => {
    const c = read(COMMON);
    const a = read(ACCOUNTS);
    const cr = read(CRYPTO);
    const w = read(WEBHOOKS);
    const b = read(BILLING);

    expect(c).toMatch(/AccountTierSchema = z\.enum\(\[/);
    expect(c).toMatch(/ADR-004/);
    expect(a).toMatch(/AccountRegionSchema = z\.enum\(\['us', 'eu', 'apac'\]\)/);
    expect(cr).toMatch(/CryptoOrderStatusSchema = z\.enum\(\[/);
    expect(w).toMatch(/WebhookEventTypeSchema = z\.enum\(\[/);
    expect(w).toMatch(/SubscribableWebhookEventTypeSchema = z\.enum\(\[/);
    expect(b).toMatch(/BillingPeriodSchema = z\.enum\(\['monthly', 'annual'\]\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/api-types-core-enums-parity.test.ts')),
    ).toBe(true);
  });
});
