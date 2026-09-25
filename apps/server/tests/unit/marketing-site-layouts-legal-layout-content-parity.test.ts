// W523.B — drift guard for apps/marketing-site/src/layouts/LegalLayout.astro.
// Wraps legal markdown pages in BaseLayout with shared prose styling +
// "Other legal documents" navigation. Drift here either changes a legal
// document destination (would orphan that doc from compliance-review
// discovery) or breaks the prose styling parity (would create cross-
// page styling divergence on legal pages).
//
//   • frontmatter-title fallback chain: Astro.props.title ?? frontmatter.title ?? 'Legal'.
//   • frontmatter-description fallback chain: ... ?? 'Driftstack legal documents.'.
//   • 5-item canonical legalLinks: /legal/terms/ + /legal/privacy/ + /legal/dpa/ +
//     /legal/aup/ + /trust/sub-processors/.
//   • prose styling: the site's one prose recipe, `prose prose-tk`
//     (2026-09-25 — token inks, accent-text links, dark-island code
//     blocks; the recipe lives in tailwind.config.mjs), plus the layout's
//     own heading rhythm.
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

  it("LegalLayout framing pinned: 'Wraps a legal markdown page in BaseLayout with the site's one prose recipe (prose-tk …). The header surfaces version + effective-date pulled from the markdown frontmatter so customers can see at a glance which version of a document they're viewing.' — pinned so the BaseLayout-wrap + prose-styling + version/effective-date-from-frontmatter commitment survives (2026-09-25: the comment names the shared prose-tk recipe that replaced the slate palette)", () => {
    expect(body).toMatch(
      /\/\/ Wraps a legal markdown page in BaseLayout with the site's one prose\s*\/\/ recipe \(`prose-tk`, tailwind\.config\.mjs/,
    );
    expect(body).toMatch(
      /The header surfaces\s*\/\/ version \+ effective-date pulled from the markdown frontmatter so\s*\/\/ customers can see at a glance which version of a document they're\s*\/\/ viewing\./,
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
      /const description =\s*Astro\.props\.description \?\?\s*frontmatter\?\.description \?\?\s*'Driftstack legal documents\.';/,
    );
  });

  it('5-item canonical legalLinks framing keeps every legal/trust document discoverable without an edge redirect.', () => {
    expect(body).toMatch(/\{ href: '\/legal\/terms\/', label: 'Terms of Service' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/privacy\/', label: 'Privacy Policy' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/dpa\/', label: 'Data Processing Agreement' \},/);
    expect(body).toMatch(/\{ href: '\/legal\/aup\/', label: 'Acceptable Use Policy' \},/);
    expect(body).toMatch(/\{ href: '\/trust\/sub-processors\/', label: 'Sub-processors' \},/);
    expect(body).not.toMatch(
      /href: '\/(?:legal\/(?:terms|privacy|dpa|aup)|trust\/sub-processors)'/,
    );
  });

  it("BaseLayout wrap + header section framing pinned: '<BaseLayout title={title} description={description}>' + 'Legal' mono-uppercase eyebrow (S24 2026-07-06: eyebrow is TEXT → the AA-safe tk-accent-text tone; raw accent is ~3.0:1 on the dark bg) + title h1 (3xl→4xl on md) + optional description prose-paragraph — pinned so the BaseLayout-pass-through + Legal-eyebrow + responsive-h1 + conditional-description commitment survives", () => {
    expect(body).toMatch(/<BaseLayout title=\{title\} description=\{description\}>/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">Legal<\/p>/,
    );
    // 2026-05-22 — h1 keeps the same size classes; ink-primary
    // color moved onto a gradient-text span (matches the rest of
    // the marketing site visual family).
    expect(body).toMatch(/<h1[\s\S]*?\{title\}[\s\S]*?<\/h1>/);
    expect(body).toMatch(
      /\{description \? <p class="mt-4 max-w-prose text-base text-tk-ink-2">\{description\}<\/p> : null\}/,
    );
  });

  it('Prose styling pins the shared prose-tk recipe (tokenized headings, AA-safe links, accent quote rule) while the layout hero owns the page h1.', () => {
    // 2026-09-25 — the colours moved into the ONE prose recipe (`prose-tk`,
    // tailwind.config.mjs) that every long-form page shares; this layout keeps
    // its heading rhythm. The link hover no longer turns the rose accent-2
    // (3.4–3.7:1 as text): it stays accent-text with a heavier underline.
    expect(body).toMatch(/prose prose-tk max-w-none/);
    expect(body).toMatch(/prose-headings:scroll-mt-20/);
    expect(body).toMatch(/prose-h2:mt-12 prose-h2:text-2xl prose-h3:text-xl/);
    expect(body).toMatch(/prose-blockquote:not-italic/);
    expect(body).not.toMatch(/tk-accent-2/);
    const tw = read(resolve(REPO_ROOT, 'apps/marketing-site/tailwind.config.mjs'));
    expect(tw).toMatch(/'--tw-prose-headings': 'rgb\(var\(--ink-rgb\)\)'/);
    expect(tw).toMatch(/'--tw-prose-links': 'rgb\(var\(--accent-text-rgb\)\)'/);
    expect(tw).toMatch(/'--tw-prose-quote-borders': 'rgb\(var\(--accent-rgb\)\)'/);
    expect(tw).toMatch(/'--tw-prose-quotes': 'rgb\(var\(--ink-2-rgb\)\)'/);
    expect(tw).toMatch(/'h1, h2, h3, h4': \{ fontWeight: '600'/);
  });

  it("Other-legal-documents nav framing pinned: 'aria-label=\"Other legal documents\"' + 'Other legal documents' eyebrow paragraph + 'mt-3 grid gap-1 sm:grid-cols-2' ul + 'text-sm text-tk-accent-text hover:underline' link styling (S24 2026-07-06: links are TEXT → the AA-safe accent-text tone) — pinned so the cross-doc-nav + aria-label + 2-col-on-sm-and-up grid + accent-link-styling commitment survives", () => {
    expect(body).toMatch(/aria-label="Other legal documents"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">\s*Other legal documents\s*<\/p>/,
    );
    expect(body).toMatch(/<ul class="mt-3 grid gap-1 sm:grid-cols-2">/);
    expect(body).toMatch(
      /<a href=\{l\.href\} class="text-sm text-tk-accent-text hover:underline">\{l\.label\}<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
