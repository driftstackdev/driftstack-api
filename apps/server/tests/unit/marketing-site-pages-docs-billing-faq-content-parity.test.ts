// W511.B — drift guard for apps/marketing-site/src/pages/docs/billing-faq.astro.
// V-694 billing FAQ. Drift here either changes a refund-eligibility
// window (would create marketing↔legal-refunds divergence) or breaks
// the crypto vs card differentiation (would let customers conflate
// the two paths).
//
//   • V-694 doc-comment framing.
//   • Free tier: browser-first desktop + restricted ds_test device credential;
//     paid tiers provide API/SDK/OAuth + ds_live customer keys.
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

  it('V-694 framing names the real Free-to-paid transition rather than a fictional trial conversion', () => {
    expect(body).toMatch(
      /\/\/ V-694 — billing FAQ\. Pulls together the questions that the\s*\n?\s*\/\/ \/docs\/cost-monitoring \+ \/pricing\/crypto pages don't explicitly\s*\n?\s*\/\/ answer \(proration, refunds, Free → paid, NowPayments vs Stripe\)\./,
    );
    expect(body).not.toMatch(/trial conversion|trial → paid/);
  });

  it('Free-tier framing pins desktop-only use, restricted ds_test credential and paid API/OAuth boundary', () => {
    expect(body).toMatch(
      /<strong>1 concurrent\s*\n?\s*session<\/strong> and <strong>1 profile<\/strong>, with sessions\s*\n?\s*up to 20 minutes each/,
    );
    expect(body).toMatch(/launched and driven through the desktop app/);
    expect(body).toMatch(
      /restricted\s*\n?\s*<code>ds_test_…<\/code> device credential automatically/,
    );
    expect(body).toMatch(/not a\s*\n?\s*customer API key or a general sandbox key/);
    expect(body).toMatch(
      /Programmatic API\/SDK access,\s*\n?\s*OAuth approval, and <code>ds_live_…<\/code> customer API keys require a\s*\n?\s*paid tier, including the Manual tiers/,
    );
    expect(body).toMatch(/cannot create or\s*\n?\s*rotate them/);
    expect(body).toMatch(/ordinary keys and OAuth tokens remain paused/);
    expect(body).toMatch(/no usage charges, prepaid credits, or automatic charges/);
    expect(body).not.toMatch(/drive them from the API\/SDK|no separate[^.]*ds_test_/);
  });

  it('pins fixed-subscription browser pricing and real payment sources of truth', () => {
    expect(body).toMatch(/new fixed subscription price and entitlement limits/);
    expect(body).toMatch(
      /Browser session-hours, API calls, and page\s+\n?\s*navigations do not create usage overages/,
    );
    expect(body).toMatch(
      /Stripe's Customer Portal and Stripe-issued invoices are the source of\s+\n?\s*truth/,
    );
    expect(body).toMatch(/NowPayments order receipt for the amount paid/);
  });

  it('pins the operational estimate as non-invoice telemetry and LLM as a separate included budget', () => {
    expect(body).toMatch(/operational cost estimate/);
    expect(body).toMatch(/unit-economics view, not an invoice/);
    expect(body).toMatch(
      /does not itemize sessions,\s+\n?\s*recordings, storage, egress, email, or LLM as customer charges/,
    );
    expect(body).toMatch(/included-service monthly budget/);
    expect(body).not.toMatch(/cost estimate[\s\S]{0,120}(?:customer bill|invoice total)/i);
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

  it('pins cancellation as an end-of-cycle Free downgrade without inventing a purge or cloud recording lifecycle', () => {
    expect(body).toMatch(
      /Cancellation is available via the dashboard at any time — no\s*\n?\s*retention friction\./,
    );
    expect(body).toMatch(/account then moves to the Free tier\s*\n?\s*automatically/);
    expect(body).toMatch(/Cancellation itself does not schedule a data\s*\n?\s*purge/);
    expect(body).toMatch(/recordings saved by the desktop\s*\n?\s*app stay on that device/);
    expect(body).toMatch(/resubscribe at any time/);
    expect(body).not.toMatch(/30 days[\s\S]{0,100}(?:purged|deleted)/i);
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
