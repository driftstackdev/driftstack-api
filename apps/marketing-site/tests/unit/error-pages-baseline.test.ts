// W336.B — drift guard for /404 + /500 error pages. Both must
// render via BaseLayout, set sensible <title> + description, and
// offer customer-recoverable CTAs (home, pricing/status). The 500
// page must include the support@driftstack.dev mailto for time-
// sensitive recovery.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P404 = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/404.astro');
const P500 = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/500.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W336.B /404 + /500 error pages baseline', () => {
  const p404 = read(P404);
  const p500 = read(P500);

  it('/404 sets a useful title + description', () => {
    expect(p404).toMatch(/title="404 · Driftstack"/);
    expect(p404).toMatch(/description="Page not found\."/);
  });

  it('keeps error-only routes out of search indexes', () => {
    expect(p404).toMatch(/<BaseLayout[^>]*\bnoindex\b/);
    expect(p500).toMatch(/<BaseLayout[^>]*\bnoindex\b/);
  });

  it('/404 offers Back home + See pricing CTAs', () => {
    expect(p404).toContain('href="/"');
    expect(p404).toContain('href="/pricing/"');
  });

  it('/500 frames the error as on-us (no customer blame)', () => {
    expect(p500).toMatch(/Something went wrong on our end/i);
    expect(p500).toMatch(/This is on us, not you/);
  });

  it('/500 surfaces the support@driftstack.dev mailto for time-sensitive recovery', () => {
    expect(p500).toContain('mailto:support@driftstack.dev');
  });

  it('/500 cross-links to status.driftstack.io', () => {
    expect(p500).toContain('status.driftstack.io');
  });

  it('both pages render via BaseLayout', () => {
    expect(p404).toMatch(/<BaseLayout[\s\S]*<\/BaseLayout>/);
    expect(p500).toMatch(/<BaseLayout[\s\S]*<\/BaseLayout>/);
  });
});
