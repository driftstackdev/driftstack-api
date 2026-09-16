// W323.B (M.3-refreshed) — drift guard for marketing /index section
// coverage. Anchors the narrative beats so a future copy refactor
// doesn't silently drop a section. M.3 (Plan Item 5 + Item 8)
// dedupes "Indistinguishable" + simplifies EU compliance header:
//   • "One iPhone among millions." fingerprint claim
//     (M.3 dedupe; "Indistinguishable from a real iPhone" was the
//     prior framing. The brand-line use survived in the hero h1 and
//     then the developer-band title until 2026-09-16, when it was
//     retired too — a blanket identity claim; evidence is per
//     surface. The word now appears ZERO times on the page; the two
//     content-parity tests pin that, this file only anchors sections)
//   • "Apple's engine" stack positioning (replaces "Real WebKit")
//   • "One metric. Concurrent sessions." pricing positioning
//   • "EU-hosted by default." data plane section header
//     (M.3 simplify; "Customer data stays in the EU." was the prior
//     framing — replaced for inviting / scan-friendly tone.
//     S30 2026-07-07 founder decision: soften — "EU-only" dropped
//     because R2-held file objects replicate EU + US)
//   • "Drive it by hand, or drive it from code." audience split
//   • Two plan families + free tier
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
  'EU-hosted by default',
  'Drive it by hand, or drive it from code',
  'Two plan families',
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
