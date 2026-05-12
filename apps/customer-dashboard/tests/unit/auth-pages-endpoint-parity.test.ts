// W251.A — drift-guard for the dashboard's auth-flow pages. Pins
// every customer-facing auth page to the actual server-side
// endpoint it POSTs to, so renaming a route on the server side
// without updating the dashboard fails CI.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASH_PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function serverRegistersRoute(path: string): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.ts')) {
        if (read(p).includes(`'${path}'`)) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W251.A dashboard auth-page → server endpoint parity', () => {
  const verifyEmail = read(resolve(DASH_PAGES, 'verify-email.astro'));
  const forgotPassword = read(resolve(DASH_PAGES, 'forgot-password.astro'));
  const resetPassword = read(resolve(DASH_PAGES, 'reset-password.astro'));

  it('verify-email POSTs /v1/auth/verify-email which the server registers', () => {
    expect(verifyEmail).toContain(`/v1/auth/verify-email`);
    expect(serverRegistersRoute('/v1/auth/verify-email')).toBe(true);
  });

  it('forgot-password POSTs /v1/auth/password-reset/request which the server registers', () => {
    expect(forgotPassword).toContain(`/v1/auth/password-reset/request`);
    expect(serverRegistersRoute('/v1/auth/password-reset/request')).toBe(true);
  });

  it('reset-password POSTs /v1/auth/password-reset/confirm which the server registers', () => {
    expect(resetPassword).toContain(`/v1/auth/password-reset/confirm`);
    expect(serverRegistersRoute('/v1/auth/password-reset/confirm')).toBe(true);
  });

  it('verify-email auto-submits when ?token=… is present (W178)', () => {
    // Drift would re-introduce "user must paste the token" UX.
    expect(verifyEmail).toMatch(/params\.get\(['"]token['"]\)/);
    expect(verifyEmail).toMatch(/submitToken\(linkToken\)/);
  });

  it('reset-password auto-submits when ?token=… is present (W182)', () => {
    expect(resetPassword).toMatch(/params\.get\(['"]token['"]\)/);
  });
});
