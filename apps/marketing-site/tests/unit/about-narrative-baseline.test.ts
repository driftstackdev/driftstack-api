// W334.B — drift guard for /about page narrative baseline. Pins
// the positioning that customers evaluating Driftstack will
// reference in pre-sales decks. Complements the existing
// company-info parity test by covering the storytelling sections:
//   • R9 hero headline (capability-led: "One engine. One product. ...")
//   • EU-resident-by-default posture
//   • no-behavioural-data-collection commitment
//   • honest-scope framing without certification promises

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

  it('EU control-plane posture: compute + database are EU-resident (S30 2026-07-07 founder decision: soften — object storage dropped from the EU list since R2-held files replicate EU + US), session execution + a few processors transfer to the US under SCCs + EU-US DPF (matches the real sub-processor list); vendor names live on /trust/sub-processors, the about-page card links there instead of enumerating vendors inline', () => {
    expect(body).toMatch(/Compute and database run in the EU/);
    expect(body).not.toMatch(/Compute, database, and object storage all run in the EU/);
    expect(body).toMatch(
      /transfer to the US\s*\n?\s*under Standard Contractual Clauses \+ the EU-US Data Privacy/,
    );
    expect(body).not.toMatch(/Single-region — no silent transatlantic data/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).not.toMatch(/Hetzner\s+Falkenstein/);
    expect(body).not.toMatch(/Neon\s+EU/);
    expect(body).not.toMatch(/Cloudflare\s+R2\s+EU/);
    expect(body).not.toMatch(/Postmark\s+EU/);
  });

  it('no-behavioural-data-collection commitment', () => {
    expect(body).toMatch(/[Ww]e don't log your destination URLs/i);
    expect(body).toMatch(/We\s+don't sell datasets/);
    expect(body).toMatch(/We don't train models on your traffic/);
  });

  it('honest scope avoids certification promises', () => {
    expect(body).not.toMatch(/SOC 2|ISO 27001/i);
  });

  it('F-5 (Issue 5) customer-configurable egress framing on about page: the prior "(the last is on the roadmap; see /trust/security-overview for what\'s shipped today)" parenthetical was rewritten in scoped commit 87e37383 to "(SOCKS5 · WireGuard · OpenVPN — see /trust/security-overview for the security posture)". Aspirational "on the roadmap" language is gone from this page; the honest-disclosure surface for the egress impl state is now security.astro (gated by W499.D against actual server source).', () => {
    expect(body).toMatch(/customer-configurable\s+egress \(SOCKS5 · WireGuard · OpenVPN/);
    expect(body).not.toMatch(/customer-configurable\s+egress[\s\S]{0,80}roadmap/i);
  });
});
