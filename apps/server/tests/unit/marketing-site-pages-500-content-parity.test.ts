// W498.B — drift guard for apps/marketing-site/src/pages/500.astro.
// Customer-facing 500 error page. Drift here either drops the
// support@driftstack.dev escape-hatch (would leave customers
// stuck on a hard-error with no recovery path) or breaks the
// status.driftstack.dev pointer (would orphan customers who want
// to check whether the issue is a known outage vs. their request).
//
//   • BaseLayout import + page title + 'Something went wrong on
//     our end.' SEO description.
//   • 500 monogram + heading.
//   • 'This is on us, not you' framing.
//   • mailto:support@driftstack.dev escape-hatch.
//   • status.driftstack.dev pointer + future-status framing.
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

  it("500 monogram + 'Something went wrong on our end.' heading — pinned so the typography hierarchy + the 'on us not you' tone survive (drift to a 'try again' heading would shift blame to the customer; drift to dropping the 500 monogram would lose the at-a-glance error-code signal)", () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-oxblood-700">500<\/p>/,
    );
    expect(body).toMatch(
      /<h1 class="mt-4 text-4xl font-semibold tracking-tight text-slate-900">\s*\n?\s*Something went wrong on our end\.\s*\n?\s*<\/h1>/,
    );
  });

  it("'This is on us, not you. The error has been captured; we'll look at it. If this is blocking something time-sensitive, email support@driftstack.dev with the URL you were on.' framing pinned — pinned so the explicit blame-claim + the captured-error reassurance + the URL-required escape-hatch all survive (drift to dropping 'with the URL you were on' would force support to play 20 questions to find which page failed)", () => {
    expect(body).toMatch(
      /This is on us, not you\. The error has been captured; we'll look at\s*\n?\s*it\. If this is blocking something time-sensitive, email\s*\n?\s*<a href="mailto:support@driftstack\.dev" class="text-oxblood-700 underline">support@driftstack\.dev<\/a>\s*\n?\s*with the URL you were on\./,
    );
  });

  it("2-button CTA row: 'Back home' → '/' (primary) + 'See status' → status.driftstack.dev (secondary) — pinned so the deflection vocabulary stays 2-button (drift to dropping See status would orphan customers who want to check known-outage state before filing a support ticket)", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/status\.driftstack\.dev" class="btn-secondary">See status<\/a>/,
    );
  });

  it("Future-status framing pinned: 'Status page lives at status.driftstack.dev when it lands. Until then, check the Twitter/X account or email support.' — pinned so the not-yet-live status page is honest with customers about its readiness (drift to silently linking would let customers click through to a broken/empty page; drift to dropping the Twitter/X mention would orphan customers from the interim outage-broadcast channel)", () => {
    expect(body).toMatch(
      /Status page lives at status\.driftstack\.dev when it lands\. Until\s*\n?\s*then, check the Twitter\/X account or email support\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
