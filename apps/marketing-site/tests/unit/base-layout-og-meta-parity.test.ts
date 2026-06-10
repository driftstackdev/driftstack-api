// W282.D — drift guard for marketing-site BaseLayout. The shared
// HTML head must declare all required OG / Twitter / canonical /
// description meta tags. Catches regressions where a layout
// refactor drops one of the social-share or SEO surfaces.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BASE = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W282.D BaseLayout shared <head> integrity', () => {
  const body = read(BASE);

  it('declares meta description', () => {
    expect(body).toMatch(/<meta\s+name=["']description["']/);
  });

  it('declares OG title + description + url + type + image', () => {
    expect(body).toMatch(/property=["']og:title["']/);
    expect(body).toMatch(/property=["']og:description["']/);
    expect(body).toMatch(/property=["']og:url["']/);
    expect(body).toMatch(/property=["']og:type["']/);
    expect(body).toMatch(/property=["']og:image["']/);
  });

  it('declares Twitter card meta', () => {
    expect(body).toMatch(/name=["']twitter:card["']/);
    expect(body).toMatch(/name=["']twitter:title["']/);
    expect(body).toMatch(/name=["']twitter:description["']/);
  });

  it('W464 — emits JSON-LD structured data (Organization + WebSite + SoftwareApplication via @graph)', () => {
    expect(body).toMatch(/type=["']application\/ld\+json["']/);
    expect(body).toMatch(/set:html=\{JSON\.stringify\(structuredData\)\}/);
    expect(body).toMatch(/'@type': 'Organization'/);
    expect(body).toMatch(/'@type': 'WebSite'/);
    expect(body).toMatch(/'@type': 'SoftwareApplication'/);
    // Strictly factual — no fabricated ratings/reviews.
    expect(body).not.toMatch(/aggregateRating|"@type": ?"Review"|'@type': 'Review'/);
  });

  it('declares charset + viewport baselines', () => {
    expect(body).toMatch(/<meta\s+charset=["']UTF-8["']/i);
    expect(body).toMatch(/<meta\s+name=["']viewport["']/);
  });

  it('supports per-page noindex via a robots meta', () => {
    expect(body).toMatch(/name=["']robots["']/);
  });
});
