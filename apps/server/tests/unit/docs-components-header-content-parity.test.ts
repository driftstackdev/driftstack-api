// Drift guard for apps/docs/src/components/Header.astro. Pins the
// V-250 marketing-mirror branding + the 5-item nav + the cross-app
// "Marketing site" external link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/components/Header.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function hasAccessibleThemeAndActiveNav(source: string): boolean {
  return (
    /class:list=\{\['nav-link font-medium', isActive\(item\.href\) && 'text-tk-accent-text'\]\}/.test(
      source,
    ) &&
    (source.match(/^\s+data-theme-toggle$/gm)?.length ?? 0) === 2 &&
    (source.match(/aria-label="Switch to light theme"/g)?.length ?? 0) === 2 &&
    (source.match(/aria-pressed="false"/g)?.length ?? 0) === 2
  );
}

describe('docs components/Header content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-250 doc-comment framing pinned: mirrors marketing-site Header pattern for brand consistency. Drift would orphan the engineering anchor for the cross-app brand-consistency contract', () => {
    expect(body).toMatch(/\/\/ V-250 — docs site header\. Mirrors marketing-site Header pattern/);
    expect(body).toMatch(/for brand consistency/);
  });

  it('Brand wordmark pinned: W2 DRIFTSTACK two-tone + "docs" subtitle, matching marketing/admin/dashboard. S22.1 (2026-07-06): tk-* tokens — STACK carries the AA-safe accent-text tone (marketing parity; was the flat text-ink-primary of the static light theme)', () => {
    expect(body).toContain('DRIFT<span class="text-tk-accent-text">STACK</span>');
    expect(body).toMatch(/<span class="ml-1 text-xs text-tk-ink-3">docs<\/span>/);
    expect(body).toMatch(/font-mono text-base font-semibold text-tk-ink/);
  });

  it('S22.1 (2026-07-06) — tk chrome + theme toggle pinned: tk-border/tk-surface header shell, active nav = tk-accent-text (AA-safe; NEVER the raw accent as text on dark), [data-theme-toggle] buttons in desktop nav + mobile cluster with mode-keyed sun/moon icons (hidden dark:block)', () => {
    expect(body).toMatch(/<header class="border-b border-tk-border bg-tk-surface">/);
    expect(hasAccessibleThemeAndActiveNav(body)).toBe(true);
    expect(body.match(/class="hidden dark:block"/g)?.length).toBe(2);
    expect(body.match(/class="block dark:hidden"/g)?.length).toBe(2);

    const unsafeActiveTone = body.replace(
      "isActive(item.href) && 'text-tk-accent-text'",
      "isActive(item.href) && 'text-tk-accent'",
    );
    const unnamedToggle = body.replace('aria-label="Switch to light theme"', '');
    expect(hasAccessibleThemeAndActiveNav(unsafeActiveTone)).toBe(false);
    expect(hasAccessibleThemeAndActiveNav(unnamedToggle)).toBe(false);
  });

  it('5-item nav pinned: Overview / API / SDKs / Guides / Marketing site (external). Drift to dropping any would break the docs-site IA + the marketing-site cross-link', () => {
    expect(body).toMatch(/\{ href: '\/', label: 'Overview' \}/);
    expect(body).toMatch(/\{ href: '\/api\/', label: 'API' \}/);
    expect(body).toMatch(/\{ href: '\/sdk\/', label: 'SDKs' \}/);
    expect(body).toMatch(/\{ href: '\/guides\/', label: 'Guides' \}/);
    expect(body).toMatch(
      /\{ href: 'https:\/\/driftstack\.io', label: 'Marketing site', external: true \}/,
    );
  });

  it('External-link target=_blank + rel=noopener-noreferrer pinned: drift to dropping rel would re-introduce the tabnabbing security flag that linters and browsers warn about', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it("isActive() prefix-match pattern pinned: pathname.startsWith(href) (NOT exact-match) — drift to exact-match would break nav highlighting on every sub-page (e.g. /api/sessions wouldn't highlight 'API' if exact-match)", () => {
    expect(body).toMatch(/function isActive\(href: string\): boolean/);
    expect(body).toMatch(/return pathname\.startsWith\(href\);/);
    expect(body).toMatch(/if \(href === '\/'\) return pathname === '\/';/);
  });

  it('Mobile-nav details/summary disclosure pattern pinned: drift to dropping the mobile nav would break navigation on small screens — visitors arriving via mobile search would have no way to navigate the docs', () => {
    expect(body).toMatch(/<details class="relative" data-mobile-nav>/);
    expect(body).toMatch(/aria-label="Open navigation menu"/);
  });

  it('S22.3 (2026-07-06) — search triggers pinned: [data-search-open] buttons in BOTH the desktop nav (input-style pill with a [data-search-kbd] ⌘K hint the BaseLayout script swaps to "Ctrl K" off-Apple) and the mobile cluster (icon-only), each aria-label="Search docs" + aria-haspopup="dialog". They open the BaseLayout Pagefind modal — drift to dropping either button would strand a form factor without search', () => {
    // Attribute lines only (the S22.3 doc comment also names the hook).
    expect(body.match(/^\s+data-search-open$/gm)?.length).toBe(2);
    expect(body.match(/aria-label="Search docs"/g)?.length).toBe(2);
    expect(body.match(/aria-haspopup="dialog"/g)?.length).toBe(2);
    expect(body).toMatch(/aria-keyshortcuts="Meta\+K Control\+K \/"/);
    expect(body).toMatch(/data-search-kbd/);
    expect(body).toMatch(/>⌘K<\/kbd/);
    // Both triggers carry the magnifier icon (11,11 r=8 lens + handle).
    expect(body.match(/<circle cx="11" cy="11" r="8"><\/circle>/g)?.length).toBe(2);
  });
});
