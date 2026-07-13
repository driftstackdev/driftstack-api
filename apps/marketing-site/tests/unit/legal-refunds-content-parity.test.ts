// W378.B — drift guard for marketing-site /legal/refunds.md content.
// Existing refunds-policy-parity covers basic shape. This guard
// pins the load-bearing refund-counsel claims:
//
//   • Version 1.0 + Effective 2026-05-11.
//   • 4 refund-eligible scenarios + 4 no-refund scenarios pinned
//     verbatim — these are the falsifiable customer-trust claims.
//   • Card refund mechanics: 5–10 business day Stripe timing.
//   • Crypto non-refundable framing with 3 rationales (settlement
//     irreversibility / fraud-abuse asymmetry / operational
//     simplicity). Load-bearing commercial-policy stance.
//   • 4-step crypto-non-refundable practical-meaning list.
//   • SLA-credit relationship: default = apply against next invoice,
//     no expiry, cash-out on cancel.
//   • Dispute path: 5-business-day support response + chargeback
//     option.
//   • ToS §8.7 cross-reference (binding contractual statement).
//   • /pricing/crypto cross-link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W378.B marketing-site /legal/refunds.md content parity', () => {
  const body = read(PAGE);

  it('version 1.0 + effective 2026-05-11 doc header pinned', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-11/);
  });

  it('ToS §8.7 binding-contractual cross-reference pinned', () => {
    expect(body).toMatch(/section 8\.7 of the Terms is the binding contractual statement/);
    expect(body).toMatch(/\[Terms of Service\]\(\/legal\/terms\/\)/);
  });

  it('4 refund-eligible scenarios pinned (Failed delivery / Service failure / 14-day-no-usage / Duplicate)', () => {
    expect(body).toMatch(
      /\*\*Failed delivery\.\*\* A charge succeeded but the corresponding\s+feature was not made available/,
    );
    expect(body).toMatch(/\*\*Service failure attributable to Driftstack\.\*\*/);
    expect(body).toMatch(/\*\*Within 14 days of first paid charge, no usage\.\*\*/);
    expect(body).toMatch(/\*\*Mistaken duplicate charge\.\*\*/);
  });

  it('14-day-no-usage refund is discretionary (not a statutory right)', () => {
    expect(body).toMatch(/This is a discretionary policy, not\s+a statutory right/);
    expect(body).toMatch(
      /rather you walk away\s+happy than be stuck paying for something you didn't use/,
    );
  });

  it('3 no-refund scenarios pinned (Mid-cycle cancel / Downgrade / Overage)', () => {
    expect(body).toMatch(/Mid-cycle cancellation of a monthly Subscription/);
    expect(body).toMatch(/Tier downgrade\. The downgrade takes effect at the next renewal/);
    expect(body).toMatch(
      /Usage that exceeded customer expectations \(e\.g\. LLM-bundled\s+spend\)/,
    );
    // The retired trial-pack non-consumed denial scenario must NOT return.
    expect(body).not.toMatch(/Trial Pack/);
  });

  it('cost-monitoring cross-link in the LLM-overage no-refund line', () => {
    expect(body).toMatch(/\[billing dashboard\]\(\/docs\/cost-monitoring\)/);
  });

  it('Card refund mechanics: support@driftstack.dev + 5–10 business day Stripe timing', () => {
    expect(body).toMatch(/\[`support@driftstack\.dev`\]\(mailto:support@driftstack\.dev\)/);
    expect(body).toMatch(/typically 5–10 business days, depending on your card issuer/);
    expect(body).toMatch(/Stripe returns the funds to the original payment method/);
  });

  it('Crypto non-refundable: 3 rationales pinned (settlement irreversibility / fraud-abuse / operational simplicity)', () => {
    expect(body).toMatch(/\*\*Crypto payments at Driftstack are non-refundable\.\*\*/);
    expect(body).toMatch(
      /\*\*Settlement irreversibility\.\*\* Crypto transfers are final once\s+the network confirms them/,
    );
    expect(body).toMatch(
      /\*\*Fraud \+ abuse asymmetry\.\*\* Card refunds rely on the issuer to\s+reverse a charge/,
    );
    expect(body).toMatch(/\*\*Operational simplicity\.\*\*/);
    expect(body).toMatch(/refund-loss reserve into the unit\s+economics/);
  });

  it('Crypto-non-refundable practical-meaning: cancel anytime + current-period honoured + duplicate-credit + failed-delivery re-provision', () => {
    expect(body).toMatch(
      /You can \*\*cancel\*\* your subscription anytime through the standard\s+self-serve flow/,
    );
    expect(body).toMatch(
      /Cancellation stops the next billing period's\s+payment-request mint; it does not refund the current period/,
    );
    expect(body).toMatch(/The current billing period continues to be honoured/);
    expect(body).toMatch(
      /we'll credit the\s+duplicate against your next renewal rather than refund it\s+on-chain/,
    );
    expect(body).toMatch(/we re-provision the entitlement, no refund mechanics needed/);
  });

  it('Card-fallback recommendation: "if your situation needs an actual cash refund, please pay via card (Stripe)"', () => {
    expect(body).toMatch(
      /If your situation needs an actual cash refund, please pay via card\s+\(Stripe\)/,
    );
  });

  it('/pricing/crypto cross-link pinned (lifecycle deep-dive)', () => {
    expect(body).toMatch(/\[`\/pricing\/crypto`\]\(\/pricing\/crypto\)/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/crypto.astro')),
    ).toBe(true);
  });

  it('SLA credit: default applied against next invoice + no expiry + cash-out on cancel', () => {
    expect(body).toMatch(/the\s+default is to apply it against your next invoice/);
    expect(body).toMatch(/SLA credits do not\s+expire/);
    expect(body).toMatch(
      /if you cancel before the next invoice, you can request the\s+credit out as cash/,
    );
  });

  it('Dispute path: refund dispute subject line + 5-business-day support response + chargeback option', () => {
    expect(body).toMatch(/with "refund dispute" in the\s+subject line/);
    expect(body).toMatch(/We respond within 5 business days/);
    expect(body).toMatch(/you can issue a chargeback through your card issuer/);
    expect(body).toMatch(/we\s+may also terminate the account for chargeback-related abuse/);
  });

  it('"We do not litigate refunds" customer-trust posture pinned', () => {
    expect(body).toMatch(
      /We do not litigate refunds — they are low-stakes enough that\s+walking away is almost always cheaper than fighting it out/,
    );
  });

  it('30-day material-change notice for refund policy updates', () => {
    expect(body).toMatch(
      /Material changes are notified by email to active\s+Customers at least 30 days before the new version takes effect/,
    );
  });
});
