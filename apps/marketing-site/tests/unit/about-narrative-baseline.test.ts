// W334.B — drift guard for /about page narrative baseline. Pins
// the positioning that customers evaluating Driftstack will
// reference in pre-sales decks. Complements the existing
// company-info parity test by covering the storytelling sections:
//   • headline framing (small Dutch company, one product)
//   • EU-resident-by-default posture
//   • no-behavioural-data-collection commitment
//   • honest-scope framing (SOC 2 as future, not today's marketing)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W334.B /about narrative baseline', () => {
  const body = read(PAGE);

  it('R9 hero headline pinned: "One engine. One product. Engineered for fidelity." — capability-led framing replaces the prior solo-founder identity copy', () => {
    expect(body).toMatch(/One engine\. One product\. Engineered for fidelity\./);
  });

  it('positions WebKit source-code execution (R6 plain-English), not runtime JS patching', () => {
    expect(body).toMatch(/we run Apple's WebKit\s+source code/);
  });

  it('EU-resident posture lists Hetzner / Neon / Cloudflare R2 / Postmark', () => {
    expect(body).toMatch(/Hetzner\s+Falkenstein/);
    expect(body).toMatch(/Neon\s+EU/);
    expect(body).toMatch(/Cloudflare\s+R2\s+EU/);
    expect(body).toMatch(/Postmark\s+EU/);
  });

  it('no-behavioural-data-collection commitment', () => {
    expect(body).toMatch(/[Ww]e don't log your destination URLs/i);
    expect(body).toMatch(/We\s+don't sell datasets/);
    expect(body).toMatch(/We don't train models on your traffic/);
  });

  it("honest scope: SOC 2 framed as future-revenue milestone, not today's marketing", () => {
    expect(body).toMatch(/SOC 2 is a future-revenue milestone, not\s+today's marketing/i);
  });

  it('roadmap honesty: customer-configurable egress NOT framed as shipped', () => {
    expect(body).toMatch(/customer-configurable\s+egress[\s\S]{0,80}roadmap/i);
  });
});
