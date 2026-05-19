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

describe('docs components/Header content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-250 doc-comment framing pinned: mirrors marketing-site Header pattern for brand consistency. Drift would orphan the engineering anchor for the cross-app brand-consistency contract', () => {
    expect(body).toMatch(/\/\/ V-250 — docs site header\. Mirrors marketing-site Header pattern/);
    expect(body).toMatch(/for brand consistency/);
  });

  it('Brand wordmark pinned: lowercase font-mono "driftstack" + "docs" subtitle. Drift to uppercase or different brand mark would break cross-app brand consistency', () => {
    expect(body).toMatch(/<span>driftstack<\/span>/);
    expect(body).toMatch(/<span class="ml-1 text-xs text-ink-muted">docs<\/span>/);
    expect(body).toMatch(/font-mono text-base font-semibold text-ink-primary/);
  });

  it('5-item nav pinned: Overview / API / SDKs / Guides / Marketing site (external). Drift to dropping any would break the docs-site IA + the marketing-site cross-link', () => {
    expect(body).toMatch(/\{ href: '\/', label: 'Overview' \}/);
    expect(body).toMatch(/\{ href: '\/api\/', label: 'API' \}/);
    expect(body).toMatch(/\{ href: '\/sdk\/', label: 'SDKs' \}/);
    expect(body).toMatch(/\{ href: '\/guides\/', label: 'Guides' \}/);
    expect(body).toMatch(
      /\{ href: 'https:\/\/driftstack\.dev', label: 'Marketing site', external: true \}/,
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
    expect(body).toMatch(/<details class="relative">/);
    expect(body).toMatch(/aria-label="Open navigation menu"/);
  });
});
