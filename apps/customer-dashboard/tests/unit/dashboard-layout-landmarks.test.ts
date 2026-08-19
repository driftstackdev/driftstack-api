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

  it('layout declares a <main> landmark (with the skip-link target id + tabindex)', () => {
    expect(body).toMatch(/<main\b/);
    expect(body).toMatch(/<main\b[^>]*\bid="main-content"/);
    expect(body).toMatch(/<main\b[^>]*\btabindex="-1"/);
  });

  it('WCAG 2.4.1 skip link: "Skip to main content" anchor → #main-content (sr-only until focused)', () => {
    expect(body).toMatch(/href="#main-content"/);
    expect(body).toMatch(/sr-only focus:not-sr-only/);
    expect(body).toMatch(/Skip to main content/);
  });

  it('layout exposes a role=status region for screen-reader status updates', () => {
    expect(body).toMatch(/role=["']status["']/);
  });

  it('layout has a <nav> element for primary navigation', () => {
    expect(body).toMatch(/<nav\b/);
  });

  it('mobile hamburger has an accessible aria-label', () => {
    // Asserted, not assumed. This was "only enforce when a hamburger is
    // present", which meant renaming the control silently dropped the
    // accessibility check instead of failing — and of the three patterns only
    // `hamburger` matches today, so two thirds of the condition was already
    // dead. A control that disappears should fail here and be removed
    // deliberately, not vanish from coverage on a rename.
    expect(body, 'the layout still has a mobile menu control').toMatch(
      /hamburger|menu-toggle|menu-button/i,
    );
    expect(body).toMatch(/aria-label=["'][^"']+["']/);
  });
});
