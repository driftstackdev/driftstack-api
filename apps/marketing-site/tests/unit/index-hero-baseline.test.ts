// W304.B — drift guard for marketing /index hero copy. The hero
// section must lead with the WebKit-source-fork differentiator and
// cite the free-tier entry framing. Catches drift where the hero is
// re-written away from the locked positioning.

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

describe('W304.B /index hero baseline', () => {
  const body = read(PAGE);

  it('hero leads with iPhone Safari positioning', () => {
    expect(body).toMatch(/iPhone Safari/);
  });

  it('hero cites the source-level WebKit differentiator', () => {
    expect(body).toMatch(/WebKit/);
    expect(body).toMatch(/C\+\+|source-level|source code/i);
  });

  it('hero leads with the free-tier entry CTA', () => {
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary">Start free<\/a>/);
  });

  it('hero subline cites the free-tier framing', () => {
    expect(body).toMatch(/One profile · 20-minute sessions · no card required\./);
  });
});
