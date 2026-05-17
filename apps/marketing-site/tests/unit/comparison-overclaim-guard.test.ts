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

  it('positions the runtime against the multi-archetype iPhone launch family (M.6 Path A: 15 Pro / 16 Pro / 17 lineup · iOS 18.7 · Safari 26.4-26.5)', () => {
    // Page must still name at least two of the launch iPhone families
    // somewhere in body copy + the iOS + Safari spans the launch
    // verdict locks (founder verdict 2026-05-17).
    expect(body).toMatch(/iPhone\s*15\s*Pro/);
    expect(body).toMatch(/16\s*Pro/);
    // iPhone 17 family is named compactly in the table cell as
    // "17 family" (the cell column header already says "device
    // target", and the cell context names the other iPhones
    // explicitly — so the compact form is unambiguous).
    expect(body).toMatch(/17\s*(?:family|lineup)/);
    expect(body).toMatch(/iOS\s*18\.7/);
    expect(body).toMatch(/Safari\s*26\.4/);
    expect(body).toMatch(/Safari\s*26\.5|26\.4-26\.5/);
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
