// W329.B — drift guard for cross-page trial-pack figure consistency.
// The marketing homepage hero copy hard-codes "$2.99" and "16 hours".
// The pricing page data module declares the canonical figures
// (TRIAL_PACK.priceUsd = 2.99, TRIAL_PACK.hoursApprox = 16). If
// either side drifts, the customer sees inconsistent numbers
// between the landing CTA and the pricing page.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_PACK } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W329.B / hero ↔ TRIAL_PACK cross-alignment', () => {
  const body = read(INDEX);

  it('homepage hero price string matches TRIAL_PACK.priceUsd', () => {
    const priceStr = `$${TRIAL_PACK.priceUsd.toFixed(2)}`;
    expect(body).toContain(priceStr);
  });

  it('homepage hero hours claim matches TRIAL_PACK.hoursApprox', () => {
    const hoursStr = `${TRIAL_PACK.hoursApprox} hours`;
    expect(body).toContain(hoursStr);
  });

  it('CTA anchor points at /pricing#trial-pack (same anchor pricing page defines)', () => {
    expect(body).toContain('/pricing#trial-pack');
  });

  it('TRIAL_PACK.oncePerAccount aligns with homepage copy framing', () => {
    expect(TRIAL_PACK.oncePerAccount).toBe(true);
    // The homepage doesn't have to spell out "once per account" but
    // the description meta tag does — assert the framing exists.
    expect(body).toMatch(/(?:one trial per account|used once)/i);
  });
});
