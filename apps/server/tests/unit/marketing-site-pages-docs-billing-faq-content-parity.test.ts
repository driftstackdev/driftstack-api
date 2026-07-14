// W511.B — drift guard for apps/marketing-site/src/pages/docs/billing-faq.astro.
// V-694 billing FAQ. Drift here either changes a refund-eligibility
// window (would create marketing↔legal-refunds divergence) or breaks
// the crypto vs card differentiation (would let customers conflate
// the two paths).
//
//   • V-694 doc-comment framing.
//   • Free tier: 1 concurrent / 1 profile + 20-min cap + no card +
//     perpetual + no metering + single ds_live_… prefix (no ds_test_).
//   • Crypto vs Stripe: prorate on upgrade (Stripe) vs full + cycle
//     reset (NowPayments) + downgrade at cycle end (both, no refund).
//   • 14-day card-refund window.
//   • Crypto non-refundable + failed-delivery re-provisioning.
//   • Wrong-amount scenarios: partial / overpayment (credit, no expiry) /
//     wrong currency (chain-dependent recovery).
//   • Tax/VAT: Stripe auto + crypto VAT-exclusive + reverse-charge for B2B.
//   • Cycle end: 7-day reminder + 48h grace + 7-day read-only.
//   • billing@driftstack.dev contact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/billing-faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W511.B apps/marketing-site/src/pages/docs/billing-faq.astro content parity', () => {
  const body = read(LIB);

  it("V-694 framing pinned: 'billing FAQ. Pulls together the questions that the /docs/cost-monitoring + /pricing/crypto pages don't explicitly answer (proration, refunds, trial → paid, NowPayments vs Stripe).' — pinned so the V-694 anchor + the explicit 4-topic gap-filling framing (proration / refunds / trial→paid / Now-vs-Stripe) survive", () => {
    expect(body).toMatch(
      /\/\/ V-694 — billing FAQ\. Pulls together the questions that the\s*\n?\s*\/\/ \/docs\/cost-monitoring \+ \/pricing\/crypto pages don't explicitly\s*\n?\s*\/\/ answer \(proration, refunds, trial → paid, NowPayments vs Stripe\)\./,
    );
  });

  it("Free-tier framing pinned: '1 concurrent session and 1 profile, with sessions up to 20 minutes each — drive them from the API/SDK or the desktop GUI client. No card is required, and it never expires.' — pinned so the 1-concurrent/1-profile + 20-min-cap + no-card + perpetual + no-metering free-tier framing survives. (2026-05-28: API/SDK works within the free limits per the accept-+-reconcile-copy decision; the old 'manual-only / no API/SDK access' framing was dropped.)", () => {
    expect(body).toMatch(
      /<strong>1 concurrent\s*\n?\s*session<\/strong> and <strong>1 profile<\/strong>, with sessions\s*\n?\s*up to 20 minutes each/,
    );
    expect(body).toMatch(/no usage metering, no credit, and no auto-charge\./);
    expect(body).toMatch(
      /All API keys\s*\n?\s*use the <code>ds_live_…<\/code> prefix; there is no separate\s*\n?\s*<code>ds_test_<\/code> namespace today\./,
    );
    expect(body).toMatch(/when you need higher limits — more concurrency, more profiles/);
  });

  it("Stripe vs NowPayments proration framing pinned: 'Upgrades are prorated by Stripe' + 'Crypto upgrades (NowPayments) charge the full new tier price and reset the billing cycle to the upgrade date — crypto is pay-as-you-go-style because we cannot guarantee in-cycle reconciliation against an on-chain payment.' — pinned so the asymmetric Stripe-prorates / NowPayments-full-price-cycle-reset commitment + the 'cannot guarantee in-cycle reconciliation' rationale all survive (drift to claiming crypto upgrades also prorate would create marketing↔NowPayments-flow divergence)", () => {
    expect(body).toMatch(
      /<strong>Upgrades<\/strong> are prorated by Stripe: you pay the\s*\n?\s*pro-rata difference for the remainder of the current billing\s*\n?\s*cycle/,
    );
    expect(body).toMatch(
      /Crypto\s*\n?\s*upgrades \(NowPayments\) charge the <em>full<\/em> new tier price\s*\n?\s*and reset the billing cycle to the upgrade date — crypto is\s*\n?\s*pay-as-you-go-style because we cannot guarantee in-cycle\s*\n?\s*reconciliation against an on-chain payment\./,
    );
  });

  it("Downgrade-at-cycle-end framing pinned: 'Downgrades take effect at the end of the current cycle (you keep the higher tier until then). No refund is issued for the unused portion of the higher tier.' — pinned so the end-of-cycle downgrade + no-refund-on-unused-portion commitment survives (drift to refunding the unused portion would create marketing↔Section-8.7-of-Terms divergence)", () => {
    expect(body).toMatch(
      /<strong>Downgrades<\/strong> take effect at the end of the\s*\n?\s*current cycle \(you keep the higher tier until then\)\. No refund\s*\n?\s*is issued for the unused portion of the higher tier\./,
    );
  });

  it("Card-refund 14-day-window framing pinned: 'Card payments: full refund within 14 days of payment if you haven't run sessions beyond a brief evaluation. Past the 14-day window we do not refund unless the issue is on our side (extended outage, billing error).' — pinned so the 14-day-no-usage-refund + outage/billing-error-carve-out 2-state card-refund policy survives (drift to a different window would create marketing↔legal-refunds-policy divergence)", () => {
    expect(body).toMatch(
      /Card payments: full refund within <strong>14 days of payment<\/strong>\s*\n?\s*if you haven't run sessions beyond a brief evaluation\./,
    );
    expect(body).toMatch(
      /Past the 14-day window we do not refund unless the issue is on\s*\n?\s*our side \(extended outage, billing error\)\./,
    );
  });

  it("Crypto non-refundable framing pinned: 'Crypto payments: non-refundable. Once a crypto payment settles on-chain it is committed for the billing period it covers.' + 'If a failed-delivery scenario occurs (you paid but the entitlement didn't unlock), we re-provision the entitlement; we don't send the crypto back.' — pinned so the non-refundable + failed-delivery-re-provision-not-refund commitment survives (drift to softening 'non-refundable' would invite refund disputes; drift to dropping the re-provision-not-refund framing would mislead failed-delivery customers)", () => {
    expect(body).toMatch(/Crypto payments: <strong>non-refundable\.<\/strong>/);
    expect(body).toMatch(
      /If a failed-delivery scenario occurs\s*\n?\s*\(you paid but the entitlement didn't unlock\), we re-provision\s*\n?\s*the entitlement; we don't send the crypto back\./,
    );
  });

  it('Wrong-amount 3-state framing: Underpayment → partial / Overpayment → paid + account credit no-expiry / Wrong currency-network → support chain-dependent — pinned so the 3-state wrong-amount handling stays consistent (drift to dropping the no-expiry on overpayment credit would let customers think their surplus expires; drift to dropping the chain-dependent recovery framing would mislead customers about cross-chain recovery)', () => {
    expect(body).toMatch(
      /<strong>Underpayment:<\/strong> the order transitions to\s*\n?\s*<code>partial<\/code> and stays there\. Support reaches out to\s*\n?\s*arrange a top-up/,
    );
    expect(body).toMatch(
      /<strong>Overpayment:<\/strong> the order completes as\s*\n?\s*<code>paid<\/code> and the difference is recorded as account\s*\n?\s*credit usable against the next renewal\. Surplus credit does\s*\n?\s*not expire\./,
    );
    expect(body).toMatch(
      /<strong>Wrong currency \/ network:<\/strong> contact\s*\n?\s*support — recovery depends on the chain\. We can usually\s*\n?\s*recover ETH and USDC sent to the wrong address; we cannot\s*\n?\s*recover BTC sent to a Lightning address or vice versa\./,
    );
  });

  it("Tax/VAT framing pinned: 'Stripe handles VAT on card payments automatically — EU + UK customers see VAT added at checkout based on their billing country. Crypto payments are quoted VAT-exclusive; VAT for EU/UK customers is invoiced separately in EUR after the crypto payment confirms (you'll receive a follow-up payment link for the VAT amount). B2B customers can provide a VAT number on /docs/teams for reverse-charge invoicing.' — pinned so the 3-VAT-rule (Stripe-auto / crypto-VAT-exclusive-EUR-followup / B2B-reverse-charge) survives (drift to claiming crypto is VAT-inclusive would create marketing↔invoicing divergence)", () => {
    expect(body).toMatch(
      /Stripe handles VAT on card payments automatically — EU \+ UK\s*\n?\s*customers see VAT added at checkout/,
    );
    expect(body).toMatch(
      /Crypto payments are quoted <em>VAT-exclusive<\/em>;\s*\n?\s*VAT for EU\/UK customers is invoiced separately in EUR after\s*\n?\s*the crypto payment confirms/,
    );
    expect(body).toMatch(
      /B2B customers can provide a\s*\n?\s*VAT number on <a href="\/docs\/teams\/">\/docs\/teams<\/a> for\s*\n?\s*reverse-charge invoicing\./,
    );
    expect(body).not.toMatch(/href="\/docs\/teams"/);
  });

  it('Cycle-end 3-phase framing: 7-day reminder + 48h grace + 7-day read-only state before Free-tier downgrade — pinned so the 3-phase cycle-end cascade survives (drift to a different reminder window would let crypto customers miss their renewal; drift to dropping the 7-day read-only-grace would force immediate downgrade)', () => {
    expect(body).toMatch(
      /Crypto customers receive\s*\n?\s*a renewal reminder 7 days before the cycle ends/,
    );
    expect(body).toMatch(
      /If a crypto renewal is not paid within\s*\n?\s*48 hours of cycle end, the account drops to a read-only\s*\n?\s*grace state for 7 days, then is downgraded to the Free\s*\n?\s*tier until renewal\./,
    );
  });

  it("Cancel-anytime + 30-day post-cancel data retention pinned: 'Cancellation is available via the dashboard at any time — no retention friction. Cancellation takes effect at the end of the current cycle' + 'Sessions, profiles, recordings, and API keys stay accessible for 30 days after the cycle end, then are purged.' — pinned so the no-retention-friction + end-of-cycle-effect + 30-day-post-cancel-retention commitments survive (drift to a longer cycle-end-to-purge gap would create marketing↔DPA-retention-schedule divergence)", () => {
    expect(body).toMatch(
      /Cancellation is available via the dashboard at any time — no\s*\n?\s*retention friction\./,
    );
    expect(body).toMatch(
      /Sessions, profiles, recordings, and API keys\s*\n?\s*stay accessible for <strong>30 days<\/strong> after the cycle\s*\n?\s*end, then are purged\./,
    );
  });

  it('billing@driftstack.dev + order_id include-from-checkout-confirmation framing pinned — pinned so the billing-team-specific routing + the support-ticket-template (include order_id) survive (drift to dropping the order_id-include guidance would let support tickets land without the NowPayments status-lookup key)', () => {
    expect(body).toMatch(/<a href="mailto:billing@driftstack\.dev">billing@driftstack\.dev<\/a>/);
    expect(body).toMatch(
      /include the\s*\n?\s*<code>order_id<\/code> from the checkout-confirmation email so\s*\n?\s*we can look up the NowPayments status\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
