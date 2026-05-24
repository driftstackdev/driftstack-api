// W523.B — drift guard for apps/marketing-site/src/layouts/LegalLayout.astro.
// Wraps legal markdown pages in BaseLayout with shared prose styling +
// "Other legal documents" navigation. Drift here either changes a legal
// document destination (would orphan that doc from compliance-review
// discovery) or breaks the prose styling parity (would create cross-
// page styling divergence on legal pages).
//
//   • frontmatter-title fallback chain: Astro.props.title ?? frontmatter.title ?? 'Legal'.
//   • frontmatter-description fallback chain: ... ?? 'Driftstack legal documents.'.
//   • 5-item legalLinks: /legal/terms + /legal/privacy + /legal/dpa +
//     /legal/aup + /trust/sub-processors.
//   • prose styling: prose-h1:hidden + prose-a:text-oxblood-700 +
//     prose-blockquote:border-l-oxblood-300.
//   • aria-label="Other legal documents" navigation label.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/LegalLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W523.B apps/marketing-site/src/layouts/LegalLayout.astro content parity', () => {
  const body = read(LIB);

  it("LegalLayout framing pinned: 'Wraps a legal markdown page in BaseLayout with prose styling matching the rest of the site (oxblood links, mono code, slate palette). The header surfaces version + effective-date pulled from the markdown frontmatter so customers can see at a glance which version of a document they're viewing.' — pinned so the BaseLayout-wrap + prose-styling + version/effective-date-from-frontmatter commitment survives", () => {
    expect(body).toMatch(
      /\/\/ Wraps a legal markdown page in BaseLayout with prose styling\s*\n?\s*\/\/ matching the rest of the site \(oxblood links, mono code, slate\s*\n?\s*\/\/ palette\)\. The header surfaces version \+ effective-date pulled from\s*\n?\s*\/\/ the markdown frontmatter so customers can see at a glance which\s*\n?\s*\/\/ version of a document they're viewing\./,
    );
    expect(body).toMatch(/import BaseLayout from '\.\/BaseLayout\.astro';/);
  });

  it("3-prop interface + frontmatter-fallback framing pinned: 'title: string;' + 'description?: string;' + 'frontmatter?: { title?: string; description?: string };' + 'const title = Astro.props.title ?? frontmatter?.title ?? \"Legal\";' + 'const description = Astro.props.description ?? frontmatter?.description ?? \"Driftstack legal documents.\";' — pinned so the 3-prop interface + nullish-coalesce fallback chain (props → frontmatter → 'Legal' / 'Driftstack legal documents.') commitment survives", () => {
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/frontmatter\?: \{ title\?: string; description\?: string \};/);
    expect(body).toMatch(
      /const title = Astro\.props\.title \?\? frontmatter\?\.title \?\? 'Legal';/,
    );
    expect(body).toMatch(
      /const description =\s*\n?\s*Astro\.props\.description \?\?\s*\n?\s*frontmatter\?\.description \?\?\s*\n?\s*'Driftstack legal documents\.';/,
    );
  });

  it("5-item legalLinks framing pinned: '/legal/terms' Terms of Service + '/legal/privacy' Privacy Policy + '/legal/dpa' Data Processing Agreement + '/legal/aup' Acceptable Use Policy + '/trust/sub-processors' Sub-processors — pinned so the 5-legal-doc surface (4 legal/ + 1 trust/sub-processors) commitment survives (drift to dropping any legal page from the legalLinks nav would orphan it from cross-doc discovery)", () => {
    expect(body).toMatch(/\{ href: '\/legal\/terms', label: 'Terms of Service' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/privacy', label: 'Privacy Policy' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/dpa', label: 'Data Processing Agreement' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/aup', label: 'Acceptable Use Policy' \},/);
    expect(body).toMatch(/\{ href: '\/trust\/sub-processors', label: 'Sub-processors' \},/);
  });

  it("BaseLayout wrap + header section framing pinned: '<BaseLayout title={title} description={description}>' + 'Legal' mono-uppercase eyebrow + title h1 (3xl→4xl on md) + optional description prose-paragraph — pinned so the BaseLayout-pass-through + Legal-eyebrow + responsive-h1 + conditional-description commitment survives", () => {
    expect(body).toMatch(/<BaseLayout title=\{title\} description=\{description\}>/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-oxblood-700">Legal<\/p>/,
    );
    // 2026-05-22 — h1 keeps the same size classes; ink-primary
    // color moved onto a gradient-text span (matches the rest of
    // the marketing site visual family).
    expect(body).toMatch(/<h1[\s\S]*?\{title\}[\s\S]*?<\/h1>/);
    expect(body).toMatch(
      /\{description \? <p class="mt-4 max-w-prose text-base text-ink-secondary">\{description\}<\/p> : null\}/,
    );
  });

  it("Prose styling framing pinned (dark-theme): 'prose prose-invert max-w-none' + 'prose-h1:hidden' + 'prose-a:text-oxblood-300 prose-a:no-underline hover:prose-a:underline hover:prose-a:text-oxblood-200' + 'prose-blockquote:border-l-oxblood-300 prose-blockquote:not-italic prose-blockquote:text-ink-secondary' — 2026-05-XX prose theme switched to prose-invert with oxblood-300 anchors to match the dark surface-base/raised page background.", () => {
    expect(body).toMatch(/prose prose-invert max-w-none/);
    expect(body).toMatch(/prose-h1:hidden/);
    expect(body).toMatch(/prose-a:text-oxblood-300/);
    expect(body).toMatch(/prose-a:no-underline/);
    expect(body).toMatch(/hover:prose-a:underline/);
    expect(body).toMatch(/hover:prose-a:text-oxblood-200/);
    expect(body).toMatch(/prose-blockquote:border-l-oxblood-300/);
    expect(body).toMatch(/prose-blockquote:not-italic/);
    expect(body).toMatch(/prose-blockquote:text-ink-secondary/);
  });

  it("Other-legal-documents nav framing pinned: 'aria-label=\"Other legal documents\"' + 'Other legal documents' eyebrow paragraph + 'mt-3 grid gap-1 sm:grid-cols-2' ul + 'text-sm text-oxblood-700 hover:underline' link styling — pinned so the cross-doc-nav + aria-label + 2-col-on-sm-and-up grid + oxblood-link-styling commitment survives", () => {
    expect(body).toMatch(/aria-label="Other legal documents"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-ink-muted">\s*\n?\s*Other legal documents\s*\n?\s*<\/p>/,
    );
    expect(body).toMatch(/<ul class="mt-3 grid gap-1 sm:grid-cols-2">/);
    expect(body).toMatch(
      /<a href=\{l\.href\} class="text-sm text-oxblood-700 hover:underline">\{l\.label\}<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
