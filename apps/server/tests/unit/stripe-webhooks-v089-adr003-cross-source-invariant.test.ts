// W955 — V-089 + ADR-003 stripe-webhooks cross-source invariant.
// Two-hundred-eighty-first in the drift-guard series. Pins the
// inbound Stripe webhook service:
//
//   Service intro — 'Inbound Stripe webhook handler. Stripe-signed
//   events arrive at POST /v1/webhooks/stripe'.
//
//   2-responsibility framing:
//     1. Idempotency — 'processed_stripe_events records each handled
//        event.id. Duplicates short-circuit at 200 OK without
//        re-running the handler. Stripe re-delivers within 3 days;
//        the table is the durable record of "we've already seen
//        this"'.
//     2. Event dispatch — 'async per-type handlers that mutate the
//        local mirror (subscriptions table, accounts.tier,
//        accounts.trial_pack_*) based on Stripe event payloads'.
//
//   Signature-verification-in-route framing — 'Signature verification
//   is the route's job (it has the raw body); this service receives
//   a verified, parsed event'.
//
//   StripeEvent (7 fields) — minimal parsed-event shape (no `stripe`
//   npm package types).
//
//   StripeWebhooksRepo: recordEvent + hasEvent + V-089 mutate
//     methods.
//
//   DispatchOutcome 3-value template-literal type: 'handled' |
//     'ignored' | `error:${string}` — covers success + ignored + per-
//     error-tag outcomes.
//
//   ADR-003 trial-pack defaults:
//     - DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299 ($2.99).
//     - DEFAULT_TRIAL_PACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
//       (14 days).
//
//   StripeWebhooksServiceConfig:
//     - priceToTier: Record<priceId, AccountTier> for sub-event tier
//       resolution.
//     - trialPackCreditCents (optional; default 299).
//     - trialPackWindowMs (optional; default 14 days).
//     - cancelDowngradeTier (optional; default 'trial_pack').
//
//   V-226 / V-202b lifecycle dispatcher framing — 'optional account-
//   lifecycle dispatcher. When wired, Stripe handler points emit
//   lifecycle events (subscription.tier_changed,
//   subscription.trial_pack_purchased) which fan out into audit log
//   + transactional email at one call site'.
//
// stays in lockstep across apps/server/src/services/stripe-webhooks.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W955 V-089 + ADR-003 stripe-webhooks cross-source invariant', () => {
  // ─── Service intro + route-vs-service-signature split ───────

  it("CRITICAL apps/server/src/services/stripe-webhooks.ts header pins surface — 'Inbound Stripe webhook handler. Stripe-signed events arrive at POST /v1/webhooks/stripe'. The endpoint is the customer-facing Stripe-side hook.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Inbound Stripe webhook handler\./);
    expect(p).toMatch(/Stripe-signed events arrive at POST \/v1\/webhooks\/stripe\./);
  });

  it("CRITICAL signature-in-route framing — 'Signature verification is the route's job (it has the raw body); this service receives a verified, parsed event'. The service-after-verify split keeps signature logic with the raw-body request handler.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Signature verification is the route's job \(it has the raw body\); this/);
    expect(p).toMatch(/service receives a verified, parsed event\./);
  });

  // ─── 2-responsibility framing ────────────────────────────────

  it("CRITICAL 2-responsibility framing — '1. Idempotency — processed_stripe_events records each handled event.id. Duplicates short-circuit at 200 OK without re-running the handler. Stripe re-delivers within 3 days; the table is the durable record of \"we've already seen this\". 2. Event dispatch — async per-type handlers that mutate the local mirror (subscriptions table, accounts.tier, accounts.trial_pack_*) based on Stripe event payloads'. The idempotency-via-table + per-type-handler split is the central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/1\. Idempotency — `processed_stripe_events` records each handled/);
    expect(p).toMatch(/`event\.id`\. Duplicates short-circuit at 200 OK without re-running/);
    expect(p).toMatch(/the handler\. Stripe re-delivers within 3 days; the table is the/);
    expect(p).toMatch(/durable record of "we've already seen this\."/);
    expect(p).toMatch(/2\. Event dispatch — async per-type handlers that mutate the local/);
    expect(p).toMatch(/mirror \(subscriptions table, accounts\.tier, accounts\.trial_pack_\*\)/);
    expect(p).toMatch(/based on Stripe event payloads\./);
  });

  // ─── StripeEvent 7-field shape ───────────────────────────────

  it('CRITICAL StripeEvent has 7 fields — id + type + api_version (optional) + created (optional) + data.object (open Record) + livemode (optional) + request (optional, nested 2-field). The 7-field shape is the minimal parsed-event surface — no dependency on `stripe` npm package types.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/export interface StripeEvent \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/type: string;/);
    expect(p).toMatch(/api_version\?: string;/);
    expect(p).toMatch(/created\?: number;/);
    expect(p).toMatch(/data: \{ object: Record<string, unknown> \};/);
    expect(p).toMatch(/livemode\?: boolean;/);
    expect(p).toMatch(
      /request\?: \{ id: string \| null; idempotency_key: string \| null \} \| null;/,
    );
  });

  it("CRITICAL no-stripe-SDK framing — 'We don't depend on the stripe package's TypeScript types — they're vast and most of the runtime shape we touch lives under data.object which is an open object'. The open-object design is the V-088 hand-rolled-SDK posture mirror.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Minimal parsed-Stripe-event shape\. We don't depend on the `stripe`/);
    expect(p).toMatch(/package's TypeScript types — they're vast and most of the runtime/);
    expect(p).toMatch(/shape we touch lives under `data\.object` which is an open object\./);
  });

  // ─── StripeWebhooksRepo recordEvent + hasEvent ───────────────

  it("CRITICAL StripeWebhooksRepo.recordEvent JSDoc — 'Returns true if this is a fresh insert; false if event_id was already present'. The true-on-fresh return is the idempotency primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(
      /Returns `true` if this is a fresh insert; `false` if `event_id` was already present\./,
    );
    expect(p).toMatch(/recordEvent\(args: \{/);
    expect(p).toMatch(/eventId: string;/);
    expect(p).toMatch(/eventType: string;/);
    expect(p).toMatch(/payloadHash: string;/);
    expect(p).toMatch(/result: string;/);
    expect(p).toMatch(/receivedAt: Date;/);
    expect(p).toMatch(/\}\): Promise<\{ inserted: boolean \}>;/);
  });

  it("CRITICAL hasEvent JSDoc — 'True if event_id is already in the ledger (used for short-circuit before handler runs)'. The short-circuit-before-handler is what avoids re-running mutations on Stripe re-deliveries.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(
      /True if `event_id` is already in the ledger \(used for short-circuit before handler runs\)\./,
    );
    expect(p).toMatch(/hasEvent\(eventId: string\): Promise<boolean>;/);
  });

  // ─── V-089 mutation-method framing ───────────────────────────

  it("CRITICAL V-089 mutation-methods section header — '// ── V-089 mutation methods ──'. The V-089 anchor scopes the local-mirror write methods.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/\/\/ ── V-089 mutation methods ──/);
  });

  it("CRITICAL findAccountIdFromCustomerOrRef JSDoc — 'Resolve the local account id from a Stripe event's customer + client_reference_id fields. Returns null when neither resolves (event references an account we don't track — should never happen in practice but the handler logs + returns ignored rather than throwing)'. The 2-field resolve + null-on-untracked + log-not-throw is the resilience contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Resolve the local account id from a Stripe event's customer \+/);
    expect(p).toMatch(/client_reference_id fields\. Returns null when neither resolves/);
    expect(p).toMatch(/\(event references an account we don't track — should never happen/);
    expect(p).toMatch(/in practice but the handler logs \+ returns 'ignored' rather than/);
    expect(p).toMatch(/throwing\)\./);
  });

  // ─── DispatchOutcome template-literal type ──────────────────

  it("CRITICAL DispatchOutcome 3-value template-literal — 'handled' | 'ignored' | `error:${string}`. The template-literal pattern lets per-error-tag outcomes encode in the return type without enum churn.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(
      /export type DispatchOutcome = 'handled' \| 'ignored' \| `error:\$\{string\}`;/,
    );
  });

  // ─── ADR-003 trial-pack defaults ─────────────────────────────

  it('CRITICAL ADR-003 trial-pack defaults — DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299 ($2.99) + DEFAULT_TRIAL_PACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000 (14 days). The 299¢ + 14d defaults are the ADR-003 trial-pack policy (matches W939 billing).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/const DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299;/);
    expect(p).toMatch(/const DEFAULT_TRIAL_PACK_WINDOW_MS = 14 \* 24 \* 60 \* 60 \* 1000;/);
  });

  it("CRITICAL trialPackCreditCents config JSDoc — 'Trial-pack credit cents (default 299 = $2.99 per ADR-003). Override for tests'. The 299/default + test-override design is the customer-facing trial-pack contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Trial-pack credit cents \(default 299 = \$2\.99 per ADR-003\)\./);
    expect(p).toMatch(/Override for tests\./);
    expect(p).toMatch(/trialPackCreditCents\?: number;/);
  });

  it("CRITICAL trialPackWindowMs config JSDoc — 'Trial-pack window length in milliseconds (default 14 days per ADR-003). Override for tests'. The 14d window matches ADR-003.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Trial-pack window length in milliseconds \(default 14 days per ADR-003\)\./);
    expect(p).toMatch(/trialPackWindowMs\?: number;/);
  });

  // ─── cancelDowngradeTier framing ─────────────────────────────

  it("CRITICAL cancelDowngradeTier JSDoc — 'What tier the account drops to when a subscription is canceled (status=canceled / event customer.subscription.deleted). Default trial_pack (loses paid tier privileges; trial-pack credit may still be active independently)'. The default-trial_pack-on-cancel keeps customer alive at the floor tier.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/What tier the account drops to when a subscription is canceled/);
    expect(p).toMatch(/\(status='canceled' \/ event 'customer\.subscription\.deleted'\)\./);
    expect(p).toMatch(/Default 'trial_pack' \(loses paid tier privileges; trial-pack/);
    expect(p).toMatch(/credit may still be active independently\)\./);
    expect(p).toMatch(/cancelDowngradeTier\?: AccountTier;/);
  });

  // ─── priceToTier framing (sub-event resolution) ──────────────

  it("CRITICAL priceToTier JSDoc — 'Reverse map from Stripe price id to local AccountTier. Used by customer.subscription.{created,updated} to determine which tier to set on the account based on the subscription's price. When a price id is absent from this map (e.g. an enterprise custom-billed subscription), the handler logs a warning and skips the tier change — the subscription mirror still gets written'. The price→tier map + enterprise-custom-bypass is the V-089 tier-resolution contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/Reverse map from Stripe price id to local AccountTier\. Used by/);
    expect(p).toMatch(/`customer\.subscription\.\{created,updated\}` to determine which tier/);
    expect(p).toMatch(/to set on the account based on the subscription's price\. When a/);
    expect(p).toMatch(/price id is absent from this map \(e\.g\. an enterprise custom-billed/);
    expect(p).toMatch(/subscription\), the handler logs a warning and skips the tier/);
    expect(p).toMatch(/change — the subscription mirror still gets written\./);
    expect(p).toMatch(/priceToTier: Record<string, AccountTier>;/);
  });

  // ─── V-226 / V-202b lifecycle dispatcher framing ─────────────

  it("CRITICAL V-226 / V-202b lifecycle dispatcher framing — 'V-226 / V-202b — optional account-lifecycle dispatcher. When wired, Stripe handler points emit lifecycle events (subscription.tier_changed, subscription.trial_pack_purchased) which fan out into audit log + transactional email at one call site. V-226 originally did the audit emit directly here; V-202b'. The V-226→V-202b refactor consolidated audit + email into a single dispatcher.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/V-226 \/ V-202b — optional account-lifecycle dispatcher\. When wired,/);
    expect(p).toMatch(/Stripe handler points emit lifecycle events/);
    expect(p).toMatch(/\(`subscription\.tier_changed`, `subscription\.trial_pack_purchased`\)/);
    expect(p).toMatch(/which fan out into audit log \+ transactional email at one call/);
    expect(p).toMatch(/site\./);
  });

  // ─── 5+ subscription event types dispatched ──────────────────

  it("CRITICAL dispatched Stripe event types include the 5 lifecycle events — 'customer.subscription.created' + 'customer.subscription.updated' + 'customer.subscription.deleted' + 'checkout.session.completed' + 'invoice.payment_succeeded' + 'invoice.payment_failed' + 'invoice.finalized' + 'invoice.upcoming'. The 8-event handler set is the V-089 subscription-lifecycle mirror surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/case 'customer\.subscription\.created':/);
    expect(p).toMatch(/case 'customer\.subscription\.updated':/);
    expect(p).toMatch(/case 'customer\.subscription\.deleted':/);
    expect(p).toMatch(/case 'checkout\.session\.completed':/);
    expect(p).toMatch(/case 'invoice\.payment_succeeded':/);
    expect(p).toMatch(/case 'invoice\.payment_failed':/);
    expect(p).toMatch(/case 'invoice\.finalized':/);
    expect(p).toMatch(/case 'invoice\.upcoming':/);
  });

  // ─── customer.* / payment_method.* explicit ignore branches ──

  it("CRITICAL explicit-ignore branches — 'customer.created' + 'customer.updated' + 'customer.deleted' + 'payment_method.attached' + 'payment_method.detached'. The 5 explicit-ignore cases prevent the default 'ignored' from masking events that should explicitly be no-op.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'));
    expect(p).toMatch(/case 'customer\.created':/);
    expect(p).toMatch(/case 'customer\.updated':/);
    expect(p).toMatch(/case 'customer\.deleted':/);
    expect(p).toMatch(/case 'payment_method\.attached':/);
    expect(p).toMatch(/case 'payment_method\.detached':/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/stripe-webhooks-v089-adr003-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
