// W514.B — canonical public copy guard for the operational cost estimate.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cost-monitoring.astro');
const body = readFileSync(LIB, 'utf8');

describe('W514.B marketing operational-cost docs content parity', () => {
  it('frames the customer route as an estimate, not billing or an invoice', () => {
    expect(body).toMatch(/customer-facing operational-cost docs/);
    expect(body).toMatch(/estimated cost-to-serve view, not customer billing or an invoice/);
    expect(body).toMatch(/Browser subscriptions are fixed-price/);
    expect(body).toMatch(/does not replace a Stripe invoice or\s+NowPayments receipt/);
  });

  it('pins compute-only production truth and the four reserved zero fields', () => {
    expect(body).toMatch(/Today only the compute\s+estimate is populated/);
    expect(body).toMatch(/Derived from session time in whole minutes/);
    expect(body).not.toMatch(/fleet-cost/);
    for (const label of [
      'Storage \\(reserved\\)',
      'Egress \\(reserved\\)',
      'Email \\(reserved\\)',
      'LLM \\(reserved here\\)',
    ]) {
      expect(body).toMatch(
        new RegExp(`<dt class="text-sm font-medium text-tk-ink">${label}<\\/dt>`),
      );
    }
    for (const field of ['storageCents', 'egressCents', 'emailCents', 'llmCents']) {
      expect(body).toMatch(new RegExp(`"${field}": 0`));
    }
    expect(body).toMatch(/"computeCents": 4720/);
    expect(body).toMatch(/"totalCents": 4720/);
  });

  it('keeps bundled-LLM accounting in its separate plan budget (2026-09-15 plain words: no "included-service budget" / Stripe internals on the customer page)', () => {
    expect(body).toMatch(/10-cent-per-turn budget that is included in your plan/);
    expect(body).toMatch(
      /not\s+rolled into this estimate and is not a separate item on your invoice\s+today/,
    );
    expect(body).toMatch(/GET \/v1\/account\/me\/bundled-llm-settings/);
    expect(body).not.toMatch(/contracted custom rate|billed on one invoice|per-token rate/i);
  });

  it('pins all threshold states as operator-only posture with no customer side effect', () => {
    for (const state of ['under-soft', 'between-soft-and-hard', 'over-hard']) {
      expect(body).toMatch(new RegExp(`>${state}<\\/span`));
    }
    expect(body).toMatch(/they are Driftstack's internal configuration/);
    expect(body).toMatch(
      /does not add an\s+overage, rate-limit new sessions, or stop work already running/,
    );
    expect(body).toMatch(/does not email a customer billing warning,\s+add an invoice item/);
  });

  it('pins the current request-time computation and payment sources of truth', () => {
    expect(body).toMatch(/endpoint recomputes on each request from your current session\s+minutes/);
    expect(body).toMatch(
      /Use Stripe billing state and\s+invoices, or the relevant NowPayments receipt, for payment truth/,
    );
    expect(body).not.toMatch(/will move to nightly|future|coming soon/i);
  });

  it("the three threshold-state chips use the site's one badge recipe (2026-09-25; they were hand-rolled washes with no hairline), in the status hue each state means", () => {
    expect(body).toMatch(/<span\s+class="badge badge--ready font-mono"\s*>under-soft<\/span/);
    expect(body).toMatch(
      /<span\s+class="badge badge--busy font-mono"\s*>between-soft-and-hard<\/span/,
    );
    expect(body).toMatch(/<span\s+class="badge badge--err font-mono"\s*>over-hard<\/span/);
    expect(body).not.toMatch(/inline-block rounded-full bg-tk-/);
  });

  it('keeps the live endpoint shape and fresh-account zero response', () => {
    expect(body).toMatch(/GET \/v1\/account\/cost\?billing_cycle=YYYY-MM/);
    expect(body).toMatch(/all-zero breakdown for fresh accounts/);
    expect(body).toMatch(/\(no 404\)/);
    expect(body).toMatch(/All amounts are integer accounting cents/);
    expect(existsSync(LIB)).toBe(true);
  });
});
