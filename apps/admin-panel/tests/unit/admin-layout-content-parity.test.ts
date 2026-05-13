// W381.B — drift guard for admin-panel AdminLayout.astro. This
// layout wraps every admin page (overview / accounts / audit-log /
// incidents list+detail / leads / status-subscribers / sessions /
// api-keys / webhook-dlq / rate-limit-overrides). Drift here
// affects every admin surface simultaneously. Existing admin-
// layout-nav-baseline covers nav-href shape; this guard pins the
// load-bearing claims:
//
//   • <meta name="robots" content="noindex,nofollow"> — admin
//     panel must NEVER be indexed (load-bearing security claim).
//   • 10 navItems in canonical order (Overview / Accounts / Audit
//     log / Incidents / Status subs / Leads / Sessions / API keys
//     / Webhook DLQ / Rate limits).
//   • Active-route highlighting: pathname === href OR pathname
//     startsWith href + '/' → oxblood-50 bg + oxblood-700 text.
//   • V-219* D-badge + lowercase font-mono "driftstack" wordmark
//     + "admin" pill (staff-context indicator).
//   • "Staff-only surface. All actions audit-logged." footer claim.
//   • Page title pattern: "${title} · Driftstack admin".
//   • Description fallback: "Driftstack admin panel — Driftstack
//     staff only."
//   • Sidebar is hidden on mobile (md:block).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W381.B admin-panel AdminLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('imports base.css for tailwind/global styles', () => {
    expect(body).toMatch(/import '\.\.\/styles\/base\.css';/);
  });

  it('noindex,nofollow meta pinned (admin panel must NEVER be indexed — load-bearing security claim)', () => {
    expect(body).toMatch(/<!-- Admin panel must NEVER be indexed; staff-only surface\. -->/);
    expect(body).toMatch(/<meta name="robots" content="noindex,nofollow"/);
  });

  it('page title pattern: "${title} · Driftstack admin"', () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack admin`;/);
    expect(body).toMatch(/<title>\{fullTitle\}<\/title>/);
  });

  it('description fallback: "Driftstack admin panel — Driftstack staff only."', () => {
    expect(body).toMatch(/description = 'Driftstack admin panel — Driftstack staff only\.',/);
  });

  it('10 navItems in canonical order pinned', () => {
    const block = body.match(/const navItems = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const entries = Array.from(block![1]!.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)).map(
      (m) => ({ href: m[1], label: m[2] }),
    );
    expect(entries).toEqual([
      { href: '/', label: 'Overview' },
      { href: '/accounts', label: 'Accounts' },
      { href: '/audit-log', label: 'Audit log' },
      { href: '/incidents', label: 'Incidents' },
      { href: '/status-subscribers', label: 'Status subs' },
      { href: '/leads', label: 'Leads' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/api-keys', label: 'API keys' },
      { href: '/webhook-dlq', label: 'Webhook DLQ' },
      { href: '/rate-limit-overrides', label: 'Rate limits' },
    ]);
  });

  it('active-route highlighting: exact match OR startsWith href+"/" → oxblood-50 + oxblood-700', () => {
    expect(body).toMatch(
      /pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)\s*\n?\s*\?\s*'bg-oxblood-50 font-medium text-oxblood-700'/,
    );
  });

  it('R15 brand mark: /driftstack-mark.svg <img> (iPhone-D logo) — replaces the prior bg-oxblood-700 + text-white "D" chip placeholder with the real SVG brand asset', () => {
    expect(body).toMatch(/V-219\* — D-badge \+ lowercase font-mono "driftstack" wordmark/);
    expect(body).toMatch(
      /<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"\s*\n?\s*alt="Driftstack"/,
    );
  });

  it('"driftstack" wordmark in lowercase font-mono', () => {
    expect(body).toMatch(
      /class="flex items-center gap-2 font-mono text-base font-semibold text-slate-900"/,
    );
    expect(body).toMatch(/<span>driftstack<\/span>/);
  });

  it('"admin" staff-context pill (oxblood-50 bg + oxblood-700 text + mono uppercase)', () => {
    expect(body).toMatch(
      /<span\s*\n?\s*class="rounded-full bg-oxblood-50 px-2 py-0\.5 font-mono text-xs uppercase tracking-wide text-oxblood-700"\s*\n?\s*>\s*\n?\s*admin\s*\n?\s*<\/span>/,
    );
  });

  it('"Staff-only surface. All actions audit-logged." footer claim pinned (load-bearing)', () => {
    expect(body).toMatch(/<p>Staff-only surface\. All actions audit-logged\.<\/p>/);
  });

  it('sidebar hidden on mobile (hidden + md:block)', () => {
    expect(body).toMatch(
      /<aside class="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:block">/,
    );
  });

  it('renders <slot /> inside <main class="flex-1">', () => {
    expect(body).toMatch(/<main class="flex-1">\s*\n?\s*<slot \/>\s*\n?\s*<\/main>/);
  });

  it('html lang="en" + charset UTF-8 + viewport meta', () => {
    expect(body).toMatch(/<html lang="en">/);
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  });

  it('all 10 navItem targets exist as files (no dangling sidebar links)', () => {
    const dir = resolve(REPO_ROOT, 'apps/admin-panel/src/pages');
    expect(existsSync(resolve(dir, 'index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'accounts.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'audit-log.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'incidents/index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'status-subscribers.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'leads.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'sessions.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-keys.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'webhook-dlq.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'rate-limit-overrides.astro'))).toBe(true);
  });
});
