// W323.B (M.3-refreshed) — drift guard for marketing /index section
// coverage. Anchors the narrative beats so a future copy refactor
// doesn't silently drop a section. M.3 (Plan Item 5 + Item 8)
// dedupes "Indistinguishable" + simplifies EU compliance header:
//   • "One iPhone among millions." fingerprint claim
//     (M.3 dedupe; "Indistinguishable from a real iPhone" was the
//     prior framing — the brand-line use survives in the hero h1)
//   • "Apple's engine" stack positioning (replaces "Real WebKit")
//   • "One metric. Concurrent sessions." pricing positioning
//   • "EU-only by default." data plane section header
//     (M.3 simplify; "Customer data stays in the EU." was the prior
//     framing — replaced for inviting / scan-friendly tone)
//   • "Drive it by hand, or drive it from code." audience split
//   • Two ladders + free tier
//   • Self-hosted as a parallel offering

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

const REQUIRED_PHRASES = [
  'One iPhone among millions',
  "Apple's engine",
  'One metric. Concurrent sessions',
  'EU-only by default',
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

  it('Customer-configurable egress mentioned somewhere on homepage. 2026-05-22 — flipped from roadmap to shipped (planning 133 Phase 1); test relaxed to a presence check only (homepage now leads with the egress section directly).', () => {
    expect(body).toMatch(/SOCKS5|WireGuard|OpenVPN|egress/i);
  });
});
