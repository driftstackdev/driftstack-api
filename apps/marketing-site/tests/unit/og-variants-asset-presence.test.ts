// S16 — drift guard for the per-page OG social-card variants (sibling
// of W302.B, which guards the site-wide /og-default.png). Seven pages
// (plus the three use-case persona subpages, which share the use-cases
// card) pass BaseLayout an `ogImage="/og/<slug>.png"` override. Each
// referenced PNG must exist under public/ so social crawlers don't 404,
// and must be the canonical 1200x630 OpenGraph size (BaseLayout emits
// og:image:width/height 1200/630 unconditionally). The PNGs are
// generated from og-default.svg by scripts/gen-og-image.mjs (VARIANTS
// table) — re-run it after editing the base SVG or the variant copy.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');

// page (relative to src/pages) → expected variant slug. The three
// use-case persona subpages deliberately share the use-cases card.
const WIRED: Record<string, string> = {
  'pricing.astro': 'pricing',
  'comparison.astro': 'comparison',
  'security.astro': 'security',
  'faq.astro': 'faq',
  'use-cases/index.astro': 'use-cases',
  'use-cases/multi-account.astro': 'use-cases',
  'use-cases/qa-testing.astro': 'use-cases',
  'use-cases/web-scraping.astro': 'use-cases',
  'how-it-works.astro': 'how-it-works',
  'glossary.astro': 'glossary',
};

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// PNG dimensions from the IHDR chunk (fixed layout: 8-byte signature,
// 4-byte length + "IHDR", then width/height as 32-bit big-endian).
function pngSize(p: string): { width: number; height: number } {
  const buf = readFileSync(p);
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function walkAstroFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkAstroFiles(full));
    else if (entry.endsWith('.astro')) out.push(full);
  }
  return out;
}

describe('S16 per-page OG social-card variants — wiring + asset presence', () => {
  for (const [page, slug] of Object.entries(WIRED)) {
    it(`${page} passes ogImage="/og/${slug}.png" and the PNG exists at 1200x630`, () => {
      const body = read(resolve(PAGES, page));
      expect(body).toContain(`ogImage="/og/${slug}.png"`);
      const png = resolve(PUBLIC, 'og', `${slug}.png`);
      expect(existsSync(png)).toBe(true);
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    });
  }

  it('every /-rooted ogImage referenced by ANY marketing page resolves to a real file under public/ (no crawler 404s from future wirings)', () => {
    for (const file of walkAstroFiles(PAGES)) {
      for (const m of read(file).matchAll(/ogImage="(\/[^"]+)"/g)) {
        const asset = resolve(PUBLIC, m[1]!.replace(/^\//, ''));
        expect(existsSync(asset), `${file} references ${m[1]} — missing under public/`).toBe(true);
      }
    }
  });

  it('the generator VARIANTS table covers exactly the slugs the pages reference', () => {
    const gen = read(resolve(REPO_ROOT, 'scripts/gen-og-image.mjs'));
    const generated = [...gen.matchAll(/slug: '([a-z-]+)'/g)].map((m) => m[1]!).sort();
    const referenced = [...new Set(Object.values(WIRED))].sort();
    expect(generated).toEqual(referenced);
  });
});
