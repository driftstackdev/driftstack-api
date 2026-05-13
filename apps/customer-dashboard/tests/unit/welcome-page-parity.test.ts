// W268.C — drift-guard for customer-dashboard /welcome onboarding page.
// Pins:
// 1. Trial Pack price $2.99 matches TRIAL_PACK data.
// 2. Trial Pack hours ≈16 / 14-day window matches TRIAL_PACK data.
// 3. Subscription price range $79–$1,499 matches API_TIERS span.
// 4. CTAs target /select-tier (the next onboarding step).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_PACK } from '../../../marketing-site/src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W268.C /welcome onboarding ↔ TRIAL_PACK + subscription parity', () => {
  const page = read(PAGE);

  it('Trial Pack price + hours + window match TRIAL_PACK data', () => {
    expect(TRIAL_PACK.priceUsd).toBe(2.99);
    expect(TRIAL_PACK.hoursApprox).toBe(16);
    expect(TRIAL_PACK.windowDays).toBe(14);
    expect(page).toMatch(/\$2\.99/);
    expect(page).toMatch(/16 hours of session time/);
    expect(page).toMatch(/14-day window/);
  });

  it('subscription price range $79–$1,499/mo matches the live tier ladder', () => {
    expect(page).toMatch(/\$79–\$1,499/);
  });

  it('CTAs target /select-tier (the next onboarding step)', () => {
    expect(page).toMatch(/href="\/select-tier(?:\?focus=trial)?"/);
  });

  it('no fictional tier-related claims (e.g. unlimited / free-forever)', () => {
    expect(page).not.toMatch(/free forever/i);
    expect(page).not.toMatch(/unlimited sessions/i);
    expect(page).not.toMatch(/lifetime/i);
  });

  it('iPhone Safari narrative is the canonical product framing', () => {
    expect(page).toMatch(/iPhone Safari sessions/);
    expect(page).toMatch(/the same browser engine/);
  });
});
