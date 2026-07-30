// W265.B — public operational-cost docs ↔ live route and aggregator truth.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = read('apps/marketing-site/src/pages/docs/cost-monitoring.astro');
const ROUTE = read('apps/server/src/routes/account-cost.ts');
const COST_SERVICE = read('apps/server/src/services/cost-monitoring.ts');
const AGGREGATOR = read('apps/server/src/services/cost-aggregator.ts');
const USAGE = read('apps/server/src/services/usage.ts');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('W265.B operational cost estimate public/runtime parity', () => {
  it('documents the registered UTC-month endpoint and zero fresh-account response', () => {
    expect(PAGE).toMatch(/GET \/v1\/account\/cost\?billing_cycle=YYYY-MM/);
    expect(ROUTE).toContain(`'/v1/account/cost'`);
    // 8636d5021 (2026-07-17) hoisted the inline /^\d{4}-\d{2}$/ into the shared
    // BILLING_CYCLE_PATTERN, which is strictly tighter (rejects month 00 and
    // 13–99) while documenting the same YYYY-MM contract to customers.
    expect(ROUTE).toContain('billing_cycle: z.string().regex(BILLING_CYCLE_PATTERN).optional()');
    expect(COST_SERVICE).toContain(
      'export const BILLING_CYCLE_PATTERN = /^\\d{4}-(?:0[1-9]|1[0-2])$/;',
    );
    expect(PAGE).toMatch(/synthesised zero-breakdown for fresh accounts/);
    expect(PAGE).toMatch(/\(no 404\)/);
  });

  it('pins compute as the only populated production input and four reserved zero fields', () => {
    expect(AGGREGATOR).toMatch(/const sessionMinutes = totals\.totals\.session_minute \?\? 0/);
    for (const input of [
      'storageGbMonths: 0',
      'egressGb: 0',
      'emailSends: 0',
      'llmInputTokens: 0',
      'llmOutputTokens: 0',
    ]) {
      expect(AGGREGATOR).toContain(input);
    }
    for (const field of ['storageCents', 'egressCents', 'emailCents', 'llmCents']) {
      expect(PAGE).toMatch(new RegExp(`<code class="font-mono">${field}<\\/code>[\\s\\S]*?zero`));
      expect(PAGE).toMatch(new RegExp(`"${field}": 0`));
    }
  });

  it('keeps browser subscriptions fixed/concurrency-only and the endpoint out of billing truth', () => {
    expect(USAGE).toMatch(/All TIER_QUOTAS values are now `null` \(unmetered\) across every/);
    expect(PAGE).toMatch(
      /Browser subscriptions are fixed-price and enforced by concurrent-session/,
    );
    expect(PAGE).toMatch(/It is not\s+the amount charged to you/);
    expect(PAGE).toMatch(/does not replace a Stripe invoice or\s+NowPayments receipt/);
    expect(PAGE).not.toMatch(/will move to nightly|metered overage charges|customer's bill/i);
  });

  it('separates the bundled-LLM included-service budget from cost and Stripe invoices', () => {
    expect(PAGE).toMatch(/10-cent-per-turn included-service budget value/);
    expect(PAGE).toMatch(/not rolled into\s+this estimate or separately itemized by Stripe today/);
    expect(PAGE).toMatch(/<code class="font-mono">llmCents<\/code> currently returns zero/);
  });

  it('describes thresholds as operator posture with no customer billing or control effect', () => {
    for (const state of ['under-soft', 'between-soft-and-hard', 'over-hard']) {
      expect(PAGE).toContain(state);
    }
    expect(PAGE).toMatch(/operator-tuned unit-economics configuration/);
    expect(PAGE).toMatch(/does not email a customer billing warning/);
    expect(PAGE).toMatch(/add an invoice item, rate-limit a session, or silently stop work/);
  });
});
