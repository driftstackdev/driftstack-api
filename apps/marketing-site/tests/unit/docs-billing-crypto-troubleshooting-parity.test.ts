// W355.B — drift guard for /docs/billing-crypto-troubleshooting.
// The customer-facing decision tree for crypto-payment problems.
// Pinned:
//
//   • The four status terms it cites in symptom headings
//     (pending / partial / failed / paid) are all valid
//     CryptoOrderStatus values.
//   • Confirmation-block claims (BTC 2 / ETH 12 / Tron near-instant)
//     stay pinned as customer-facing copy.
//   • 30-minute escalation threshold pinned (the customer-facing
//     "if you're past this, escalate" line).
//   • 24-hour failed-due-to-timeout claim pinned.
//   • Three receipt formats (JSON / .txt / .pdf) all reachable from
//     the same /v1/billing/crypto-orders/:id/receipt prefix.
//   • Non-refundable policy cross-link to /legal/refunds resolves.
//   • Support contact + 1-business-day SLA on paid + trial tiers.
//   • Cross-links to /docs/billing-crypto-overview + /docs/billing-faq
//     + /docs/webhooks-crypto-events resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/billing-crypto-troubleshooting.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W355.B /docs/billing-crypto-troubleshooting parity', () => {
  const body = read(PAGE);
  const statusValues = new Set<string>(
    (CryptoOrderStatusSchema._def as { values: readonly string[] }).values,
  );

  it('symptom-heading status terms (pending / partial / failed / paid) are all in CryptoOrderStatusSchema', () => {
    for (const term of ['pending', 'partial', 'failed', 'paid']) {
      expect(body).toContain(`<code>${term}</code>`);
      expect(statusValues.has(term)).toBe(true);
    }
  });

  it('cites the confirming → paid transition (also a real schema status)', () => {
    expect(body).toMatch(/<code>confirming<\/code>,\s*then <code>paid<\/code>/);
    expect(statusValues.has('confirming')).toBe(true);
  });

  it('confirmation-block claims pinned: BTC 2 blocks, ETH 12 blocks, Tron near-instant', () => {
    expect(body).toMatch(/Bitcoin needs 2 blocks/);
    expect(body).toMatch(/Ethereum needs 12/);
    expect(body).toMatch(/USDC\/USDT on Tron is near-instant/);
  });

  it('30-minute escalation threshold pinned (customer-facing copy)', () => {
    expect(body).toMatch(/Wait at least 30 minutes/);
    expect(body).toMatch(/past 30 min with a confirmed TX/);
  });

  it('24-hour timeout claim on failed orders pinned', () => {
    expect(body).toMatch(/timed out \(24h with no on-chain activity\)/);
  });

  it('three receipt formats reachable from /v1/billing/crypto-orders/:id/receipt', () => {
    // JSON envelope is the bare /receipt endpoint, plus .txt + .pdf.
    expect(body).toMatch(/\/v1\/billing\/crypto-orders\/ord_…\/receipt(?!\.txt|\.pdf)/);
    expect(body).toContain('/v1/billing/crypto-orders/ord_…/receipt.txt');
    expect(body).toContain('/v1/billing/crypto-orders/ord_…/receipt.pdf');
  });

  it('non-refundable cross-link to /legal/refunds resolves (single canonical refund-policy entry)', () => {
    expect(body).toContain('/legal/refunds');
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md')),
      'legal/refunds.md must exist (legal-filename convention is short slugs)',
    ).toBe(true);
  });

  it('support contact + 1-business-day SLA pinned on free-trial + paid tiers', () => {
    expect(body).toContain('support@driftstack.dev');
    expect(body).toMatch(/Response SLA is 1 business day on the free trial \+ paid tiers/);
    expect(body).toMatch(/enterprise contracts get a per-contract SLA/);
  });

  it('cross-links to /docs/billing-crypto-overview + /docs/billing-faq + /docs/webhooks-crypto-events resolve', () => {
    for (const [href, path] of [
      [
        '/docs/billing-crypto-overview',
        'apps/marketing-site/src/pages/docs/billing-crypto-overview.astro',
      ],
      ['/docs/billing-faq', 'apps/marketing-site/src/pages/docs/billing-faq.astro'],
      [
        // S47 2026-07-07 (founder-approved: mirror deprecation): the
        // webhooks-crypto-events mirror is deleted; the page
        // cross-links its docs successor.
        'https://docs.driftstack.dev/webhooks/crypto-events/',
        'apps/docs/src/pages/webhooks/crypto-events.md',
      ],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });

  it('partial-order resolution path: top-up (NOT refund) pinned', () => {
    expect(body).toMatch(/generate\s*a top-up invoice for the difference/);
    expect(body).toMatch(/Crypto payments are non-refundable/);
  });

  it('checkout single-use claim pinned (refreshing the page does not re-display the address)', () => {
    expect(body).toMatch(/checkout page is single-use/);
    expect(body).toMatch(/refreshing it does not\s*re-display the address/);
  });
});
