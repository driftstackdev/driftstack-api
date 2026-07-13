// W379.B — drift guard for 404 pages across all 4 customer-facing
// apps (marketing-site / customer-dashboard / admin-panel / status-
// site). 404 pages are the fallback surface a confused customer
// lands on; each carries app-specific load-bearing copy that must
// not drift:
//
//   • marketing-site: BaseLayout + 404/"This page drifted off."
//     (Fleet v2 2026-07-03) + useful-links row (home / pricing /
//     docs / status).
//   • customer-dashboard: DashboardLayout withSidebar={false} (so
//     the layout doesn't render a broken-link sidebar on the
//     fallback) + "Page not found." + Back-to-dashboard CTA.
//   • admin-panel: AdminLayout + admin-specific "no page at this
//     path" / "Check the sidebar links" copy + Back-to-overview
//     CTA.
//   • status-site: StatusLayout + status-site-specific framing
//     ("only hosts a single overview page plus per-incident
//     pages under /incident?id=<id>") + ←-Back-to-overview link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MARKETING = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/404.astro');
const DASHBOARD = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/404.astro');
const ADMIN = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/404.astro');
const STATUS = resolve(REPO_ROOT, 'apps/status-site/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W379.B cross-app 404 pages content parity', () => {
  describe('marketing-site /404.astro', () => {
    const body = read(MARKETING);

    it('uses BaseLayout + 404 title chip', () => {
      expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
      expect(body).toMatch(
        /<BaseLayout title="404 · Driftstack" description="Page not found\." noindex/,
      );
      expect(body).toMatch(/<p class="section-label">404<\/p>/);
    });

    it('marketing-specific copy: "This page drifted off." + "moved, doesn\'t exist, or never did"', () => {
      expect(body).toMatch(/This page drifted off\./);
      expect(body).toMatch(/The page you were looking for has moved, doesn't exist, or never did/);
    });

    it('useful-links row: Back home (primary) + See pricing / Read the docs / System status (secondary)', () => {
      expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
      expect(body).toMatch(/<a href="\/pricing\/" class="btn-secondary">See pricing<\/a>/);
      expect(body).toMatch(/<a href="\/docs\/" class="btn-secondary">Read the docs<\/a>/);
      expect(body).toMatch(
        /<a href="https:\/\/status\.driftstack\.dev" class="btn-secondary" rel="noopener noreferrer"/,
      );
    });
  });

  describe('customer-dashboard /404.astro', () => {
    const body = read(DASHBOARD);

    it('uses DashboardLayout with withSidebar={false} (fallback layout, no broken sidebar)', () => {
      expect(body).toMatch(/import DashboardLayout from '\.\.\/layouts\/DashboardLayout\.astro';/);
      expect(body).toMatch(/<DashboardLayout title="404" withSidebar=\{false\}>/);
    });

    it('dashboard-specific copy: "Page not found." + "moved or doesn\'t exist"', () => {
      expect(body).toMatch(/Page not found\./);
      expect(body).toMatch(/The page you were looking for has moved or doesn't exist/);
    });

    it('single CTA: Back to dashboard (primary)', () => {
      expect(body).toMatch(/<a href="\/" class="btn-primary">Back to dashboard<\/a>/);
    });
  });

  describe('admin-panel /404.astro', () => {
    const body = read(ADMIN);

    it('uses AdminLayout', () => {
      expect(body).toMatch(/import AdminLayout from '\.\.\/layouts\/AdminLayout\.astro';/);
      expect(body).toMatch(/<AdminLayout title="404">/);
    });

    it('admin-specific copy: "no page at this path" + sidebar-hint', () => {
      expect(body).toMatch(/The admin panel has no page at this path\. Check the sidebar links/);
    });

    it('single CTA: Back to overview (primary)', () => {
      expect(body).toMatch(/<a href="\/" class="btn-primary">Back to overview<\/a>/);
    });
  });

  describe('status-site /404.astro', () => {
    const body = read(STATUS);

    it('uses StatusLayout + status-specific title', () => {
      expect(body).toMatch(/import StatusLayout from '\.\.\/layouts\/StatusLayout\.astro';/);
      expect(body).toMatch(/<StatusLayout title="404 · Driftstack status" noindex>/);
    });

    it('status-site-specific copy: "only hosts a single overview page plus per-incident pages under /incident?id=<id>"', () => {
      expect(body).toMatch(
        /The status site only hosts a single overview page plus per-incident pages\s+under <code class="font-mono text-sm text-ink-secondary">\/incident\?id=&lt;id&gt;<\/code>/,
      );
    });

    it('status-site uses subtle underline link (not btn-primary) + "← Back to overview"', () => {
      expect(body).toMatch(
        /<a href="\/" class="text-sm text-ink-secondary underline hover:text-ink-primary">\s*\n?\s*← Back to overview\s*\n?\s*<\/a>/,
      );
    });

    it('status-site uses slate-500 chip (not oxblood like the others — neutral palette)', () => {
      expect(body).toMatch(
        /<p class="font-mono text-xs uppercase tracking-widest text-ink-muted">404<\/p>/,
      );
    });
  });

  it('all 4 404 pages exist', () => {
    for (const p of [MARKETING, DASHBOARD, ADMIN, STATUS]) {
      expect(existsSync(p), `404 page missing: ${p}`).toBe(true);
    }
  });
});
