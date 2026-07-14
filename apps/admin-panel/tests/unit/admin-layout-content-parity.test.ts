// W381.B — drift guard for admin-panel AdminLayout.astro. This
// layout wraps every admin page (overview / accounts / audit-log /
// incidents list+detail / status-subscribers / sessions /
// api-keys / webhook-dlq / rate-limit-overrides). Drift here
// affects every admin surface simultaneously. Existing admin-
// layout-nav-baseline covers nav-href shape; this guard pins the
// load-bearing claims:
//
//   • <meta name="robots" content="noindex,nofollow"> — admin
//     panel must NEVER be indexed (load-bearing security claim).
//   • 12 live navItems in canonical order (Overview / Accounts / Cost /
//     Audit log / Incidents / Status subs / Sessions / Fleet /
//     API keys / Webhook DLQ / Rate limits / Atlas priority). Cost
//     added 2026-05-16 for V-541.B; Fleet added W629.
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

  it('consumes the cross-origin SSO hash before every slotted page script', () => {
    const preflight = body.indexOf('data-admin-sso-preflight');
    const slot = body.lastIndexOf('<slot />');
    expect(preflight).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(preflight);
    expect(body).toMatch(/location\.hash\.indexOf\('#token='\) === 0/);
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', t\)/);
    expect(body).toMatch(
      /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/,
    );
    expect(body.match(/location\.hash\.indexOf\('#token='\) === 0/g)).toHaveLength(1);
  });

  it('installs one response-body-aware deadline primitive before every slotted page script', () => {
    const helper = body.indexOf('data-admin-fetch-deadline');
    const slot = body.lastIndexOf('<slot />');
    expect(helper).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(helper);
    expect(body).toContain('window.driftstackFetchWithDeadline = function');
    expect(body).toMatch(/read\.apply\(response, arguments\)\)\.finally\(clearDeadline\)/);
    expect(body).toMatch(/if \(!response\.body\) clearDeadline\(\)/);
  });

  it('typed prompts ignore backdrop clicks so incidental taps cannot discard form state', () => {
    const promptStart = body.indexOf('window.driftstackPrompt = function');
    const promptEnd = body.indexOf('</script>', promptStart);
    const prompt = body.slice(promptStart, promptEnd);

    expect(prompt).not.toContain("overlay.addEventListener('click', onOverlay)");
    expect(prompt).not.toContain('function onOverlay');
    expect(prompt).toContain("cancel.addEventListener('click', onCancel)");
    expect(prompt).toContain("if (e.key === 'Escape') { done(null); return; }");
  });

  it('12 live navItems in canonical order; absent surfaces stay out', () => {
    const block = body.match(/const navItems = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const entries = Array.from(block![1]!.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)).map(
      (m) => ({ href: m[1], label: m[2] }),
    );
    expect(entries).toEqual([
      { href: '/', label: 'Overview' },
      { href: '/accounts', label: 'Accounts' },
      { href: '/cost', label: 'Cost' },
      { href: '/audit-log', label: 'Audit log' },
      { href: '/incidents', label: 'Incidents' },
      { href: '/status-subscribers', label: 'Status subs' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/fleet', label: 'Fleet' },
      { href: '/api-keys', label: 'API keys' },
      { href: '/webhook-dlq', label: 'Webhook DLQ' },
      { href: '/rate-limit-overrides', label: 'Rate limits' },
      { href: '/atlas-priority-queue', label: 'Atlas priority' },
    ]);
    expect(block![1]).not.toContain("href: '/leads'");
  });

  it('active-route highlighting: exact match OR startsWith href+"/" → oxblood-50 + oxblood-700. 2026-05-21 — font-medium moved from active-only to the base class (constant width prevents click-induced layout shift; same fix as DashboardLayout 50b0dd7a).', () => {
    expect(body).toMatch(
      /pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)\s*\n?\s*\?\s*'bg-tk-accent\/10 text-tk-accent'/,
    );
    expect(body).toMatch(/text-sm font-medium transition-colors/);
  });

  it('R15 brand mark: /driftstack-mark.svg <img> (iPhone-D logo) — replaces the prior bg-tk-accent + text-white "D" chip placeholder with the real SVG brand asset', () => {
    expect(body).toMatch(
      /V-219\* \/ Fleet port — W2 wordmark \(DRIFTSTACK black-italic two-tone\)/,
    );
    expect(body).toMatch(
      /<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"\s*\n?\s*alt="Driftstack"/,
    );
  });

  it('W2 wordmark (Fleet port): DRIFTSTACK black-italic two-tone; link keeps the group/hover-scale wrap.', () => {
    expect(body).toMatch(/font-mono text-base font-semibold text-tk-ink/);
    expect(body).toContain(
      '<span class="font-sans font-black italic tracking-tight">DRIFT<span class="text-tk-accent">STACK</span></span>',
    );
  });

  it('"admin" staff-context pill (oxblood-50 bg + oxblood-700 text + mono uppercase)', () => {
    expect(body).toMatch(
      /<span\s*\n?\s*class="rounded-full bg-tk-accent\/10 px-2 py-0\.5 font-mono text-xs uppercase tracking-wide text-tk-accent"\s*\n?\s*>\s*\n?\s*admin\s*\n?\s*<\/span>/,
    );
  });

  it('"Staff-only surface. All actions audit-logged." footer claim pinned (load-bearing)', () => {
    expect(body).toMatch(/<p>Staff-only surface\. All actions audit-logged\.<\/p>/);
  });

  it('sidebar hidden on mobile (hidden + md:block) — opt-in mobile overlay via data-mobile-nav', () => {
    expect(body).toMatch(/<aside\b[^>]*\bid="admin-mobile-navigation"/);
    expect(body).toMatch(/<aside\b[^>]*\bdata-mobile-nav/);
    expect(body).toMatch(
      /<aside\b[^>]*\bclass="hidden w-56 shrink-0 border-r border-tk-border bg-tk-surface md:block"/,
    );
  });

  it('renders <slot /> inside <main> with the skip-link target (id=main-content, tabindex=-1) + the opacity-0 hydrate gate (data-hydrate + inline style) so content fades in on JS reveal rather than flashing MOCK_X SSR data', () => {
    // Discrete bounded pins (no long \\s*\\n? chain — backtracking-safe).
    expect(body).toMatch(/<main\b[^>]*\bid="main-content"/);
    expect(body).toMatch(/<main\b[^>]*\btabindex="-1"/);
    expect(body).toMatch(/<main\b[^>]*\bdata-hydrate="pending"/);
    expect(body).toMatch(/style="opacity: 0; transition: opacity 0\.18s ease-out"/);
    expect(body).toMatch(/<main\b[^>]*>\s*<slot \/>\s*<\/main>/);
  });

  it('WCAG 2.4.1 skip link: a "Skip to main content" anchor targets #main-content (sr-only until focused)', () => {
    expect(body).toMatch(/href="#main-content"/);
    expect(body).toMatch(/sr-only focus:not-sr-only/);
    expect(body).toMatch(/Skip to main content/);
  });

  it('html lang="en" + charset UTF-8 + viewport meta', () => {
    expect(body).toMatch(/<html lang="en" data-mode="light" data-accent="oxblood">/);
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    expect(body).toMatch(/<meta name="theme-color" content="#f2f3f6" \/>/);
  });

  it('shared confirm + prompt modals use one cross-type lease and release it only on close', () => {
    expect(body).toMatch(/var modalOpen = false;/);
    expect(body).toMatch(/if \(modalOpen\) \{ resolve\(false\); return; \}/);
    expect(body).toMatch(/if \(modalOpen\) \{ resolve\(null\); return; \}/);
    expect(body.match(/modalOpen = true;/g)).toHaveLength(2);
    expect(body.match(/function done\(result\) \{\s*modalOpen = false;/g)).toHaveLength(2);
    expect(body).not.toMatch(/var (?:confirm|prompt)Open/);
  });

  it('all navItem targets exist as files (no dangling sidebar links)', () => {
    const dir = resolve(REPO_ROOT, 'apps/admin-panel/src/pages');
    expect(existsSync(resolve(dir, 'index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'accounts.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'audit-log.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'incidents/index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'status-subscribers.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'leads.astro'))).toBe(false);
    expect(existsSync(resolve(dir, 'sessions.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-keys.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'webhook-dlq.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'rate-limit-overrides.astro'))).toBe(true);
  });
});
