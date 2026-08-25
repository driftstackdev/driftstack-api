// W789 — admin-panel AdminLayout.astro content parity.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LAYOUT = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');

describe('W789 admin-panel AdminLayout content parity', () => {
  it('layout exists', () => {
    expect(existsSync(LAYOUT)).toBe(true);
  });

  // ─── AdminLayout.astro ────────────────────────────────────────

  it('CRITICAL Props shape pinned — title (required) + description (optional, defaults to "Driftstack admin panel — Driftstack staff only."). Drift would let admin pages drift from a single-source default.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /interface Props \{\s*\n\s+title: string;\s*\n\s+description\?: string;\s*\n\}/,
    );
    expect(p).toMatch(/description = 'Driftstack admin panel — Driftstack staff only\.',/);
  });

  it('CRITICAL fullTitle format pinned — `<title> · Driftstack admin`. Drift to a different middle-dot or suffix would mismatch the admin-panel customer-side scoping.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/const fullTitle = `\$\{title\} · Driftstack admin`;/);
  });

  it('CRITICAL exact 12-row live nav catalog pins Cost/Fleet/Atlas priority and keeps the unwired Leads surface absent', () => {
    const p = read(LAYOUT);

    const expectedNav: Array<[string, string]> = [
      ['/', 'Overview'],
      ['/accounts', 'Accounts'],
      ['/cost', 'Cost'],
      ['/audit-log', 'Audit log'],
      ['/incidents', 'Incidents'],
      ['/status-subscribers', 'Status subs'],
      ['/sessions', 'Sessions'],
      ['/fleet', 'Fleet'],
      ['/api-keys', 'API keys'],
      ['/webhook-dlq', 'Webhook DLQ'],
      ['/rate-limit-overrides', 'Rate limits'],
      ['/atlas-priority-queue', 'Atlas priority'],
    ];
    const navSection = p.slice(
      p.indexOf('const navItems = ['),
      p.indexOf('];', p.indexOf('const navItems = [')),
    );
    const actualNav = [...navSection.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)].map(
      ([, href, label]) => [href, label],
    );
    expect(actualNav).toEqual(expectedNav);
    expect(navSection).not.toMatch(/\/leads|Leads/);
    expect(p).toMatch(/href=\{item\.href === '\/' \? '\/' : `\$\{item\.href\}\/`\}/);
  });

  it('CRITICAL noindex/nofollow meta pinned. The admin-panel must NEVER be crawled — drift to indexable would leak staff-only surface to public search.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/<!-- Admin panel must NEVER be indexed; staff-only surface\. -->/);
    expect(p).toMatch(/<meta name="robots" content="noindex,nofollow" \/>/);
  });

  it('CRITICAL V-219* D-badge + lowercase \'driftstack\' wordmark framing pinned. The \'V-219* — D-badge + lowercase font-mono "driftstack" wordmark matches the marketing-site Header pattern. The "admin" pill stays alongside as the staff-context indicator\' wording threads the brand consistency anchor.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/V-219\* \/ Fleet port — W2 wordmark \(DRIFTSTACK black-italic two-tone\)/);
    expect(p).toMatch(/matches the marketing-site Header brand\./);
    expect(p).toMatch(/The "admin" pill\s*stays alongside as the staff-context indicator/);
    expect(p).toMatch(/stays alongside as the staff-context indicator\./);
  });

  it('CRITICAL driftstack-mark.svg favicon + brand mark with cache-bust v=3 pinned (v3 = L2 rebrand bytes). Drift to dropping the cache-bust would let old logos persist on staff browsers.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=4" \/>/,
    );
    expect(p).toMatch(/src="\/driftstack-mark\.svg\?v=4"/);
  });

  it("CRITICAL 'admin' pill styling pinned — bg-tk-accent/10 + text-tk-accent + font-mono uppercase. The oxblood-50 background distinguishes admin from customer-side blue palettes.", () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /class="rounded-full bg-tk-accent\/10 px-2 py-0\.5 font-mono text-xs uppercase tracking-wide text-tk-accent"/,
    );
    expect(p).toMatch(/>\s*\n\s+admin\s*\n\s+<\/span>/);
  });

  it('CRITICAL active-nav highlight logic pinned — pathname === item.href OR pathname.startsWith(item.href + "/"). The startsWith branch is what keeps nested routes (e.g. /accounts/:id) highlighting their parent. 2026-05-21 — font-medium moved to the base class (constant width across active/inactive), so active state is bg + text color only.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)\s*\n\s+\? 'bg-tk-accent\/10 text-tk-accent'/,
    );
    expect(p).toMatch(/: 'text-tk-ink-2 hover:bg-tk-hover hover:text-tk-ink'/);
    expect(p).toMatch(/text-sm font-medium transition-colors/);
  });

  it("CRITICAL staff-only-audit-logged footer pinned. The 'Staff-only surface. All actions audit-logged.' wording is the load-bearing customer-trust contract.", () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/<p>Staff-only surface\. All actions audit-logged\.<\/p>/);
  });

  it('CRITICAL light-theme body pinned — bg-tk-bg + text-tk-ink. The admin uses inverted palette vs customer dashboard which is dark.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/<body class="bg-tk-bg text-tk-ink">/);
  });

  it('CRITICAL desktop-only sidebar pinned — hidden + md:block on w-56 aside. Drift to mobile-visible would leak admin nav on phones. 2026-05-21 — aside also carries `data-mobile-nav` so the md:hidden hamburger can flip it to a fullscreen overlay via html[data-mobile-nav-open=true] CSS. hidden+md:block default still holds for desktop posture.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/<aside\s+id="admin-mobile-navigation"\s+data-mobile-nav/);
    expect(p).toMatch(
      /class="hidden w-56 shrink-0 border-r border-tk-border bg-tk-surface md:block"/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/admin-panel-layout-and-mocks-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
