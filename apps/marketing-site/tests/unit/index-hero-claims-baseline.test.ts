// W318.B — drift guard for marketing /index hero. Pins the
// foundational positioning that the homepage promises:
//   • iPhone Safari fingerprints (the product claim)
//   • WebKit C++ source-level fork (not stealth-plugin patching)
//   • Validated against iPhone 16 Pro / iOS 18.7 / Safari 26.4
//   • Trial pack: $2.99 / 16 hours / once per account

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W318.B / hero claims baseline', () => {
  const body = read(PAGE);

  it('hero promises iPhone Safari fingerprints', () => {
    expect(body).toMatch(/iPhone Safari sessions/);
  });

  it('hero claims WebKit C\\+\\+ source-level fork (not patching)', () => {
    expect(body).toMatch(/WebKit source code/);
  });

  it('cites reference iPhone 16 Pro / iOS 18.7 / Safari 26.4', () => {
    expect(body).toMatch(/iPhone 16 Pro/);
    expect(body).toMatch(/iOS 18\.7/);
    expect(body).toMatch(/Safari 26\.4|26\.4/);
  });

  it('trial-pack hero claim: $2.99 / 16 hours / once per account', () => {
    expect(body).toMatch(/\$2\.99/);
    expect(body).toMatch(/16\s*hours/);
    expect(body).toMatch(/one trial per account/i);
  });

  it('does NOT position as a Chromium fork (overclaim guard)', () => {
    expect(body).not.toMatch(/Driftstack[^.]{0,40}Chromium\s+fork/i);
    // Allowed: "Not a Chromium fork…" (negation pointing at competitors).
  });

  it('does NOT claim Playwright / Puppeteer compatibility', () => {
    expect(body).not.toMatch(
      /Driftstack[^.]{0,40}(?:Playwright|Puppeteer)\s+(?:compat|support|integration)/i,
    );
  });
});
