// W285.A — drift guard for welcome.astro CTA targets. The free-tier
// "Start free" CTA goes to /first-session (no purchase); the upgrade
// CTA goes to /select-tier. (The one-time trial pack + its
// ?focus=trial deep-link were retired 2026-05-27.)

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

describe('W285.A welcome page CTA consistency', () => {
  const body = read(PAGE);

  it('free-tier primary CTA links to /first-session (no purchase step)', () => {
    expect(body).toMatch(/href=["']\/first-session["']/);
  });

  it('upgrade CTA links to /select-tier', () => {
    expect(body).toMatch(/href=["']\/select-tier["']/);
  });

  it('does not link to the legacy /pricing route from the dashboard', () => {
    // Dashboard pages should use /select-tier, not marketing /pricing.
    expect(body).not.toMatch(/href=["']\/pricing/);
  });
});
