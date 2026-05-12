// W295.B — drift guard for marketing FAQ trial-pack citations.
// The FAQ cites $2.99, 16 hours, 14-day window, $0.18/hr meter —
// each of those must match the canonical TRIAL_PACK constants in
// pricing.ts. Catches drift where pricing.ts changes but copy
// doesn't (or vice versa).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_PACK } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FAQ = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W295.B FAQ ↔ TRIAL_PACK constants parity', () => {
  const body = read(FAQ);

  it('FAQ cites the canonical $2.99 trial-pack price', () => {
    expect(TRIAL_PACK.priceUsd).toBe(2.99);
    expect(body).toMatch(/\$2\.99/);
  });

  it('FAQ cites the canonical ~16 hours hours-approximation', () => {
    expect(TRIAL_PACK.hoursApprox).toBe(16);
    expect(body).toMatch(/16(?:\.6)? ?hours/);
  });

  it('FAQ cites the canonical 14-day expiry window', () => {
    expect(TRIAL_PACK.windowDays).toBe(14);
    expect(body).toMatch(/14 ?days/);
  });

  it('FAQ cites the canonical $0.18/concurrent-hour rate', () => {
    // TRIAL_PACK.meterRate is a sentence; the price `$0.18` is the
    // invariant part we anchor on.
    expect(TRIAL_PACK.meterRate).toMatch(/\$0\.18/);
    expect(body).toMatch(/\$0\.18/);
  });
});
