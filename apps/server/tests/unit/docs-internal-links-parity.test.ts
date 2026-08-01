// W210 — drift guard: every internal `/docs/...` (and top-level
// `/api-reference`, `/changelog`, etc.) link in the marketing-site
// docs must resolve to a real Astro page.
//
// Background: api-versioning.astro linked at `/docs/sdk/installation`
// (404); docs.astro index pointed at `/docs/sdk` (404). Customers
// clicking these get a Cloudflare 404 page instead of the SDK
// reference they were looking for.
//
// The guard walks every .astro under `pages/`, collects internal
// hrefs starting with `/`, normalises them, and asserts each maps
// to a file under `pages/`. External (`https://…`),
// fragment-only (`#…`), and mailto: hrefs are skipped.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.astro') || entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// Map an href like `/docs/sdk-typescript` to the source path it'd
// resolve to: `pages/docs/sdk-typescript.astro` (or `.md`, or a
// directory index — `/foo` can resolve to `pages/foo.astro` OR
// `pages/foo/index.astro`).
function resolveHref(href: string): string | null {
  // Strip query + fragment + trailing slash.
  const clean = href.replace(/[?#].*$/, '').replace(/\/$/, '');
  const stripped = clean.startsWith('/') ? clean.slice(1) : clean;
  if (stripped === '') return null; // root href "/" — homepage; always exists.
  const candidates = [
    resolve(PAGES_DIR, `${stripped}.astro`),
    resolve(PAGES_DIR, `${stripped}.md`),
    resolve(PAGES_DIR, stripped, 'index.astro'),
    resolve(PAGES_DIR, stripped, 'index.md'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const HREF_RE = /href=["'](\/[^"']*)["']/g;

// Internal hrefs the static-site convention serves outside the Astro
// pages dir (e.g. legal pages live in their own subdir of pages/).
// These are tolerated even if `resolveHref` can't find them.
const ALLOWED_NO_FILE = new Set<string>([
  // `/` — homepage
  '/',
]);

// Path prefixes covered by other apps / static-asset rewrites. The
// docs surface freely links to these even though they don't live in
// `apps/marketing-site/src/pages`.
const ALLOWED_PREFIXES = [
  // Astro public/ assets (icons, images).
  '/images/',
  '/favicon',
  '/icons/',
  '/og/',
  // Customer-dashboard surface (different app).
  '/app',
  // Status page (different host).
  '/status',
];

describe('W210 internal-link drift guard', () => {
  // Vacuity arm. The case below reports an ABSENCE, which is vacuously true
  // over an empty scan — so a filter that stops matching (a rename, a new
  // extension, a moved root) would leave this reporting clean forever while
  // checking nothing. Measured, not hypothetical: pointing the extension
  // filter at a non-existent suffix left this file GREEN.
  it('CRITICAL the walk found real pages, so a clean result means checked rather than not looked.', () => {
    const files = walk(PAGES_DIR);
    expect(files.length, 'marketing-site pages walked').toBeGreaterThan(5);
  });

  it('every internal /href in a marketing-site doc resolves to a real page', () => {
    const violations: { file: string; href: string }[] = [];
    for (const file of walk(PAGES_DIR)) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = HREF_RE.exec(text)) !== null) {
        const href = m[1] as string;
        if (ALLOWED_NO_FILE.has(href)) continue;
        if (ALLOWED_PREFIXES.some((p) => href === p || href.startsWith(p))) continue;
        if (resolveHref(href) === null) {
          violations.push({ file: file.replace(REPO_ROOT + '/', ''), href });
        }
      }
    }
    expect(
      violations,
      `Some doc(s) link to internal hrefs that don't resolve to a real page:\n` +
        violations.map((v) => `  ${v.file} → ${v.href}`).join('\n'),
    ).toEqual([]);
  });
});
