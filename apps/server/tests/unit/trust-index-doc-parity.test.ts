// W245.D — drift-guard for /trust (the trust-center hub). Previous
// revision asserted "customer-controlled egress" as a shipped
// pillar; per W238 + the server source (no customerEgress / proxyUrl
// / SOCKS5 / egress_config exists), it's roadmap. This guard ensures
// the hub stays consistent with /trust/security-overview's truth.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'trust', 'index.astro');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function serverSourceMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W245.D trust/index doc parity', () => {
  const doc = read();

  // V-540.E (2026-05-16): gate requires the CONCRETE wire — the
  // interface-alone scaffolding (E1) is NOT a gate trip.
  const hasEgressImpl =
    serverSourceMatches(/sessionEgressService:\s*sessionEgressService/) &&
    serverSourceMatches(/implements SessionEgressService\b/);

  it('CRITICAL the egress gate was computed and has RETIRED. This file had the correct gate but still branched on it inside the test body, so once egress shipped the arm below asserted nothing while reporting as a pass. V-540.E fixed the definition here and left the shape.', () => {
    expect(typeof hasEgressImpl, 'the gate is derived from source, not assumed').toBe('boolean');
    expect(hasEgressImpl, 'egress is wired, so the claim gate has retired').toBe(true);
  });

  it.skipIf(hasEgressImpl)('does not claim customer-controlled egress while no impl exists', () => {
    // Must not assert as a current pillar.
    expect(doc).not.toMatch(/customer-controlled egress/i);
    // And should flag it as roadmap.
    expect(doc).toMatch(/Customer-configurable\s+egress is on the roadmap/i);
  });

  it('links every trust hub destination at its canonical trailing-slash route', () => {
    for (const href of [
      '/security/',
      '/trust/security-overview/',
      '/trust/sub-processors/',
      '/trust/incidents/',
      '/legal/dpa/',
    ]) {
      expect(doc).toContain(`href="${href}"`);
    }

    const slashlessOwnedHref =
      /href="\/(?:security|trust\/(?:security-overview|sub-processors|incidents)|legal\/dpa)"/;
    expect(doc).not.toMatch(slashlessOwnedHref);
    expect(doc.replace('href="/security/"', 'href="/security"')).toMatch(slashlessOwnedHref);
  });

  it('renders the live StatusBadge component', () => {
    expect(doc).toMatch(/<StatusBadge ?\/?>/);
  });
});
