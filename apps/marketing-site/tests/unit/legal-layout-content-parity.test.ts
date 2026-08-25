// W381.A — drift guard for marketing-site LegalLayout.astro. This
// layout wraps every legal markdown page (terms / privacy / dpa /
// aup / refunds / sub-processors / vulnerability-disclosure). A
// drift here affects all 7 docs simultaneously, so the layout
// surface is high-leverage.
//
//   • Wraps BaseLayout (inherits canonical/OG meta).
//   • Frontmatter-or-prop title/description resolution + "Legal"
//     fallback / "Driftstack legal documents." fallback.
//   • Hero strip with mono-uppercase "Legal" chip + H1 from props.
//   • Prose styling begins at H2 because the hero owns the document's
//     single H1; links/code/pre retain the shared legal-page treatment.
//   • 5-link "Other legal documents" nav at the bottom: Terms /
//     Privacy / DPA / AUP / Sub-processors — load-bearing per-doc
//     navigation customers rely on.
//   • aria-label="Other legal documents" for the secondary nav.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/LegalLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W381.A marketing-site LegalLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('imports + wraps BaseLayout (inherits canonical/OG meta from base)', () => {
    expect(body).toMatch(/import BaseLayout from '\.\/BaseLayout\.astro';/);
    expect(body).toMatch(/<BaseLayout title=\{title\} description=\{description\}>/);
  });

  it('Props interface: title required + optional description + optional frontmatter passthrough', () => {
    expect(body).toMatch(/interface Props \{/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/frontmatter\?: \{ title\?: string; description\?: string \};/);
  });

  it('title resolution: prop → frontmatter → "Legal" fallback', () => {
    expect(body).toMatch(
      /const title = Astro\.props\.title \?\? frontmatter\?\.title \?\? 'Legal';/,
    );
  });

  it('description resolution: prop → frontmatter → "Driftstack legal documents." fallback', () => {
    expect(body).toMatch(
      /const description =\s*Astro\.props\.description \?\?\s*frontmatter\?\.description \?\?\s*'Driftstack legal documents\.';/,
    );
  });

  it('5 legalLinks entries pinned in canonical order (Terms / Privacy / DPA / AUP / Sub-processors)', () => {
    const block = body.match(/const legalLinks = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const entries = Array.from(block![1]!.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)).map(
      (m) => ({ href: m[1], label: m[2] }),
    );
    expect(entries).toEqual([
      { href: '/legal/terms/', label: 'Terms of Service' },
      { href: '/legal/privacy/', label: 'Privacy Policy' },
      { href: '/legal/dpa/', label: 'Data Processing Agreement' },
      { href: '/legal/aup/', label: 'Acceptable Use Policy' },
      { href: '/trust/sub-processors/', label: 'Sub-processors' },
    ]);
  });

  it('hero strip: mono-uppercase "Legal" chip + H1 from {title}. 2026-05-22 — H1 size/weight pinned; ink color moved onto gradient span (visual family with rest of site). S24 2026-07-06 — the eyebrow is TEXT → the AA-safe tk-accent-text tone (raw accent is ~3.0:1 on the dark bg).', () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">Legal<\/p>/,
    );
    expect(body).toMatch(/<h1 class="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">/);
    expect(body).toMatch(/\{title\}/);
  });

  it('hero is the only H1 owner; the prose does not silently hide duplicate headings', () => {
    expect(body.match(/<h1\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/prose-h1:hidden/);
  });

  it('prose link styling: tk-accent-text + hover-underline (S24 2026-07-06: link base tone is the AA-safe accent-text pair, S23 link pattern; prose-invert dropped with the light default)', () => {
    expect(body).toMatch(
      /prose-a:text-tk-accent-text prose-a:no-underline hover:prose-a:underline/,
    );
  });

  it('prose code styling: surface-inset background + mono + rounded + ink-primary text + no before/after pseudo-content', () => {
    expect(body).toMatch(
      /prose-code:rounded prose-code:bg-tk-bg prose-code:px-1\.5 prose-code:py-0\.5 prose-code:font-mono prose-code:text-sm prose-code:text-tk-ink prose-code:before:content-none prose-code:after:content-none/,
    );
  });

  it('prose pre styling: slate-900 background + slate-100 text (dark code blocks)', () => {
    expect(body).toMatch(/prose-pre:bg-slate-900 prose-pre:text-slate-100/);
  });

  it('aria-label="Other legal documents" + "Other legal documents" heading', () => {
    expect(body).toMatch(/aria-label="Other legal documents"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">\s*Other legal documents\s*<\/p>/,
    );
  });

  it('secondary nav renders 2-column grid + accent-text hover-underline links (S24: AA-safe text tone)', () => {
    expect(body).toMatch(/grid gap-1 sm:grid-cols-2/);
    expect(body).toMatch(/text-sm text-tk-accent-text hover:underline/);
    expect(body).toMatch(/legalLinks\.map\(\(l\)/);
  });

  it('renders <slot /> within prose article (markdown content insertion point)', () => {
    expect(body).toMatch(/<slot \/>/);
  });

  it('all 5 legalLinks destinations exist as files (no dangling hrefs)', () => {
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
    expect(existsSync(resolve(dir, 'legal/terms.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'legal/privacy.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'legal/dpa.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'legal/aup.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'trust/sub-processors.astro'))).toBe(true);
  });
});
