// W268.C — drift-guard for customer-dashboard /welcome onboarding page.
// Pins:
// 1. Free-tier "Start free" $0 / no-card framing (replaced the one-
//    time trial pack 2026-05-27 — TRIAL_PACK no longer exists in
//    marketing pricing).
// 2. Subscription price range $79–$1,499 matches API_TIERS span.
// 3. CTAs target /first-session (free start) + /select-tier (upgrade).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W268.C /welcome onboarding ↔ TRIAL_PACK + subscription parity', () => {
  const page = read(PAGE);

  it('free-tier "Start free" framing pinned ($0 / no card / no trial pack)', () => {
    expect(page).toMatch(/Start free/);
    expect(page).toMatch(/\$0 · no card/);
    // The one-time trial pack is gone — no purchase figures.
    expect(page).not.toMatch(/\$2\.99/);
    expect(page).not.toMatch(/trial pack/i);
  });

  it('subscription price range $79–$1,499/mo matches the live tier ladder', () => {
    expect(page).toMatch(/\$79–\$1,499/);
  });

  it('CTAs target /first-session (free start) + /select-tier (upgrade)', () => {
    expect(page).toMatch(/href="\/first-session"/);
    expect(page).toMatch(/href="\/select-tier"/);
  });

  it('no fictional tier-related claims (e.g. lifetime / unlimited-sessions)', () => {
    expect(page).not.toMatch(/free forever/i);
    expect(page).not.toMatch(/unlimited sessions/i);
    expect(page).not.toMatch(/lifetime/i);
  });

  it('iPhone Safari narrative is the canonical product framing (2026-05-16 honesty pass: "the same browser engine" → "the same engine"; whitespace-tolerant for line break between "same" and "engine")', () => {
    expect(page).toMatch(/iPhone Safari sessions/);
    expect(page).toMatch(/the same\s+engine/);
  });
});
