// W344.B — drift guard for the /billing page STATUS_BADGE_CLASS
// map. Every SubscriptionStatusSchema enum value needs a badge
// class entry, otherwise the page renders an un-styled span for
// that status (e.g. a `past_due` row paints in default colour).
//
// The page also uses one "virtual" status — 'no_subscription' —
// for the neutral SSR state and when the live billing response carries
// no subscription object. That's deliberate and
// is allowed to coexist with the schema values; the test pins
// that exception explicitly so the cause is documented.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W344.B /billing STATUS_BADGE_CLASS ↔ SubscriptionStatusSchema parity', () => {
  const page = read(PAGE);
  const schemaValues = new Set<string>(
    (SubscriptionStatusSchema._def as { values: readonly string[] }).values,
  );

  const block = page.match(/STATUS_BADGE_CLASS:[^={]*=?\s*\{([\s\S]*?)\};/);
  expect(block).not.toBeNull();
  const keys = new Set<string>(
    [...block![1]!.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!),
  );

  it('every SubscriptionStatus has a STATUS_BADGE_CLASS entry', () => {
    const missing = [...schemaValues].filter((s) => !keys.has(s));
    expect(missing).toEqual([]);
  });

  it('schema is the full 8-status surface (canary against accidental enum truncation)', () => {
    expect(schemaValues.size).toBe(8);
  });

  it("'no_subscription' is the only non-schema badge key allowed (virtual state)", () => {
    // Every key must be either a real schema value or the virtual
    // 'no_subscription' fallback. Any other key is a typo / stale
    // status name.
    const offenders = [...keys].filter((k) => !schemaValues.has(k) && k !== 'no_subscription');
    expect(offenders).toEqual([]);
    expect(keys.has('no_subscription')).toBe(true);
  });

  it('active uses the ready token (positive billing state), past_due/unpaid use the err token (recovery state) — Fleet v2 2026-07-02 moved severities onto the two-axis status tokens so badges flip with data-mode', () => {
    expect(block![1]!).toMatch(/active:\s*'[^']*tk-ready[^']*'/);
    expect(block![1]!).toMatch(/past_due:\s*'[^']*tk-err[^']*'/);
    expect(block![1]!).toMatch(/unpaid:\s*'[^']*tk-err[^']*'/);
  });

  it('trialing/incomplete use tk-accent (transient/needs-action state, R2 dark migration)', () => {
    expect(block![1]!).toMatch(/trialing:\s*'[^']*tk-accent[^']*'/);
    expect(block![1]!).toMatch(/incomplete:\s*'[^']*tk-accent[^']*'/);
  });

  it("page uses 'no_subscription' for neutral SSR and live empty billing", () => {
    expect(page).toMatch(/STATUS_BADGE_CLASS\.no_subscription/);
    expect(page).toMatch(/setStatusBadge\('no subscription', 'no_subscription'\)/);
  });

  it("page narrative pins the 'Stripe portal' redirect framing for payment changes", () => {
    expect(page).toMatch(/All payment changes redirect to Stripe's secure portal/);
    expect(page).toMatch(/Manage in Stripe portal/);
  });
});
