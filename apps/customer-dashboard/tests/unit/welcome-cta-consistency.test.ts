// W285.A — drift guard for welcome.astro CTA targets. The Trial
// pack CTA must include `?focus=trial` so the select-tier page
// scrolls to the Trial Pack card on landing.

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

  it('Trial Pack primary CTA links to /select-tier?focus=trial', () => {
    expect(body).toMatch(/href=["']\/select-tier\?focus=trial["']/);
  });

  it('Secondary CTA links to /select-tier without focus', () => {
    expect(body).toMatch(/href=["']\/select-tier["']/);
  });

  it('does not link to the legacy /pricing route from the dashboard', () => {
    // Dashboard pages should use /select-tier, not marketing /pricing.
    expect(body).not.toMatch(/href=["']\/pricing/);
  });
});
