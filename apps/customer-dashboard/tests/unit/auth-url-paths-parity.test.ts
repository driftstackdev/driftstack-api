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

  // magicLink is documented as a not-yet-shipped flow — no
  // dashboard page exists, so we skip the parity check here. When
  // the magic-link page lands, drop the .skip.
  it.skip('magicLink URL points to an existing dashboard page', () => {
    const page = pathToPage(cfg.authFlowUrls.magicLink);
    expect(existsSync(page), `dashboard page missing: ${page}`).toBe(true);
  });
});
