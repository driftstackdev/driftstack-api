// V-079.C — cross-surface guard that the server's auth-flow URL
// defaults land on routes the customer-dashboard actually serves.
// The original bug (2026-05-12): server defaulted to
// `/auth/verify-email` but the dashboard's file-based route was
// `/verify-email` — every verification email pointed at a 404.
// This test reads the actual server config + asserts a dashboard
// page file exists at the resolved path's basename.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../server/src/lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASHBOARD_PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function pathToPage(url: string): string {
  const u = new URL(url);
  const route = u.pathname.replace(/^\/+|\/+$/g, '');
  // Astro file-based routing: `/verify-email` → `pages/verify-email.astro`,
  // `/auth/magic-link` → `pages/auth/magic-link.astro`.
  return resolve(DASHBOARD_PAGES, `${route}.astro`);
}

describe('V-079.C auth-flow URL ↔ dashboard route parity', () => {
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    DASHBOARD_ORIGIN: 'https://app.driftstack.local',
  });

  it('verifyEmail URL points to an existing dashboard page', () => {
    const page = pathToPage(cfg.authFlowUrls.verifyEmail);
    expect(existsSync(page), `dashboard page missing: ${page}`).toBe(true);
  });

  it('passwordReset URL points to an existing dashboard page', () => {
    const page = pathToPage(cfg.authFlowUrls.passwordReset);
    expect(existsSync(page), `dashboard page missing: ${page}`).toBe(true);
  });

  // #190 — magic-link dashboard page lives at /auth/magic-link.
  it('magicLink URL points to an existing dashboard page', () => {
    const page = pathToPage(cfg.authFlowUrls.magicLink);
    expect(existsSync(page), `dashboard page missing: ${page}`).toBe(true);
  });
  it('CRITICAL V-1109 every auth-flow URL the config declares lands on a page, not just the three named above. The arms above spell out verifyEmail, passwordReset and magicLink one at a time, so the set they cover is the set someone remembered — a fourth entry added to `authFlowUrls` would point wherever it liked and no arm would look at it. That is how the original bug shipped: the server default and the dashboard route disagreed and nothing cross-checked them.', () => {
    const urls = Object.entries(cfg.authFlowUrls).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('http'),
    );
    expect(urls.length, 'URL-valued authFlowUrls entries discovered').toBeGreaterThanOrEqual(3);

    const broken = urls
      .filter(([, url]) => !existsSync(pathToPage(url)))
      .map(([name, url]) => `${name} -> ${new URL(url).pathname} (no ${pathToPage(url)})`)
      .sort();
    expect(
      broken,
      'auth-flow URL(s) whose dashboard page does not exist — every email carrying one of these ' +
        'sends the customer to a 404 at an onboarding or recovery moment:',
    ).toEqual([]);
  });
});
