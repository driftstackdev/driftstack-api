// W520.C — drift guard for apps/marketing-site/src/pages/docs/billing-crypto-troubleshooting.astro.
// V-708 customer-facing crypto troubleshooting decision tree. Drift here
// either softens the recoverable-vs-stuck guidance on wrong-network sends
// (would mislead customers about loss risk) or breaks the support-
// escalation template (would leave tickets without the order_id+TX-hash
// pair support needs).
//
//   • V-708 doc-comment framing.
//   • Order_id discovery 3-channel: Dashboard Billing → Crypto orders +
//     GET /v1/billing/crypto-orders + every order mint sends a
//     confirmation email with order_id in subject.
//   • Pending-but-paid 3-step: block-explorer check (mempool.space /
//     etherscan / tronscan) + required-confirmations (BTC 2/~20min /
//     ETH 12/~3min / USDC+USDT-Tron near-instant) + 30-min mempool
//     allowance.
//   • Partial 3-cause: exchange-rate movement + network-fees-deducted +
//     wrong-coin-right-address (USDC instead of USDT).
//   • Partial resolution: support top-up invoice (non-refundable, no
//     send-back).
//   • Failed 3-cause: NowPayments-rejected + 24h-timeout + provider-decline.
//   • Funds-left-wallet-but-order-failed escalation path.
//   • Wrong-network 2-class: EVM↔EVM (often recoverable, same address) /
//     EVM↔non-EVM (rare, recovery chain-dependent).
//   • Single-use checkout: refresh doesn't re-display address.
//   • 3-format receipt curl examples (.json/.txt/.pdf).
//   • Support escalation 5-bullet template + 1-business-day SLA on
//     trial+paid; per-contract on enterprise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/billing-crypto-troubleshooting.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W520.C apps/marketing-site/src/pages/docs/billing-crypto-troubleshooting.astro content parity', () => {
  const body = read(LIB);

  it("V-708 framing pinned: 'practical troubleshooting page for the crypto-payments flow. Companion to /docs/billing-crypto-overview (lifecycle walkthrough). Aimed at customers running into a specific issue after paying — pitched as \"you're here because something looks wrong, here's the decision tree.\"' — pinned so the V-708 anchor + decision-tree posture + /docs/billing-crypto-overview companion commitment survives", () => {
    expect(body).toMatch(
      /\/\/ V-708 — practical troubleshooting page for the crypto-payments\s*\n?\s*\/\/ flow\. Companion to \/docs\/billing-crypto-overview \(lifecycle\s*\n?\s*\/\/ walkthrough\)\. Aimed at customers running into a specific issue\s*\n?\s*\/\/ after paying — pitched as "you're here because something looks\s*\n?\s*\/\/ wrong, here's the decision tree\."/,
    );
  });

  it('Order_id discovery 3-channel framing pinned: Dashboard Billing → Crypto orders (every order with current state) + GET /v1/billing/crypto-orders (same list newest first) + Email (every order mint sends confirmation email with order id in subject line) — pinned so the 3-channel order_id-discovery + every-mint-sends-email commitment survives', () => {
    expect(body).toMatch(
      /<strong>Dashboard<\/strong> — Billing → Crypto orders shows\s*\n?\s*every order on your account with its current state\./,
    );
    expect(body).toMatch(
      /<strong>API<\/strong> — <code>GET \/v1\/billing\/crypto-orders<\/code>\s*\n?\s*returns the same list, newest first\./,
    );
    expect(body).toMatch(
      /<strong>Email<\/strong> — every order mint sends a\s*\n?\s*confirmation email with the order id in the subject line\./,
    );
  });

  it("Pending-but-paid 3-step decision-tree pinned: block-explorer (mempool.space / etherscan / tronscan, not-yet-broadcast vs broadcast+0-confirmations) + required-confirmations (BTC 2 blocks ~20min / ETH 12 blocks ~3min / USDC+USDT-Tron near-instant) + 'Wait at least 30 minutes. Mempool congestion + RPC propagation lag can easily push a normally-fast network to 15+ minutes.' — pinned so the 3-step pending tree + 30-min-wait-threshold commitment survives", () => {
    expect(body).toMatch(
      /<strong>Check the block explorer first\.<\/strong> Paste your\s*\n?\s*TX hash into the canonical explorer for the network you used\s*\n?\s*\(mempool\.space, etherscan, tronscan, etc\)\./,
    );
    expect(body).toMatch(
      /If the explorer\s*\n?\s*shows <strong>not yet broadcast<\/strong>, the issue is on/,
    );
    expect(body).toMatch(
      /<strong>Check the order's required confirmations\.<\/strong>\s*\n?\s*Bitcoin needs 2 blocks \(~20 min\); Ethereum needs 12 \(~3 min\);\s*\n?\s*USDC\/USDT on Tron is near-instant\./,
    );
    expect(body).toMatch(
      /<strong>Wait at least 30 minutes\.<\/strong> Mempool congestion\s*\n?\s*\+ RPC propagation lag can easily push a normally-fast network\s*\n?\s*to 15\+ minutes\. If you're past 30 min with a confirmed TX,\s*\n?\s*skip to the support escalation below\./,
    );
  });

  it("Partial 3-cause + support-top-up framing pinned: exchange-rate moved between quote + broadcast + network-fees-deducted-on-your-side + wrong-coin-right-address (USDC instead of USDT) + 'Partial orders need a human. Email support@driftstack.dev with your order_id + the TX hash. We'll generate a top-up invoice for the difference — that's the resolution path. Crypto payments are non-refundable (policy), so we don't send the partial back; we complete the order via top-up instead.' — pinned so the 3-cause + top-up-resolution-via-support + don't-send-partial-back commitment survives", () => {
    expect(body).toMatch(
      /<li>The exchange rate moved between when we generated the quote and when your wallet broadcast\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Network fees were deducted on your side and we received less than the displayed amount\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>You sent the wrong coin to the right address \(e\.g\. USDC instead of USDT\) and our deposit detector saw partial value\.<\/li>/,
    );
    expect(body).toMatch(
      /Partial orders need a human\. Email\s*\n?\s*<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>\s*\n?\s*with your <code>order_id<\/code> \+ the TX hash\. We'll generate\s*\n?\s*a top-up invoice for the difference — that's the resolution\s*\n?\s*path\. Crypto payments are non-refundable\s*\n?\s*\(<a href="\/legal\/refunds">policy<\/a>\), so we don't send the\s*\n?\s*partial back; we complete the order via top-up instead\./,
    );
  });

  it("Failed 3-cause + funds-left-wallet escalation framing pinned: 'failed means one of: NowPayments rejected the payment, the order timed out (24h with no on-chain activity), or the provider declined the payment on their side. In all three cases the next step is the same — open a fresh order from /pricing and try again.' + 'If funds left your wallet but the order is failed: that's a reconciliation problem — escalate to support immediately with the TX hash. In the rare event the upstream provider (NowPayments) returns funds to you on their own, that is a NowPayments-side action and outside Driftstack's non-refundable scope.' — pinned so the 3-failed-cause + 24h-timeout + funds-left-wallet-escalation + NowPayments-side-action-outside-our-scope commitment survives", () => {
    expect(body).toMatch(
      /<code>failed<\/code> means one of: NowPayments rejected the\s*\n?\s*payment, the order timed out \(24h with no on-chain activity\),\s*\n?\s*or the provider declined the payment on their side\./,
    );
    expect(body).toMatch(
      /In all\s*\n?\s*three cases the next step is the same — open a fresh order\s*\n?\s*from <a href="\/pricing">\/pricing<\/a> and try again\./,
    );
    expect(body).toMatch(
      /<strong>If funds left your wallet but the order is failed<\/strong>:\s*\n?\s*that's a reconciliation problem — escalate to support\s*\n?\s*immediately with the TX hash\./,
    );
    expect(body).toMatch(
      /In the rare event the upstream\s*\n?\s*provider \(NowPayments\) returns funds to you on their own, that\s*\n?\s*is a NowPayments-side action and outside Driftstack's\s*\n?\s*non-refundable scope\./,
    );
  });

  it("Wrong-network 2-class framing pinned: 'USDC-ERC20 vs USDC-TRC20 is the classic landmine. The displayed deposit address only works on the network shown in the checkout UI.' + EVM↔EVM (e.g. ERC-20 → BSC): addresses look identical, funds land at same address on wrong chain, often recoverable if you control destination + EVM↔non-EVM (different address formats; transaction usually rejects; if not, stuck, recovery chain-dependent) + 'We do our best to help recover wrong-network sends but cannot guarantee it.' — pinned so the 2-class wrong-network + can-help-but-cannot-guarantee commitment survives", () => {
    expect(body).toMatch(
      /USDC-ERC20 vs USDC-TRC20 is the classic landmine\. The displayed\s*\n?\s*deposit address only works on the network shown in the checkout\s*\n?\s*UI\./,
    );
    expect(body).toMatch(
      /<strong>EVM ↔ EVM \(e\.g\. ERC-20 → BSC\)<\/strong>: addresses\s*\n?\s*look identical but funds land at the same address on the\s*\n?\s*wrong chain\. Often recoverable if you control the destination\s*\n?\s*— contact support with the TX hash\./,
    );
    expect(body).toMatch(
      /<strong>EVM → non-EVM<\/strong> \(or vice versa\): different\s*\n?\s*address formats; the transaction usually rejects\./,
    );
    expect(body).toMatch(
      /We do our best to help recover wrong-network sends but cannot\s*\n?\s*guarantee it\. Always double-check the network indicator in the\s*\n?\s*checkout UI before broadcasting\./,
    );
  });

  it("Single-use checkout framing pinned: 'The checkout page is single-use — refreshing it does not re-display the address.' + 2-recovery-path (find order in Billing → Crypto orders + re-open address modal / cancel-while-pending + start-fresh) — pinned so the single-use-checkout + 2-recovery-path commitment survives", () => {
    expect(body).toMatch(
      /The checkout page is single-use — refreshing it does not\s*\n?\s*re-display the address\./,
    );
    expect(body).toMatch(
      /<li>Find the order in <strong>Billing → Crypto orders<\/strong>\s*\n?\s*and click it to re-open the address modal, or<\/li>/,
    );
    expect(body).toMatch(
      /<li>Cancel the order \(only possible while still\s*\n?\s*<code>pending<\/code> with no payment activity\) and start\s*\n?\s*fresh from <a href="\/pricing">\/pricing<\/a>\.<\/li>/,
    );
  });

  it('Receipt 3-format curl-example pinned: JSON envelope + Plain text (cron / wget pipelines) + PDF (accounting / archival) + Bearer Authorization $DRIFTSTACK_API_KEY + curl URL patterns — pinned so the 3-format curl examples + Bearer-token auth + canonical-URL-pattern commitment survives', () => {
    expect(body).toMatch(/# JSON envelope \(programmatic\)/);
    expect(body).toMatch(/curl -H "Authorization: Bearer \$DRIFTSTACK_API_KEY"/);
    expect(body).toMatch(
      /https:\/\/api\.driftstack\.dev\/v1\/billing\/crypto-orders\/ord_…\/receipt$/m,
    );
    expect(body).toMatch(/# Plain text \(cron \/ wget pipelines\)/);
    expect(body).toMatch(/\/v1\/billing\/crypto-orders\/ord_…\/receipt\.txt/);
    expect(body).toMatch(/# PDF \(accounting \/ archival\)/);
    expect(body).toMatch(/\/v1\/billing\/crypto-orders\/ord_…\/receipt\.pdf/);
    expect(body).toMatch(/-o receipt\.pdf/);
  });

  it("Support-escalation 5-bullet template + 1-biz-day SLA framing pinned: account email/account_id + order_id + TX hash (explorer link) + network sent on (Ethereum mainnet / Tron / BSC) + screenshot of wallet send-confirmation + 'Response SLA is 1 business day on the free trial + paid tiers; enterprise contracts get a per-contract SLA. Most payment escalations resolve same-day once we have the TX hash.' — pinned so the 5-bullet template + 1-biz-day SLA + same-day-with-TX-hash commitment survives", () => {
    expect(body).toMatch(/<li>Your account email \(or account_id if you have it handy\)\.<\/li>/);
    expect(body).toMatch(/<li>The <code>order_id<\/code> we minted at checkout\.<\/li>/);
    expect(body).toMatch(/<li>The TX hash \(any explorer link is fine\)\.<\/li>/);
    expect(body).toMatch(
      /<li>The network you sent on \(Ethereum mainnet, Tron, BSC, etc\.\)\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>A screenshot of your wallet's send confirmation if you\s*\n?\s*still have it\.<\/li>/,
    );
    expect(body).toMatch(
      /Response SLA is 1 business day on the free trial \+ paid tiers;\s*\n?\s*enterprise contracts get a per-contract SLA\. Most payment\s*\n?\s*escalations resolve same-day once we have the TX hash\./,
    );
  });

  it("3-related-doc cluster: /docs/billing-crypto-overview + /docs/billing-faq + /docs/webhooks-crypto-events (crypto.order.paid webhook events, now subscribable so no roadmap label) — pinned so the 3-related-doc navigation surface stays complete. The crypto.order.paid event was promoted to subscribable, so the previous '(roadmap)' label on the webhook cross-ref is dropped; ban its return so the not-yet-subscribable signal cannot creep back.", () => {
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-overview">Crypto payments — how it works<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/billing-faq">Billing FAQ<\/a>/);
    expect(body).toMatch(
      // S47 2026-07-07 (founder-approved: mirror deprecation): the webhooks-crypto-events mirror is deleted; href re-pinned to the docs successor.
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/"><code>crypto\.order\.paid<\/code> webhook events<\/a>/,
    );
    // Anti-drift: the event is now subscribable; the old "(roadmap)" label
    // on this cross-ref must NOT return.
    expect(body).not.toMatch(/webhook events \(roadmap\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
