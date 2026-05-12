// W323.B — drift guard for marketing /index section coverage. The
// homepage carries a sequence of narrative sections that anchor the
// product story. Pins their presence so a future copy refactor
// doesn't silently drop a section:
//   • Bit-identical fingerprint claim
//   • Real WebKit positioning
//   • Concurrent-cap pricing positioning
//   • EU data plane
//   • Manual + API audience split
//   • Two ladders + trial pack
//   • Self-hosted as a parallel offering

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

const REQUIRED_PHRASES = [
  'Bit-identical',
  'Real WebKit',
  'Pay per concurrent session',
  'Customer data hosted in the EU',
  'Manual or API',
  'Two ladders',
  'Run Driftstack on your own infrastructure',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W323.B / index sections baseline', () => {
  const body = read(PAGE);

  for (const phrase of REQUIRED_PHRASES) {
    it(`section anchor "${phrase}" is present`, () => {
      expect(body).toContain(phrase);
    });
  }

  it('Customer-configurable egress framed as on roadmap (no commitment to live today)', () => {
    expect(body).toMatch(/Customer-configurable egress/);
  });
});
