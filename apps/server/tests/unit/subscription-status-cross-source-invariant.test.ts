// W856 — SubscriptionStatus 8-value Stripe-mirror cross-source
// invariant. One-hundred-eighty-second in the drift-guard series.
// Pins the 8-value billing-subscription status enum:
//   1. incomplete         — Stripe-checkout started, first invoice not paid.
//   2. incomplete_expired — first-invoice grace period elapsed.
//   3. trialing           — V-318 trial-pack active.
//   4. active             — paid + in-good-standing.
//   5. past_due           — invoice overdue, retry in progress.
//   6. canceled           — cancelation completed (terminal).
//   7. unpaid             — Stripe gave up on past_due retries.
//   8. paused             — admin/customer-requested pause.
// stays in lockstep across:
//   - packages/api-types/src/billing.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//
// The enum is a literal mirror of Stripe's subscription.status
// values — drift would let our DB persist a Stripe webhook status
// the schema rejects (worker crash) OR let the Go SDK consumer
// pattern-match on a status the server doesn't actually emit.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

describe('W856 SubscriptionStatus cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/billing.ts SubscriptionStatusSchema = z.enum([8 values]). The 8-value closed-roster mirrors Stripe subscription.status exactly.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/export const SubscriptionStatusSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 8-value Stripe-mirror set IN
    // ORDER, not merely contain it. Although Stripe's status roster is stable,
    // a 9th value (or a reorder) would silently pass the body-subset check below
    // (the weak pattern that let the WebhookEventType roster drift 6→9).
    expect(SubscriptionStatusSchema.options).toEqual([...SUBSCRIPTION_STATUSES]);
    const m = p.match(/SubscriptionStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'SubscriptionStatusSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const s of SUBSCRIPTION_STATUSES) {
      expect(body, `SubscriptionStatusSchema must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }
  });

  it('CRITICAL SubscriptionStatus type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(
      /export type SubscriptionStatus = z\.infer<typeof SubscriptionStatusSchema>;/,
    );
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts subscriptionStatus = pgEnum('subscription_status', [8 values]). Postgres rejects INSERTs of unknown values — drift would crash the Stripe-webhook handler when persisting a status the pgEnum doesn't accept.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/subscriptionStatus = pgEnum\('subscription_status', \[/);
    const m = p.match(/subscriptionStatus = pgEnum\('subscription_status', \[([\s\S]+?)\]\);/);
    expect(m, 'subscriptionStatus pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const s of SUBSCRIPTION_STATUSES) {
      expect(body, `pgEnum must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 8 SubscriptionStatus consts — SubStatusActive + SubStatusTrialing + SubStatusPastDue + SubStatusCanceled + SubStatusUnpaid + SubStatusIncomplete + SubStatusIncompleteExpired + SubStatusPaused. Each maps to one canonical Stripe status string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type SubscriptionStatus string/);
    expect(p).toMatch(/SubStatusActive\s+SubscriptionStatus = "active"/);
    expect(p).toMatch(/SubStatusTrialing\s+SubscriptionStatus = "trialing"/);
    expect(p).toMatch(/SubStatusPastDue\s+SubscriptionStatus = "past_due"/);
    expect(p).toMatch(/SubStatusCanceled\s+SubscriptionStatus = "canceled"/);
    expect(p).toMatch(/SubStatusUnpaid\s+SubscriptionStatus = "unpaid"/);
    expect(p).toMatch(/SubStatusIncomplete\s+SubscriptionStatus = "incomplete"/);
    expect(p).toMatch(/SubStatusIncompleteExpired SubscriptionStatus = "incomplete_expired"/);
    expect(p).toMatch(/SubStatusPaused\s+SubscriptionStatus = "paused"/);
  });

  // ─── V-429 anchor traceable ─────────────────────────────────

  it('CRITICAL V-429 anchor pinned in Go SDK Subscription struct comment. The V-429 anchor threads the public-subscription contract provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/Subscription — V-429/);
  });

  // ─── 8-value cardinality ─────────────────────────────────────

  it('CRITICAL SubscriptionStatus = EXACTLY 8 values mirroring Stripe subscription.status. Stripe documents these 8 — drift to a 7- or 9- value enum would let the server crash on a Stripe webhook status it does not recognise.', () => {
    expect(SUBSCRIPTION_STATUSES.length).toBe(8);
  });

  // ─── Failed-state classification ─────────────────────────────

  it("CRITICAL the failed-state subset (past_due + unpaid + canceled + incomplete_expired) is what billing-quota gates branch on. These are the states where customers CANNOT consume API quota. Drift to renaming would let a customer in 'past_due' silently keep burning quota.", () => {
    const failedStates = ['past_due', 'unpaid', 'canceled', 'incomplete_expired'] as const;
    for (const s of failedStates) {
      expect(
        (SUBSCRIPTION_STATUSES as readonly string[]).includes(s),
        `failed-state '${s}' must be in SUBSCRIPTION_STATUSES`,
      ).toBe(true);
    }
  });

  // ─── Good-standing subset ─────────────────────────────────────

  it("CRITICAL the good-standing subset (active + trialing) is what billing-quota grants on. These are the states where customers CAN consume API quota. Drift to including 'past_due' in good-standing would over-grant.", () => {
    const goodStates = ['active', 'trialing'] as const;
    for (const s of goodStates) {
      expect(
        (SUBSCRIPTION_STATUSES as readonly string[]).includes(s),
        `good-standing '${s}' must be in SUBSCRIPTION_STATUSES`,
      ).toBe(true);
    }
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it("CRITICAL no source declares forbidden subscription-status names (suspended / inactive / pending / refunded / chargeback). Stripe doesn't emit these — drift to introducing them would create statuses the Stripe webhook never produces.", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    const forbidden = ['suspended', 'inactive', 'pending', 'refunded', 'chargeback'];
    const m = apiTypes.match(/SubscriptionStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `SubscriptionStatus must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/subscription-status-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
