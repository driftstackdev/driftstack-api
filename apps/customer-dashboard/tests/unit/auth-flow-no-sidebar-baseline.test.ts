// W302.C — drift guard for customer-dashboard auth-flow pages.
// Pages used before the user is signed in (login / signup /
// forgot-password / reset-password / verify-email / select-tier /
// welcome / cli/authorize) must declare `withSidebar={false}` on
// DashboardLayout so the sidebar nav (with auth-gated routes) doesn't
// render before the user is signed in. (first-session removed 2026-07-02
// with the account-portal IA.)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AUTH_FLOW_PAGES = [
  'login.astro',
  'signup.astro',
  'forgot-password.astro',
  'reset-password.astro',
  'verify-email.astro',
  'select-tier.astro',
  // 404 is also rendered without sidebar.
  '404.astro',
];

describe('W302.C auth-flow page sidebar-disabled baseline', () => {
  for (const page of AUTH_FLOW_PAGES) {
    it(`${page} disables the sidebar (withSidebar={false})`, () => {
      const path = resolve(PAGES, page);
      if (!existsSync(path)) {
        throw new Error(
          `auth-flow page ${page} is missing at ${path}: a retired page must be removed from AUTH_FLOW_PAGES, not skipped — skipping would let the sidebar guard go green on a page that no longer exists`,
        );
      }
      const body = read(path);
      expect(body).toMatch(/<DashboardLayout\b[^>]*\bwithSidebar=\{false\}/);
    });
  }
});
