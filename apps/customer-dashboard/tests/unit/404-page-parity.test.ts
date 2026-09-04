// W273.B — drift-guard for customer-dashboard /404 page. Pins the
// fallback link to the dashboard root and forbids dead /signin or
// /dashboard self-link traps.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W273.B /404 page navigation parity', () => {
  const page = read(PAGE);

  it('back link points to dashboard root', () => {
    expect(page).toMatch(/href="\/"/);
  });

  it('does not reference legacy /signin path', () => {
    expect(page).not.toMatch(/['"]\/signin['"]/);
  });

  it('does not embed a hard-coded https://app.driftstack.io host', () => {
    // Internal hrefs should be path-relative; absolute customer-facing
    // URLs are derived from PUBLIC_DASHBOARD_ORIGIN at runtime.
    expect(page).not.toMatch(/https?:\/\/app\.driftstack\.io/);
  });
});
