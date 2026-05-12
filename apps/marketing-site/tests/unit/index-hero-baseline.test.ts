// W304.B — drift guard for marketing /index hero copy. The hero
// section must lead with the WebKit-source-fork differentiator and
// cite the trial pack price + duration that match TRIAL_PACK
// constants. Catches drift where the hero is re-written away from
// the locked positioning.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_PACK } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W304.B /index hero baseline', () => {
  const body = read(PAGE);

  it('hero leads with iPhone Safari positioning', () => {
    expect(body).toMatch(/iPhone Safari/);
  });

  it('hero cites the source-level WebKit differentiator', () => {
    expect(body).toMatch(/WebKit/);
    expect(body).toMatch(/C\+\+|source-level|source code/i);
  });

  it('hero cites the canonical trial-pack price', () => {
    expect(body).toMatch(new RegExp(`\\$${TRIAL_PACK.priceUsd.toFixed(2).replace('.', '\\.')}`));
  });

  it('hero cites the canonical trial-pack hour budget', () => {
    expect(body).toMatch(new RegExp(`${TRIAL_PACK.hoursApprox}\\s+hours`));
  });
});
