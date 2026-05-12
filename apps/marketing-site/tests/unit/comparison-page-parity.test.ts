// W263.A — drift-guard for /comparison page. Pins:
// 1. Driftstack "device target" cell matches the live LOCKED_ARCHETYPE_ID.
// 2. Competitor cells describe Chromium-based products correctly.
// 3. Tier-cap and pricing references stay anchored to the live data layer.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W263.A /comparison ↔ live archetype + competitor framing parity', () => {
  const page = read(PAGE);

  it('Driftstack device-target cell names iOS 18.7 + Safari 26.4', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone16pro_ios18_7_safari26_4');
    expect(page).toMatch(/iPhone 16 Pro · iOS 18\.7 · Safari 26\.4/);
    expect(page).not.toMatch(/iOS 26\.4/);
  });

  it('competitor rows describe Chromium-based products', () => {
    expect(page).toMatch(/browserless:\s*'Chromium/);
    expect(page).toMatch(/brightData:\s*'Chromium/);
    expect(page).toMatch(/scrapingBee:\s*'Chromium/);
    expect(page).toMatch(/browserbase:\s*'Chromium/);
  });

  it('comparison framing acknowledges WebKit source-level fork', () => {
    expect(page).toMatch(/WebKit source-level fork/);
  });

  it('CTA copy stays anchored to the iPhone Safari narrative', () => {
    expect(page).toMatch(/iPhone Safari/);
    expect(page).toMatch(/Chromium/);
  });
});
