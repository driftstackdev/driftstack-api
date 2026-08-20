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
import { loadConfig } from '../../src/lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// path the email links to (under the app's origin) → the .astro page that
// serves it, in app `apps/<app>/src/pages`. W473 — extended to the status-site
// double-opt-in links (subscribe/confirm + unsubscribe), the same email→page
// class as team-accept but a different app.
const EMAIL_LINKED_PATHS: Array<{ path: string; page: string; source: string; app: string }> = [
  // customer-dashboard (DASHBOARD_ORIGIN)
  { path: '/verify-email', page: 'verify-email.astro', source: 'auth-flows signup-verification', app: 'customer-dashboard' }, // prettier-ignore
  { path: '/auth/magic-link', page: 'auth/magic-link.astro', source: 'auth-flows magic-link', app: 'customer-dashboard' }, // prettier-ignore
  { path: '/reset-password', page: 'reset-password.astro', source: 'auth-flows password-reset', app: 'customer-dashboard' }, // prettier-ignore
  { path: '/team/accept', page: 'team/accept.astro', source: 'team-members invite', app: 'customer-dashboard' }, // prettier-ignore
  { path: '/auth/oauth-client/confirm-merge', page: 'auth/oauth-client/confirm-merge.astro', source: 'oauth-client verify-merge', app: 'customer-dashboard' }, // prettier-ignore
  { path: '/settings', page: 'settings.astro', source: 'byok rotation-reminder', app: 'customer-dashboard' }, // prettier-ignore
  // status-site (statusPageBaseUrl) — double-opt-in + one-click unsubscribe
  { path: '/subscribe/confirm', page: 'subscribe/confirm.astro', source: 'status double-opt-in', app: 'status-site' }, // prettier-ignore
  { path: '/subscribe/unsubscribe', page: 'subscribe/unsubscribe.astro', source: 'status unsubscribe', app: 'status-site' }, // prettier-ignore
];

describe('W472/W473 transactional-email links resolve to real pages', () => {
  for (const { path, page, source, app } of EMAIL_LINKED_PATHS) {
    it(`${source} email → ${path} has a page (apps/${app}/.../${page})`, () => {
      const full = resolve(REPO_ROOT, 'apps', app, 'src/pages', page);
      expect(
        existsSync(full),
        `${source} email links to ${path} but ${app}/${page} is missing — users would 404. Create the page or update the email link.`,
      ).toBe(true);
    });
  }
  it('CRITICAL V-1109 every auth-flow URL the server config declares is in this table. The header says to add a row when a new transactional email links somewhere, which is the instruction that was not followed the last time — W472 found a team-invite link with no page, and its own note is that "nothing cross-checked it". The three auth-flow links ARE declared in one place (`config.authFlowUrls`), so for those the table no longer has to be remembered. The team-invite and status-site rows stay hand-listed because no single declaration enumerates them.', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DASHBOARD_ORIGIN: 'https://app.driftstack.local',
    });
    const declared = Object.entries(cfg.authFlowUrls)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('http'))
      .map(([name, url]) => [name, new URL(url).pathname] as const);
    expect(declared.length, 'URL-valued authFlowUrls entries discovered').toBeGreaterThanOrEqual(3);

    const rostered = new Set(EMAIL_LINKED_PATHS.map((e) => e.path));
    const unlisted = declared
      .filter(([, path]) => !rostered.has(path))
      .map(([name, path]) => `${name} -> ${path}`)
      .sort();
    expect(
      unlisted,
      'auth-flow URL(s) the server sends customers to that this table does not cover — the page ' +
        'behind them is unchecked, which is the exact shape W472 found:',
    ).toEqual([]);
  });
});
