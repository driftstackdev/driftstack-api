// W498.B — drift guard for apps/marketing-site/src/pages/500.astro.
// Customer-facing 500 error page. Drift here either drops the
// support@driftstack.dev escape-hatch (would leave customers
// stuck on a hard-error with no recovery path) or breaks the
// status.driftstack.io pointer (would orphan customers who want
// to check whether the issue is a known outage vs. their request).
//
//   • BaseLayout import + page title + 'Something went wrong on
//     our end.' SEO description.
//   • 500 monogram + heading.
//   • 'This is on us, not you' framing.
//   • mailto:support@driftstack.dev escape-hatch.
//   • status.driftstack.io pointer + future-status framing.
//   • 2-button CTA row: Back home + See status.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/500.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W498.B apps/marketing-site/src/pages/500.astro content parity', () => {
  const body = read(LIB);

  it("BaseLayout title='500 · Driftstack' + description='Something went wrong on our end.' — pinned so the 500 page renders inside the marketing-site BaseLayout AND the SEO description stays terse (drift to a chatty description would let search engines index 500 pages with marketing copy)", () => {
    expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
    expect(body).toMatch(
      /<BaseLayout title="500 · Driftstack" description="Something went wrong on our end\."/,
    );
  });

  it("500 monogram + 'Something broke on our side.' heading (Fleet v2 2026-07-03 — plain-words heading; the SEO description keeps the original phrasing) — pinned so the typography hierarchy + the 'on us not you' tone survive (drift to a 'try again' heading would shift blame to the customer; drift to dropping the 500 monogram would lose the at-a-glance error-code signal)", () => {
    expect(body).toMatch(/<p class="section-label">500<\/p>/);
    expect(body).toMatch(/<h1[\s\S]*?>\s*Something broke on our side\.\s*<\/h1>/);
  });

  it("'This is on us, not you. The error has been captured; we'll look at it. If this is blocking something time-sensitive, email support@driftstack.dev with the URL you were on.' framing pinned — pinned so the explicit blame-claim + the captured-error reassurance + the URL-required escape-hatch all survive (drift to dropping 'with the URL you were on' would force support to play 20 questions to find which page failed)", () => {
    expect(body).toMatch(
      /This is on us, not you\. The error has been captured and we'll look\s*into it\. If this is blocking something time-sensitive, email\s*<a href="mailto:support@driftstack\.dev" class="text-tk-accent[^"]*">support@driftstack\.dev<\/a>\s*with the URL you were on\b/,
    );
  });

  it("2-button CTA row: 'Back home' → '/' (primary) + 'See status' → status.driftstack.io (secondary) — pinned so the deflection vocabulary stays 2-button (drift to dropping See status would orphan customers who want to check known-outage state before filing a support ticket)", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/status\.driftstack\.io" class="btn-secondary">See status<\/a>/,
    );
  });

  it('R6 status-page link footer pinned (status page is now live so dropped the pre-launch fallback framing)', () => {
    expect(body).toMatch(/Live status: <a href="https:\/\/status\.driftstack\.io"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
