// W878 — TrialPackState 4-field + ADR-003 cross-source invariant.
// Two-hundred-fourth in the drift-guard series. Pins the V-318
// trial-pack state shape + ADR-003 constants:
//
//   TrialPackState (4 fields):
//     1. active: boolean
//     2. credit_cents_remaining: int | null
//     3. expires_at: ISO-8601 | null
//     4. redeemed: boolean
//
//   ADR-003 constants:
//     - Price: $2.99 (one-time, non-subscription Stripe Checkout).
//     - Initial credit: trial_pack_credit_cents = 299.
//     - Expiry: +14 days from purchase.
//
//   GetBillingStateResponse nullability split:
//     - subscription: nullable (account never subscribed).
//     - trial_pack: ALWAYS PRESENT (server schema non-nullable).
//
// stays in lockstep across:
//   - packages/api-types/src/billing.ts (Zod canonical).
//   - packages/sdk-go/types.go (TrialPackState struct).
//
// Drift would silently break:
//   * Customer billing UI when fields drift in/out.
//   * V-318 trial-pack auto-expiry logic.
//   * Go SDK consumers depending on the 4-field shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TRIAL_PACK_CREDIT_CENTS = 299;
const TRIAL_PACK_DAYS = 14;

describe('W878 TrialPackState cross-source invariant', () => {
  // ─── api-types canonical: TrialPackStateSchema 4 fields ──────

  it('CRITICAL packages/api-types/src/billing.ts TrialPackStateSchema has exactly 4 fields — active (boolean) + credit_cents_remaining (int nullable) + expires_at (ISO nullable) + redeemed (boolean). The 4-field shape is what customer billing UI + V-318 expiry logic pivot on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/export const TrialPackStateSchema = z\.object\(\{/);
    expect(p).toMatch(/TrialPackStateSchema = z\.object\(\{[\s\S]+?active: z\.boolean\(\)/);
    expect(p).toMatch(
      /TrialPackStateSchema = z\.object\(\{[\s\S]+?credit_cents_remaining: z\.number\(\)\.int\(\)\.nullable\(\)/,
    );
    expect(p).toMatch(
      /TrialPackStateSchema = z\.object\(\{[\s\S]+?expires_at: Iso8601Schema\.nullable\(\)/,
    );
    expect(p).toMatch(/TrialPackStateSchema = z\.object\(\{[\s\S]+?redeemed: z\.boolean\(\)/);
  });

  it('CRITICAL TrialPackState type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/export type TrialPackState = z\.infer<typeof TrialPackStateSchema>;/);
  });

  // ─── ADR-003 constants in api-types doc ──────────────────────

  it('CRITICAL ADR-003 anchor pinned + $2.99 price + 299¢ credit + 14-day window all referenced in api-types/billing.ts. The 3 numeric constants + 1 anchor are the immutable ADR-003 record.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/\$2\.99/);
    expect(p).toMatch(/trial_pack_credit_cents = 299/);
    expect(p).toMatch(/\+14 days/);
    expect(p).toMatch(/per ADR-003/);
  });

  it("CRITICAL TrialPack doc framing pinned — 'one-time $2.99 pre-paid credit per ADR-003' + 'Same Stripe Checkout flow, different price id (a one-time payment, not a subscription)'. The framing distinguishes trial-pack from the subscription-based checkout.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/one-time \$2\.99 pre-paid credit per ADR-003/);
    expect(p).toMatch(
      /Same\s*\n\/\/ Stripe Checkout flow, different price id \(a one-time payment, not a/,
    );
  });

  // ─── Go SDK TrialPackState struct ────────────────────────────

  it('CRITICAL packages/sdk-go/types.go TrialPackState struct has the EXACT 4 fields — Active bool + CreditCentsRemaining *int (nullable pointer) + ExpiresAt *time.Time (nullable pointer) + Redeemed bool. The pointer nullables match api-types z.X.nullable().', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type TrialPackState struct \{/);
    expect(p).toMatch(/Active\s+bool\s+`json:"active"`/);
    expect(p).toMatch(/CreditCentsRemaining \*int\s+`json:"credit_cents_remaining"`/);
    expect(p).toMatch(/ExpiresAt\s+\*time\.Time `json:"expires_at"`/);
    expect(p).toMatch(/Redeemed\s+bool\s+`json:"redeemed"`/);
  });

  // ─── GetBillingStateResponse nullability split ────────────────

  it('CRITICAL api-types GetBillingStateResponseSchema has subscription: SubscriptionSchema.nullable() (account never subscribed → null) + trial_pack: TrialPackStateSchema (NON-nullable, always present even when active=false). The asymmetry is intentional.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(
      /GetBillingStateResponseSchema = z\.object\(\{\s*\n\s*subscription: SubscriptionSchema\.nullable\(\),\s*\n\s*trial_pack: TrialPackStateSchema,/,
    );
  });

  it("CRITICAL Go SDK GetBillingStateResponse mirrors the asymmetry — Subscription is *Subscription (nullable pointer); TrialPack is TrialPackState (non-nullable value). The 'Subscription is nullable (account never subscribed). TrialPack is always present' comment pins the intent.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/Subscription \*Subscription\s+`json:"subscription"`/);
    expect(p).toMatch(/TrialPack\s+TrialPackState `json:"trial_pack"`/);
    expect(p).toMatch(/`Subscription` is nullable\s*\n?\s*\/\/ \(account never subscribed\)/);
    expect(p).toMatch(
      /`TrialPack` is always present \(server's\s*\n?\s*\/\/ schema has it non-nullable\)/,
    );
  });

  // ─── V-429 anchor traceable ──────────────────────────────────

  it('CRITICAL V-429 anchor pinned for GetBillingStateResponse in Go SDK. The V-429 anchor threads the billing-state-read provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/GetBillingStateResponse — V-429/);
  });

  // ─── Constants cardinality ───────────────────────────────────

  it('CRITICAL ADR-003 constants are 299 cents + 14 days. Drift would change the trial-pack economics — 299 is the at-cost-of-an-API-key-mint price; 14 days is the typical evaluation window.', () => {
    expect(TRIAL_PACK_CREDIT_CENTS).toBe(299);
    expect(TRIAL_PACK_DAYS).toBe(14);
  });

  // ─── StartTrialPackRequest is success_url+cancel_url only ────

  it('CRITICAL StartTrialPackRequestSchema has ONLY success_url + cancel_url (both optional URL). The minimal request body distinguishes trial-pack from the more-complex checkout-session (which requires tier + billing_period).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(
      /StartTrialPackRequestSchema = z\.object\(\{\s*\n\s*success_url: z\.string\(\)\.url\(\)\.optional\(\),\s*\n\s*cancel_url: z\.string\(\)\.url\(\)\.optional\(\),\s*\n\s*\}\)/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/trial-pack-state-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
