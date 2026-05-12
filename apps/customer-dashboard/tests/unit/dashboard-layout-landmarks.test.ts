// W282.B — drift guard for customer-dashboard layout accessibility
// landmarks. DashboardLayout.astro must expose <main>, a role=status
// region, and the nav structure for screen-reader users.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W282.B DashboardLayout accessibility landmarks', () => {
  const body = read(LAYOUT);

  it('layout declares a <main> landmark', () => {
    expect(body).toMatch(/<main\b/);
  });

  it('layout exposes a role=status region for screen-reader status updates', () => {
    expect(body).toMatch(/role=["']status["']/);
  });

  it('layout has a <nav> element for primary navigation', () => {
    expect(body).toMatch(/<nav\b/);
  });

  it('mobile hamburger has an accessible aria-label', () => {
    // Only enforce when a hamburger is present.
    if (/hamburger|menu-toggle|menu-button/i.test(body)) {
      expect(body).toMatch(/aria-label=["'][^"']+["']/);
    }
  });
});
