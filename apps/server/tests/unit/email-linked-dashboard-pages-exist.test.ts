// W472 — regression guard: every dashboard path that a transactional email
// links to must have a real customer-dashboard page.
//
// Found live (W472): the team-invite email linked to `${DASHBOARD_ORIGIN}/team/
// accept?token=...` but `/team/accept` had no page — invitees 404'd and could
// not join. The backend route, the email, and the docs all referenced the page;
// only the page file was missing, and nothing cross-checked it. These links are
// auth/onboarding-critical (verify, reset, magic-link, team-accept, IDP-merge):
// a 404 there silently blocks a customer with no other signal. This pins the
// server-email-link-path ↔ dashboard-page correspondence.
//
// When a new transactional email links to a dashboard path, add it here.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

// path the email links to (under DASHBOARD_ORIGIN) → the .astro page that serves it.
const EMAIL_LINKED_PATHS: Array<{ path: string; page: string; source: string }> = [
  { path: '/verify-email', page: 'verify-email.astro', source: 'auth-flows signup-verification' },
  { path: '/auth/magic-link', page: 'auth/magic-link.astro', source: 'auth-flows magic-link' },
  { path: '/reset-password', page: 'reset-password.astro', source: 'auth-flows password-reset' },
  { path: '/team/accept', page: 'team/accept.astro', source: 'team-members invite' },
  {
    path: '/auth/oauth-client/confirm-merge',
    page: 'auth/oauth-client/confirm-merge.astro',
    source: 'oauth-client verify-merge',
  },
];

describe('W472 transactional-email dashboard links resolve to real pages', () => {
  for (const { path, page, source } of EMAIL_LINKED_PATHS) {
    it(`${source} email → ${path} has a dashboard page (${page})`, () => {
      const full = resolve(PAGES, page);
      expect(
        existsSync(full),
        `${source} email links to ${path} but ${page} is missing — invitees/users would 404. Create the page or update the email link.`,
      ).toBe(true);
    });
  }
});
