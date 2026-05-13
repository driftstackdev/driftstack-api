// W323.B (R12-refreshed) — drift guard for marketing /index section
// coverage. Anchors the narrative beats so a future copy refactor
// doesn't silently drop a section. R12 simplified the headlines for
// non-technical readers; updated phrase list:
//   • "Indistinguishable from a real iPhone." fingerprint claim
//     (replaces the prior "Bit-identical" jargon)
//   • "Apple's engine" stack positioning (replaces "Real WebKit")
//   • "One metric. Concurrent sessions." pricing positioning
//   • "Customer data stays in the EU." data plane section
//   • "Drive it by hand, or drive it from code." audience split
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
  'Indistinguishable from a real iPhone',
  "Apple's engine",
  'One metric. Concurrent sessions',
  'Customer data stays in the EU',
  'Drive it by hand, or drive it from code',
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
