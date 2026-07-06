// W491.A — drift guard for apps/customer-dashboard/src/pages/404.astro.
// Customer-facing 404 fallback. Drift here either drops the
// withSidebar={false} flag (a 404 would render with a sidebar
// that's pointed at a non-existent page, confusing customers)
// or swaps the canonical 'Back to dashboard' href='/' fallback
// (drift to /home or /index would 404 again in deployments
// where the dashboard is mounted differently).
//
//   • DashboardLayout import + title='404' + withSidebar={false}.
//   • '404' eyebrow + 'Page not found.' headline.
//   • 'Back to dashboard' CTA → href='/'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W491.A apps/customer-dashboard/src/pages/404.astro content parity', () => {
  const body = read(LIB);

  it("DashboardLayout import + title='404' + withSidebar={false} — pinned so the 404 fallback renders without the sidebar (a sidebar on a 404 would invite customers to click into pages from a 'this URL doesn't exist' context, creating confusion)", () => {
    expect(body).toMatch(/import DashboardLayout from '\.\.\/layouts\/DashboardLayout\.astro';/);
    expect(body).toMatch(/<DashboardLayout title="404" withSidebar=\{false\}>/);
  });

  it("404 eyebrow + 'Page not found.' headline + 'The page you were looking for has moved or doesn't exist.' — pinned so the customer-facing copy stays gentler than the admin-panel version (drift to harsher 'no page at this path' phrasing would mismatch the customer-dashboard voice)", () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">404<\/p>/,
    );
    expect(body).toMatch(/Page not found\./);
    expect(body).toMatch(/The page you were looking for has moved or doesn't exist\./);
  });

  it("'Back to dashboard' CTA href='/' (canonical fallback target) — pinned so the only escape-hatch on the customer 404 lands on the dashboard index (drift to /dashboard or /home would 404 again in environments where the dashboard mounts at root)", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back to dashboard<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
