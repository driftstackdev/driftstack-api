// W299.A — drift guard for /comparison page competitor coverage.
// The page must reference each of Browserless, Bright Data,
// ScrapingBee, and Browserbase (the four canonical competitor
// positioning anchors per V-472). Catches drift where a competitor
// section is renamed or removed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W299.A /comparison page competitor coverage', () => {
  const body = read(PAGE);

  const COMPETITORS = ['Browserless', 'Bright Data', 'ScrapingBee', 'Browserbase'];
  for (const c of COMPETITORS) {
    it(`page covers ${c}`, () => {
      expect(body).toContain(c);
    });
  }

  it('comparison uses iPhone Safari positioning vs Chromium-only competitors', () => {
    expect(body).toMatch(/iPhone Safari/);
    expect(body).toMatch(/Chromium|WebKit/);
  });

  it('no fictional competitor name (Browser Cloud / SafariCloud / iPhoneify)', () => {
    expect(body).not.toMatch(/Browser ?Cloud\b/i);
    expect(body).not.toMatch(/SafariCloud/i);
    expect(body).not.toMatch(/iPhoneify/i);
  });
});
