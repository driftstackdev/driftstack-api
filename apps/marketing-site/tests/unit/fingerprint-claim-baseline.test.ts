// W303.A — drift guard for marketing fingerprint-fidelity copy.
// The platform's core differentiator is the WebKit source-level
// fork running on iPhone Safari archetype hardware. The marketing
// homepage + comparison page must keep that positioning intact;
// no overclaim that we run "every browser" or "Chromium too".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');
const COMPARISON = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W303.A fingerprint-claim baseline', () => {
  it('homepage names WebKit + iPhone Safari as the differentiator', () => {
    const body = read(INDEX);
    expect(body).toMatch(/WebKit|iPhone Safari/);
  });

  it('homepage does not promise Chromium / Firefox / desktop support', () => {
    const body = read(INDEX);
    // We don't ship Chromium or Firefox archetypes. Playwright with
    // those engines is dev-only. Marketing copy should not claim them.
    expect(body).not.toMatch(/we (?:also )?support (?:Chromium|Firefox|Chrome)\b/i);
    expect(body).not.toMatch(/(?:Chromium|Firefox) fingerprint(?:s)? supported/i);
  });

  it('comparison page positions Driftstack against Chromium-based competitors', () => {
    const body = read(COMPARISON);
    expect(body).toMatch(/Chromium/);
    expect(body).toMatch(/WebKit|iPhone Safari/);
  });

  it('comparison cites the canonical locked archetype label', () => {
    const body = read(COMPARISON);
    expect(body).toMatch(/iPhone 16 Pro|iOS 18\.7|Safari 26\.4/);
  });
});
