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
//   • Wrong-amount scenarios: partial / overpayment (V-790: no account-credit
//     balance exists — the old "credit, no expiry" text promised one) /
//     wrong currency (chain-dependent recovery).
//   • Tax/VAT: Stripe auto + crypto VAT-exclusive + reverse-charge for B2B.
//   • Cycle end: V-790 retracted the "7-day reminder + 48h grace + 7-day
//     read-only" cascade — none of the three exist. Crypto is a one-time
//     31-day entitlement, stacking on re-purchase, swept within ~15 minutes.
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
      /\/\/ V-694 — billing FAQ\. Pulls together the questions that the\s*\/\/ \/docs\/cost-monitoring \+ \/pricing\/crypto pages don't explicitly\s*\/\/ answer \(proration, refunds, Free → paid, NowPayments vs Stripe\)\./,
    );
    expect(body).not.toMatch(/trial conversion|trial → paid/);
  });

  it('Free-tier framing pins desktop-only use, restricted ds_test credential and paid API/OAuth boundary', () => {
    expect(body).toMatch(
      /<strong>1 concurrent\s*session<\/strong> and <strong>1 profile<\/strong>, with sessions\s*up to 20 minutes each/,
    );
    expect(body).toMatch(/launched and driven through the desktop app/);
    expect(body).toMatch(/restricted\s*<code>ds_test_…<\/code> device credential automatically/);
    expect(body).toMatch(/not a\s*customer API key or a general sandbox key/);
    expect(body).toMatch(
      /Programmatic API\/SDK access,\s*OAuth approval, and <code>ds_live_…<\/code> customer API keys require a\s*paid tier, including the Manual tiers/,
    );
    expect(body).toMatch(/cannot create or\s*rotate them/);
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
      /<strong>Upgrades<\/strong> are prorated by Stripe: you pay the\s*pro-rata difference for the remainder of the current billing\s*cycle/,
    );
    expect(body).toMatch(
      /Crypto\s*upgrades \(NowPayments\) charge the <em>full<\/em> new tier price\s*and reset the billing cycle to the upgrade date — crypto is\s*pay-as-you-go-style because we cannot guarantee in-cycle\s*reconciliation against an on-chain payment\./,
    );
  });

  it("Downgrade-at-cycle-end framing pinned: 'Downgrades take effect at the end of the current cycle (you keep the higher tier until then). No refund is issued for the unused portion of the higher tier.' — pinned so the end-of-cycle downgrade + no-refund-on-unused-portion commitment survives (drift to refunding the unused portion would create marketing↔Section-8.7-of-Terms divergence)", () => {
    expect(body).toMatch(
      /<strong>Downgrades<\/strong> take effect at the end of the\s*current cycle \(you keep the higher tier until then\)\. No refund\s*is issued for the unused portion of the higher tier\./,
    );
  });

  it("Card-refund 14-day-window framing pinned: 'Card payments: full refund within 14 days of payment if you haven't run sessions beyond a brief evaluation. Past the 14-day window we do not refund unless the issue is on our side (extended outage, billing error).' — pinned so the 14-day-no-usage-refund + outage/billing-error-carve-out 2-state card-refund policy survives (drift to a different window would create marketing↔legal-refunds-policy divergence)", () => {
    expect(body).toMatch(
      /Card payments: full refund within <strong>14 days of payment<\/strong>\s*if you haven't run sessions beyond a brief evaluation\./,
    );
    expect(body).toMatch(
      /Past the 14-day window we do not refund unless the issue is on\s*our side \(extended outage, billing error\)\./,
    );
  });

  it("Crypto non-refundable framing pinned: 'Crypto payments: non-refundable. Once a crypto payment settles on-chain it is committed for the billing period it covers.' + 'If a failed-delivery scenario occurs (you paid but the entitlement didn't unlock), we re-provision the entitlement; we don't send the crypto back.' — pinned so the non-refundable + failed-delivery-re-provision-not-refund commitment survives (drift to softening 'non-refundable' would invite refund disputes; drift to dropping the re-provision-not-refund framing would mislead failed-delivery customers)", () => {
    expect(body).toMatch(/Crypto payments: <strong>non-refundable\.<\/strong>/);
    expect(body).toMatch(
      /If a failed-delivery scenario occurs\s*\(you paid but the entitlement didn't unlock\), we re-provision\s*the entitlement; we don't send the crypto back\./,
    );
  });

  it('Wrong-amount 3-state framing: Underpayment → partial / Overpayment → paid + account credit no-expiry / Wrong currency-network → support chain-dependent — pinned so the 3-state wrong-amount handling stays consistent (drift to dropping the no-expiry on overpayment credit would let customers think their surplus expires; drift to dropping the chain-dependent recovery framing would mislead customers about cross-chain recovery)', () => {
    expect(body).toMatch(
      /<strong>Underpayment:<\/strong> the order transitions to\s*<code>partial<\/code> and stays there\. Support reaches out to\s*arrange a top-up/,
    );
    expect(body).toMatch(
      /<strong>Overpayment:<\/strong> the order completes as\s*<code>paid<\/code> and the entitlement is granted in full\.\s*Driftstack does not keep an account-credit balance, so the\s*surplus is not carried forward automatically — contact\s*support and we will sort it out\./,
    );
    // V-790 — per-occurrence negative. No credit ledger exists anywhere: the only
    // such column was trial_pack_credit_cents, dropped by migration 0065.
    expect(body, 'the account-credit promise must not return').not.toMatch(
      /recorded as account\s*credit usable against the next renewal/,
    );
    expect(body).toMatch(
      /<strong>Wrong currency \/ network:<\/strong> contact\s*support — recovery depends on the chain\. We can usually\s*recover ETH and USDC sent to the wrong address; we cannot\s*recover BTC sent to a Lightning address or vice versa\./,
    );
  });

  it("Tax/VAT framing pinned: 'Stripe handles VAT on card payments automatically — EU + UK customers see VAT added at checkout based on their billing country. Crypto payments are quoted VAT-exclusive; VAT for EU/UK customers is invoiced separately in EUR after the crypto payment confirms (you'll receive a follow-up payment link for the VAT amount). B2B customers can provide a VAT number on /docs/teams for reverse-charge invoicing.' — pinned so the 3-VAT-rule (Stripe-auto / crypto-VAT-exclusive-EUR-followup / B2B-reverse-charge) survives (drift to claiming crypto is VAT-inclusive would create marketing↔invoicing divergence)", () => {
    expect(body).toMatch(
      /Stripe handles VAT on card payments automatically — EU \+ UK\s*customers see VAT added at checkout/,
    );
    expect(body).toMatch(
      /Crypto payments are quoted <em>VAT-exclusive<\/em>;\s*VAT for EU\/UK customers is invoiced separately in EUR after\s*the crypto payment confirms/,
    );
    expect(body).toMatch(
      /B2B customers can provide a\s*VAT number on <a href="\/docs\/teams\/">\/docs\/teams<\/a> for\s*reverse-charge invoicing\./,
    );
    expect(body).not.toMatch(/href="\/docs\/teams"/);
  });

  it('Cycle-end framing, corrected by V-790. This pinned a three-phase cascade — 7-day reminder, 48h grace, 7-day read-only state — and none of the three exists. The only renewal_reminder emitter is the Stripe invoice.upcoming handler; the account status enum is [active, suspended, deleted] with no read-only state; and CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_INTERVAL_MS is 15 minutes with no offset, so the downgrade lands within a quarter hour of expiry. The page promised roughly fourteen days of runway a paying customer did not have.', () => {
    expect(body).toMatch(
      /Crypto is not a\s*subscription — a payment buys a single 31-day entitlement, and\s*there is no auto-renew and no renewal reminder today\./,
    );
    expect(body).toMatch(
      /That happens within about 15 minutes of expiry —\s*there is no grace period/,
    );
    expect(body, 'the stacking behaviour is real and worth stating').toMatch(
      /the new 31 days\s*start from the existing expiry/,
    );
    // Per-occurrence negatives on all three retracted phases.
    expect(body).not.toMatch(/renewal reminder 7 days before/);
    expect(body).not.toMatch(/48 hours of cycle end/);
    expect(body).not.toMatch(/read-only\s*grace state/);
  });

  it('pins cancellation as an end-of-cycle Free downgrade without inventing a purge or cloud recording lifecycle', () => {
    expect(body).toMatch(
      /Cancellation is available via the dashboard at any time — no\s*retention friction\./,
    );
    expect(body).toMatch(/account then moves to the Free tier\s*automatically/);
    expect(body).toMatch(/Cancellation itself does not schedule a data\s*purge/);
    expect(body).toMatch(/recordings saved by the desktop\s*app stay on that device/);
    expect(body).toMatch(/resubscribe at any time/);
    expect(body).not.toMatch(/30 days[\s\S]{0,100}(?:purged|deleted)/i);
  });

  it('billing@driftstack.dev + order_id include-from-checkout-confirmation framing pinned — pinned so the billing-team-specific routing + the support-ticket-template (include order_id) survive (drift to dropping the order_id-include guidance would let support tickets land without the NowPayments status-lookup key)', () => {
    expect(body).toMatch(/<a href="mailto:billing@driftstack\.dev">billing@driftstack\.dev<\/a>/);
    expect(body).toMatch(
      /include the\s*<code>order_id<\/code> from the checkout-confirmation email so\s*we can look up the NowPayments status\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
