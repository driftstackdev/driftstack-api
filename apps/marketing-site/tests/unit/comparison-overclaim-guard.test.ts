// W312.B — drift guard for /comparison page positioning. The page
// is the customer's decision aid: pick Driftstack for iPhone Safari
// fingerprints, pick a Chromium-based competitor for desktop
// Chrome workflows. The positioning must NOT claim that Driftstack
// covers Chromium / Firefox / Android too, since the runtime is
// strictly WebKit-on-macOS for v1.

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

describe('W312.B /comparison overclaim guard', () => {
  const body = read(PAGE);

  it('positions Driftstack as Apple WebKit (source-level fork)', () => {
    expect(body).toMatch(/Apple WebKit/);
    expect(body).toMatch(/source-level\s+fork/i);
  });

  it('positions the runtime as iPhone 16 Pro / iOS 18.7 / Safari 26.4', () => {
    expect(body).toMatch(/iPhone\s*16\s*Pro/);
    expect(body).toMatch(/iOS\s*18\.7/);
    expect(body).toMatch(/Safari\s*26\.4/);
  });

  it('does NOT claim Chromium support', () => {
    // Comparison page mentions Chromium repeatedly as the *competitor*
    // surface. It must never say Driftstack ships Chromium itself.
    expect(body).not.toMatch(/Driftstack\s+(?:ships|runs|uses|supports)\s+Chromium/i);
  });

  it('does NOT claim Firefox support', () => {
    expect(body).not.toMatch(/Driftstack\s+(?:ships|runs|uses|supports)\s+Firefox/i);
    expect(body).not.toMatch(/(?:Firefox\s+(?:runtime|host|supported))/i);
  });

  it('does NOT claim desktop Chrome fingerprints', () => {
    expect(body).not.toMatch(
      /Driftstack[^.]*desktop\s+Chrome\s+(?:fingerprint|fingerprints|profile)/i,
    );
  });

  it('does NOT claim Android support', () => {
    expect(body).not.toMatch(/Android\s+(?:Safari|host|runtime|supported)/i);
  });

  it('mentions trial pack price as the verification path', () => {
    expect(body).toMatch(/trial pack/i);
  });
});
