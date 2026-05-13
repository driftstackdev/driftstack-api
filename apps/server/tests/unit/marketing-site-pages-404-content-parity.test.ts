// W498.A — drift guard for apps/marketing-site/src/pages/404.astro.
// Customer-facing 404 page. Drift here either drops the 'Back home'
// button (would orphan customers who hit a stale link) or replaces
// the 'See pricing' deflection (which converts mis-routed traffic
// into pricing-page views, the lowest-funnel destination from a
// 404).
//
//   • BaseLayout import + page title 'Page not found.' description.
//   • 404 monogram + 'We couldn't find that.' heading.
//   • Body framing: 'has moved, doesn't exist, or never did.'
//   • 2-button CTA row: Back home (/) + See pricing (/pricing).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W498.A apps/marketing-site/src/pages/404.astro content parity', () => {
  const body = read(LIB);

  it("BaseLayout title='404 · Driftstack' + description='Page not found.' — pinned so the 404 page renders inside the marketing-site BaseLayout (header/footer chrome) AND the SEO description stays terse (drift to a chatty description would let search engines index 404 pages with marketing copy)", () => {
    expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
    expect(body).toMatch(/<BaseLayout title="404 · Driftstack" description="Page not found\."/);
  });

  it("404 monogram + 'We couldn't find that.' heading pinned — pinned so the typography hierarchy (small uppercase 404 monogram → large heading) survives (drift to dropping the 404 monogram would lose the at-a-glance error-code signal; drift to changing heading copy would change the tone from human to canned)", () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-oxblood-700">404<\/p>/,
    );
    expect(body).toMatch(
      /<h1 class="mt-4 text-4xl font-semibold tracking-tight text-slate-900">\s*\n?\s*We couldn't find that\.\s*\n?\s*<\/h1>/,
    );
  });

  it("Body framing: 'The page you were looking for has moved, doesn't exist, or never did.' — pinned so the 3-state framing (moved / doesn't exist / never did) survives (drift to a 1-state framing would lose the gentle 'or never did' acknowledgment that some stale links were never valid)", () => {
    expect(body).toMatch(/The page you were looking for has moved, doesn't exist, or never did\./);
  });

  it("2-button CTA row: 'Back home' → '/' (primary) + 'See pricing' → '/pricing' (secondary) — pinned so the deflection vocabulary stays 2-button (drift to a single 'Back home' would lose the pricing-page funnel pull which is the most-converting destination from a 404; drift to adding more buttons would dilute the choice)", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
    expect(body).toMatch(/<a href="\/pricing" class="btn-secondary">See pricing<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
