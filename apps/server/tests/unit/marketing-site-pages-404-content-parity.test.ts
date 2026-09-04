// W498.A — drift guard for apps/marketing-site/src/pages/404.astro.
// Customer-facing 404 page. Drift here either drops the 'Back home'
// button (would orphan customers who hit a stale link) or drops one
// of the deflection links (pricing converts mis-routed traffic into
// pricing-page views; docs + status catch the developer / is-it-down
// arrivals). Fleet v2 2026-07-03: heading is the on-brand 'This page
// drifted off.'; CTA row widened to the useful-links set.
//
//   • BaseLayout import + page title 'Page not found.' description.
//   • 404 monogram + 'This page drifted off.' heading.
//   • Body framing: 'has moved, doesn't exist, or never did.'
//   • Useful-links row: Back home (/) + See pricing (/pricing/) +
//     Read the docs (/docs/) + System status (status.driftstack.io).

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

  it("404 monogram + 'This page drifted off.' heading pinned — pinned so the typography hierarchy (small uppercase 404 monogram → large heading) survives (drift to dropping the 404 monogram would lose the at-a-glance error-code signal; drift to changing heading copy would change the tone from on-brand-human to canned)", () => {
    expect(body).toMatch(/<p class="section-label">404<\/p>/);
    expect(body).toMatch(/This page drifted off\./);
  });

  it("Body framing: 'The page you were looking for has moved, doesn't exist, or never did.' — pinned so the 3-state framing (moved / doesn't exist / never did) survives (drift to a 1-state framing would lose the gentle 'or never did' acknowledgment that some stale links were never valid)", () => {
    expect(body).toMatch(/The page you were looking for has moved, doesn't exist, or never did\./);
  });

  it("useful-links row: 'Back home' → '/' (primary) + canonical 'See pricing' → '/pricing/' + 'Read the docs' → '/docs/' + 'System status' → status.driftstack.io (secondary, rel=noopener) — pinned so every deflection path survives without an avoidable redirect", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
    expect(body).toMatch(/<a href="\/pricing\/" class="btn-secondary">See pricing<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/" class="btn-secondary">Read the docs<\/a>/);
    expect(body).not.toMatch(/href="\/(?:pricing|docs)"/);
    expect(body).toMatch(
      /<a href="https:\/\/status\.driftstack\.io" class="btn-secondary" rel="noopener noreferrer"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
