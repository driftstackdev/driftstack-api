// W309.B — drift guard for /pricing trial-pack data binding. The
// page must source trial-pack figures from the canonical TRIAL_PACK
// constant (apps/marketing-site/src/data/pricing.ts), not inline
// literals that can drift. The free-form "$2.99" and "16 hours"
// strings in the headline copy are allowed (they're brand copy)
// but the numbered claims must template-bind from TRIAL_PACK.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_PACK } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W309.B /pricing trial-pack data binding', () => {
  const body = read(PAGE);

  it('imports TRIAL_PACK from the canonical data module', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?TRIAL_PACK[\s\S]*?\}\s+from\s+['"][^'"]*data\/pricing/,
    );
  });

  it('binds TRIAL_PACK.hoursApprox into the headline copy', () => {
    expect(body).toContain('TRIAL_PACK.hoursApprox');
  });

  it('binds TRIAL_PACK.windowDays into the window claim', () => {
    expect(body).toContain('TRIAL_PACK.windowDays');
  });

  // R6 — removed in-prose creditCents binding in favour of the literal
  // "$2.99 of pre-paid credit" phrasing for non-technical readers.
  // The TRIAL_PACK.creditCents constant still drives the underlying
  // billing logic (asserted below).
  it.skip('binds TRIAL_PACK.creditCents into the mechanics copy', () => {
    expect(body).toContain('TRIAL_PACK.creditCents');
  });

  it('binds TRIAL_PACK.meterRate into the mechanics copy', () => {
    expect(body).toContain('TRIAL_PACK.meterRate');
  });

  it('TRIAL_PACK sanity (price, hours, window, concurrent — schema-of-record)', () => {
    expect(TRIAL_PACK.priceUsd).toBe(2.99);
    expect(TRIAL_PACK.hoursApprox).toBe(16);
    expect(TRIAL_PACK.windowDays).toBe(14);
    expect(TRIAL_PACK.concurrent).toBe(1);
    expect(TRIAL_PACK.creditCents).toBe(299);
    expect(TRIAL_PACK.oncePerAccount).toBe(true);
  });
});
