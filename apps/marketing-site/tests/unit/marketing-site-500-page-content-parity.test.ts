// W379.C — drift guard for marketing-site /500.astro content. This
// is the customer-facing internal-server-error fallback page. Pins
// the load-bearing customer-trust claims:
//
//   • BaseLayout + 500 title chip.
//   • "This is on us, not you." apology framing (load-bearing
//     trust posture — must not drift to blaming customer).
//   • "The error has been captured; we'll look at it" implicit
//     Sentry-capture claim.
//   • support@driftstack.dev escape-hatch CTA inline.
//   • status.driftstack.dev cross-link (status-page CTA).
//   • Twitter/X fallback framing ("Status page lives at
//     status.driftstack.dev when it lands. Until then, check the
//     Twitter/X account or email support").

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/500.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W379.C marketing-site /500.astro content parity', () => {
  const body = read(PAGE);

  it('uses BaseLayout + 500 title + description', () => {
    expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
    expect(body).toMatch(
      /<BaseLayout title="500 · Driftstack" description="Something went wrong on our end\."/,
    );
  });

  it('500 chip + H1 "Something went wrong on our end." pinned', () => {
    expect(body).toMatch(/<p class="section-label">500<\/p>/);
    expect(body).toMatch(/<h1[^>]*>\s*Something went wrong on our end\.\s*<\/h1>/);
  });

  it('"This is on us, not you." apology-framing pinned (load-bearing customer-trust posture)', () => {
    expect(body).toMatch(/This is on us, not you\./);
  });

  it('"The error has been captured; we\'ll look at it" implicit Sentry-capture claim pinned', () => {
    expect(body).toMatch(/The error has been captured and we'll look\s+into it/);
  });

  it('support@driftstack.dev escape-hatch CTA inline + "URL you were on" framing', () => {
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="text-glow-red[^"]*">support@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(/with the URL you were on/);
    expect(body).toMatch(/If this is blocking something time-sensitive, email/);
  });

  it('2 CTAs: Back home (primary) + See status (secondary linking to status.driftstack.dev)', () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back home<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/status\.driftstack\.dev" class="btn-secondary">See status<\/a>/,
    );
  });

  it('R6 status-page link footer pinned', () => {
    expect(body).toMatch(/Live status: <a href="https:\/\/status\.driftstack\.dev"/);
  });
});
