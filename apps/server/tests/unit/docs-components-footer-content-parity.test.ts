// Drift guard for apps/docs/src/components/Footer.astro. Pins the
// V-250 lighter-weight-than-marketing framing + the 4-link cross-
// nav + the year-derived copyright.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/components/Footer.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs components/Footer content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-250 doc-comment framing pinned: lighter-weight than marketing-site Footer (no full grid). Drift to growing the docs Footer to match marketing would clutter the docs-focused reference surface; drift to dropping the cross-link rationale would orphan the engineering trace', () => {
    expect(body).toMatch(
      /\/\/ V-250 — docs site footer\. Lighter-weight than marketing-site Footer/,
    );
    expect(body).toMatch(/Cross-links back to marketing for the full company navigation/);
  });

  it("Brand wordmark pinned (smaller variant): font-mono 'driftstack' + 'docs' subtitle + 24x24 mark (vs Header's 28x28). S22.1 (2026-07-06): tk-* tokens — STACK carries the AA-safe accent-text tone (marketing parity). Drift to a different brand mark would break cross-app consistency", () => {
    expect(body).toContain('DRIFT<span class="text-tk-accent-text">STACK</span>');
    expect(body).toMatch(/<span class="ml-1 text-xs text-tk-ink-3">docs<\/span>/);
    expect(body).toMatch(/width="24"/);
  });

  it('S22.1 — token chrome + meta-row theme toggle pins its truthful initial action, pressed state, and paired icons', () => {
    expect(body).toMatch(/<footer class="border-t border-tk-border bg-tk-surface">/);
    expect(body).toMatch(/data-theme-toggle/);
    expect(body).toMatch(/aria-label="Switch to light theme"/);
    expect(body).toMatch(/aria-pressed="false"/);
    expect(body).toMatch(/title="Switch to light theme"/);
    expect(body).not.toMatch(/aria-label="Toggle light and dark theme"/);
    expect(body).toMatch(/class="hidden dark:block"/);
    expect(body).toMatch(/class="block dark:hidden"/);
  });

  it('Footer tagline pinned: "Reference + guides for the Driftstack API, SDKs, and self-hosted client." Drift to dropping the SDK or self-hosted mention would narrow the docs scope description', () => {
    expect(body).toMatch(
      /Reference \+ guides for the Driftstack API, SDKs, and self-hosted client\./,
    );
  });

  it('4-link cross-nav pinned: Marketing site + Pricing + Security + mailto:support. Drift to dropping any would break a real customer-navigation path back to the marketing surface', () => {
    expect(body).toMatch(/href="https:\/\/driftstack\.dev"[\s\S]{0,200}Marketing site/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/pricing\/"[\s\S]{0,200}Pricing/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/security\/"[\s\S]{0,200}Security/);
    expect(body).not.toMatch(/href="https:\/\/driftstack\.dev\/(?:pricing|security)"/);
    expect(body).toMatch(
      /href="mailto:support@driftstack\.dev"[\s\S]{0,200}support@driftstack\.dev/,
    );
  });

  it('External links use target=_blank + rel=noopener-noreferrer pinned: drift to dropping rel on external nav-links would re-introduce tabnabbing security flag', () => {
    expect(body).toMatch(
      /href="https:\/\/driftstack\.dev"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    );
  });

  it('Year-derived copyright pinned: new Date().getUTCFullYear() — drift to a hardcoded year would create marketing-vs-reality drift every January, OR drift to a different timezone would let the copyright flip prematurely at the UTC boundary', () => {
    expect(body).toMatch(/const year = new Date\(\)\.getUTCFullYear\(\);/);
    expect(body).toMatch(/&copy; \{year\} Driftstack\./);
  });
});
