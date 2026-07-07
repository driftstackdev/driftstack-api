// W520.A — drift guard for apps/marketing-site/src/pages/docs/billing-crypto-overview.astro.
// V-707 end-to-end crypto-payments lifecycle walkthrough. Drift here
// either changes a coin/network combination (would create marketing↔
// NowPayments-merchant divergence) or breaks the state-machine table
// (would create marketing↔crypto-orders-server divergence).
//
//   • V-707 doc-comment framing + /docs/billing-faq + /pricing/crypto
//     companion cross-refs.
//   • Supported coins 4-bullet list: BTC main-net + ETH main-net +
//     USDC/USDT on ERC-20/TRC-20/BEP-20 + LTC/BCH/DOGE/MATIC.
//   • Order lifecycle 6-state table: pending / confirming / partial /
//     paid / failed / cancelled.
//   • 5-step walkthrough: pick tier → pay address (single-use, exact
//     amount, displayed network) → confirmations (BTC 2 blocks ~20min,
//     ETH 12 blocks ~3min, USDC/USDT Tron near-instant) → paid (tier
//     upgrade applied, receipt email, crypto.order.paid emitted but
//     NOT subscribable) → receipt 3-format (JSON / .txt / .pdf).
//   • Receipt endpoint shape: GET /v1/billing/crypto-orders/:id/receipt{,.txt,.pdf}.
//   • Non-refundable + cancel-stops-future-not-current commitment.
//   • Stuck-cases 4-bullet + 24-hour auto-failed.
//   • Tax/VAT: PDF receipt canonical + separate VAT invoice on request.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/billing-crypto-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W520.A apps/marketing-site/src/pages/docs/billing-crypto-overview.astro content parity', () => {
  const body = read(LIB);

  it("V-707 framing pinned: 'overview of the end-to-end crypto-payments flow at Driftstack: how a customer goes from picking a tier to a paid invoice + receipt, what the system does in between, and where the support seams are. Companion to /docs/billing-faq (general billing) and /pricing/crypto (the pricing-page CTA).' — pinned so the V-707 anchor + 2-companion cross-refs survive", () => {
    expect(body).toMatch(
      /\/\/ V-707 — overview of the end-to-end crypto-payments flow at\s*\n?\s*\/\/ Driftstack: how a customer goes from picking a tier to a paid\s*\n?\s*\/\/ invoice \+ receipt, what the system does in between, and where the\s*\n?\s*\/\/ support seams are\. Companion to \/docs\/billing-faq \(general billing\)\s*\n?\s*\/\/ and \/pricing\/crypto \(the pricing-page CTA\)\./,
    );
  });

  it("Supported-coins 4-bullet framing pinned: 'NowPayments converts your incoming payment to a stable settlement currency on our side.' + BTC main-net only + ETH main-net only + USDC/USDT on ERC-20/TRC-20/BEP-20 + LTC/BCH/DOGE/MATIC + 'The full live list is available in the checkout dropdown; the enumeration there is the source of truth.' — pinned so the NowPayments-stable-settlement + main-net-only BTC/ETH + 3-network-USDC/USDT + 4-extra-coin + checkout-dropdown source-of-truth commitment survives", () => {
    expect(body).toMatch(
      /NowPayments converts your incoming payment to a stable\s*\n?\s*settlement currency on our side\./,
    );
    expect(body).toMatch(/<li>Bitcoin \(BTC\) — main-net only<\/li>/);
    expect(body).toMatch(/<li>Ethereum \(ETH\) — main-net only<\/li>/);
    expect(body).toMatch(/<li>USDC \/ USDT — ERC-20, TRC-20, and BEP-20 networks<\/li>/);
    expect(body).toMatch(
      /<li>Litecoin \(LTC\), Bitcoin Cash \(BCH\), Dogecoin \(DOGE\), Polygon \(MATIC\)<\/li>/,
    );
    expect(body).toMatch(
      /The full live list is available in the checkout dropdown; the\s*\n?\s*enumeration there is the source of truth\./,
    );
  });

  it("Order-lifecycle 6-state table pinned: pending (Order minted, waiting for on-chain activity, pay-or-cancel) + confirming (Payment seen, awaiting block confirmations, cancellation now requires support) + partial (on-chain payment below invoice, common when exchange rate moved between quote + payment, contact support for top-up, non-refundable) + paid (All confirmations received, tier upgraded, download receipt JSON/text/PDF) + failed (Payment timed out / refunded by NowPayments / won't settle, open fresh order, contact support if funds left wallet) + cancelled (cancelled before any on-chain activity, terminal) — pinned so the 6-state table + per-state action guidance survives (drift to dropping any state would create marketing↔order-state-machine divergence)", () => {
    expect(body).toMatch(/<td><code>pending<\/code><\/td>/);
    expect(body).toMatch(
      /<td>Order minted\. We're waiting to see any payment activity on-chain\.<\/td>/,
    );
    expect(body).toMatch(
      /<td>Pay the address, or cancel the order if you've changed your mind\.<\/td>/,
    );
    expect(body).toMatch(/<td><code>confirming<\/code><\/td>/);
    expect(body).toMatch(/<td>Payment seen on the network\. Awaiting block confirmations\.<\/td>/);
    expect(body).toMatch(
      /<td>Wait\. Cancellation now requires support so we can reconcile your funds\.<\/td>/,
    );
    expect(body).toMatch(/<td><code>partial<\/code><\/td>/);
    expect(body).toMatch(
      /<td>An on-chain payment arrived but the amount is below the invoice\. Common when the exchange rate moved between quote \+ payment\.<\/td>/,
    );
    expect(body).toMatch(
      /<td>Contact support — we'll arrange a top-up\. Crypto payments are non-refundable, so partials are resolved by completing the payment, not by sending it back\.<\/td>/,
    );
    expect(body).toMatch(/<td><code>paid<\/code><\/td>/);
    expect(body).toMatch(/<td>All confirmations received\. Your tier is upgraded\.<\/td>/);
    expect(body).toMatch(
      /<td>Download the receipt \(JSON \/ text \/ PDF formats — see below\)\.<\/td>/,
    );
    expect(body).toMatch(/<td><code>failed<\/code><\/td>/);
    expect(body).toMatch(
      /<td>Payment timed out, was refunded by NowPayments, or otherwise won't settle\.<\/td>/,
    );
    expect(body).toMatch(/<td><code>cancelled<\/code><\/td>/);
    expect(body).toMatch(/<td>You cancelled before any on-chain activity\. Terminal\.<\/td>/);
  });

  it("Step-2 pay-address + single-use + exact-amount + displayed-network-only + 5-second polling framing pinned: 'You'll be shown a deposit address + an exact amount in the coin you picked. The address is single-use — only send the exact amount, and only on the displayed network (sending USDC-ERC20 to a USDC-TRC20 address loses funds). The dashboard's order view polls every five seconds so you'll see the transition to confirming within seconds of the network seeing your transaction.' — pinned so the deposit-address + single-use + exact-amount + displayed-network-only + 5s-polling commitment survives (drift to claiming wrong-network-recoverable would mislead customers about loss-on-wrong-network)", () => {
    expect(body).toMatch(
      /You'll be shown a deposit address \+ an exact amount in the coin\s*\n?\s*you picked\. The address is single-use — only send the exact\s*\n?\s*amount, and only on the displayed network \(sending USDC-ERC20\s*\n?\s*to a USDC-TRC20 address loses funds\)\. The dashboard's order\s*\n?\s*view polls every five seconds so you'll see the transition to\s*\n?\s*<code>confirming<\/code> within seconds of the network seeing\s*\n?\s*your transaction\./,
    );
  });

  it("Confirmation-threshold framing pinned: 'Required confirmations vary by coin: Bitcoin needs 2 blocks (about 20 minutes), Ethereum needs 12 blocks (about 3 minutes), USDC / USDT on Tron is a few seconds. The order stays in confirming until the threshold is reached.' — pinned so the 3-coin-confirmation-threshold (BTC 2 blocks ~20min / ETH 12 blocks ~3min / USDC+USDT-Tron few seconds) commitment survives (drift to a different threshold would mislead customers on expected wait time)", () => {
    expect(body).toMatch(
      /Required confirmations vary by coin: Bitcoin needs 2 blocks\s*\n?\s*\(about 20 minutes\), Ethereum needs 12 blocks \(about 3 minutes\),\s*\n?\s*USDC \/ USDT on Tron is a few seconds\. The order stays in\s*\n?\s*<code>confirming<\/code> until the threshold is reached\./,
    );
  });

  it("Paid + crypto.order.paid IS-subscribable framing pinned: 'Your tier upgrade is applied the moment the order transitions to paid. A receipt email is sent to the account address. A crypto.order.paid event is emitted and is subscribable — register an endpoint via POST /v1/webhooks (see /docs/webhooks-crypto-events), or poll GET /v1/billing/crypto-orders/<order_id> if you prefer.' — pinned so the tier-upgrade-on-paid + receipt-email + crypto.order.paid-IS-subscribable (register via POST /v1/webhooks) + poll-fallback commitment survives. The event was promoted to subscribable: the previous 'emitted but not yet on the subscribable webhook event list' framing is superseded.", () => {
    expect(body).toMatch(
      /Your tier upgrade is applied the moment the order transitions\s*\n?\s*to <code>paid<\/code>\. A receipt email is sent to the account\s*\n?\s*address\. A <code>crypto\.order\.paid<\/code> event is emitted and\s*\n?\s*is subscribable — register an endpoint via\s*\n?\s*<code>POST \/v1\/webhooks<\/code> \(see\s*\n?\s*<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">\/docs\/webhooks-crypto-events<\/a>\),\s*\n?\s*or poll\s*\n?\s*<code>GET \/v1\/billing\/crypto-orders\/&lt;order_id&gt;<\/code> if\s*\n?\s*you prefer\./,
    );
    // Anti-drift: the event is now subscribable; the old NOT-yet-subscribable
    // framing must NOT return (would create marketing↔webhook-event-list divergence).
    expect(body).not.toMatch(/is not yet on the subscribable webhook event list/);
  });

  it('Receipt 3-format endpoint surface pinned: GET /v1/billing/crypto-orders/:id/receipt (JSON envelope, programmatic) + .txt (plain-text, cron jobs / curl pipelines) + .pdf (PDF, accounting / archival) — pinned so the 3-receipt-format endpoint shape + per-format-use-case commitment survives (drift to dropping any format would shrink the customer-facing-receipt surface)', () => {
    expect(body).toMatch(/# JSON envelope — programmatic consumers/);
    expect(body).toMatch(/GET \/v1\/billing\/crypto-orders\/:id\/receipt/);
    expect(body).toMatch(/# Plain-text — cron jobs \/ curl pipelines/);
    expect(body).toMatch(/GET \/v1\/billing\/crypto-orders\/:id\/receipt\.txt/);
    expect(body).toMatch(/# PDF — for accounting \/ archival/);
    expect(body).toMatch(/GET \/v1\/billing\/crypto-orders\/:id\/receipt\.pdf/);
  });

  it('Stuck-cases 4-bullet framing pinned: pending-but-nothing-on-chain (mempool latency a few minutes on busy chains) + explorer-shows-payment-but-order-still-pending (NowPayments waiting for confirmation threshold) + partial-state (support top-up, non-refundable, no-send-back) + stuck-more-than-24-hours (auto-transition to failed) — pinned so the 4-stuck-case + 24h-auto-fail + non-refundable-completion-not-refund commitment survives', () => {
    expect(body).toMatch(
      /<strong>You see a pending order but nothing on-chain\s*\n?\s*yet\.<\/strong> Confirm the transaction broadcast went out\s*\n?\s*from your wallet\. Network mempool latency can be a few minutes\s*\n?\s*on busy chains\./,
    );
    expect(body).toMatch(
      /<strong>The block explorer shows your payment but the\s*\n?\s*order is still <code>pending<\/code>\.<\/strong> NowPayments is\s*\n?\s*waiting for the confirmation threshold\. Wait the documented\s*\n?\s*block count\./,
    );
    expect(body).toMatch(
      /<strong><code>partial<\/code> state\.<\/strong> Open a support\s*\n?\s*ticket; we'll arrange a top-up\. Crypto payments are\s*\n?\s*non-refundable, so partials are resolved by completing the\s*\n?\s*payment, not by sending the existing crypto back\./,
    );
    expect(body).toMatch(
      /<strong>Stuck more than 24 hours\.<\/strong> The order will\s*\n?\s*auto-transition to <code>failed<\/code>; open a new order or\s*\n?\s*contact support for reconciliation\./,
    );
  });

  it("Refunds + cancellation framing pinned: 'Crypto payments at Driftstack are non-refundable. You may cancel your subscription at any time — cancellation stops future billing periods — but the current billing period is not refunded.' + /legal/refunds cross-ref + 'If you specifically need a cash-refund mechanism, the card-billing path (Stripe) is the right channel.' — pinned so the non-refundable + cancel-stops-future-not-current + Stripe-for-cash-refunds commitment survives", () => {
    expect(body).toMatch(
      /<strong>Crypto payments at Driftstack are non-refundable\.<\/strong>\s*\n?\s*You may cancel your subscription at any time — cancellation\s*\n?\s*stops future billing periods — but the current billing period\s*\n?\s*is not refunded\./,
    );
    expect(body).toMatch(
      /If you specifically need a cash-refund\s*\n?\s*mechanism, the card-billing path \(Stripe\) is the right\s*\n?\s*channel\./,
    );
  });

  it("Tax + invoicing framing pinned: 'The PDF receipt is the canonical artefact for your accountant. For VAT-registered EU customers we issue a separate VAT invoice on request — include your VAT id when you contact billing@.' — pinned so the PDF-canonical + EU-VAT-invoice-on-request + include-VAT-id commitment survives", () => {
    expect(body).toMatch(
      /The PDF receipt is the canonical artefact for your accountant\.\s*\n?\s*For VAT-registered EU customers we issue a separate VAT invoice\s*\n?\s*on request — include your VAT id when you contact billing@\./,
    );
  });

  it('6-related-doc cluster: /docs/billing-crypto-integration-guide + /pricing + /docs/billing-faq + /docs/webhooks-crypto-events + /docs/crypto-orders-polling-vs-webhooks + /docs/idempotency-keys + /docs/api-quickstart — pinned so the 6-related-doc + 1-pricing navigation surface stays complete (drift to dropping any cross-ref would orphan from the per-topic detail page)', () => {
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/guides\/paying-with-crypto\/">Crypto\s*\n?\s*payments — integration guide<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing">Pricing<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/billing-faq">Billing FAQ<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Crypto webhook\s*\n?\s*events<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Polling\s*\n?\s*vs webhooks<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/idempotency-keys">Idempotency keys<\/a>/);
    // S47 2026-07-07 (founder-approved: mirror deprecation): deleted-mirror hrefs re-pinned to the docs successors.
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/quickstart-curl\/">API quickstart<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
