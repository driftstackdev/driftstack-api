// W367.A — drift guard for marketing-site /about page content.
// V-506 + V-503 cross-links. Existing tests cover narrative
// baseline + company-info + page parity; this guard pins the
// load-bearing trust claims a prospect reads before signing:
//
//   • Posture 3-card section: EU-resident / no-behavioural-data
//     / honest-scope. These are the headline trust commitments;
//     a future copy softening that drops one would weaken the
//     pre-purchase trust narrative.
//   • V-506 operating-commitments 4-card section: pre-launch
//     security audit + DR rehearsal + sub-processor Article 28(2)
//     change-log + source-escrow. Each has a verifiable public
//     URL (/security, /trust/incidents, /trust/sub-processors,
//     /faq#acceptable-use).
//   • Company facts: Dutch BV + Netherlands HQ + Solo founder
//     + Bootstrapped no-VC + sub-processors cross-link + hello@.
//   • Trial-pack CTA cross-link points at /pricing#trial-pack
//     with $2.99 / 16h / 14-day-window figures pinned.
//   • Source-modified WebKit framing (not JS-runtime-patches)
//     pinned — load-bearing engineering differentiator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W367.A marketing-site /about page content parity', () => {
  const body = read(PAGE);

  it('posture 3-card section pinned: EU-resident / no-behavioural-data / honest-scope', () => {
    expect(body).toMatch(
      /<h3 class="font-semibold text-ink-primary">EU-resident, by default<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-semibold text-ink-primary">No behavioural data collection<\/h3>/,
    );
    expect(body).toMatch(/<h3 class="font-semibold text-ink-primary">Honest scope<\/h3>/);
  });

  it('EU stack pinned: Hetzner FSN / Neon EU / Cloudflare R2 EU / Postmark EU', () => {
    // Load-bearing residency claim. A future migration off any
    // of these must update this page first.
    expect(body).toMatch(/Compute in Hetzner Falkenstein/);
    expect(body).toMatch(/Database on Neon EU/);
    expect(body).toMatch(/Object\s+storage on Cloudflare R2 EU/);
    expect(body).toMatch(/Email through Postmark EU\s+sending region/);
  });

  it('no-behavioural-data 4 specifics pinned (URLs / bodies / training / sale)', () => {
    expect(body).toMatch(
      /We don't log your destination URLs, response bodies, or\s+session content/,
    );
    expect(body).toMatch(/We don't train models on your traffic/);
    expect(body).toMatch(/We\s+don't sell datasets/);
  });

  it("honest-scope: SOC 2 is future-revenue, not today's marketing line", () => {
    // Matches the /security "What we don't claim" honesty block.
    expect(body).toMatch(/SOC 2 is a future-revenue milestone, not\s+today's marketing line/);
  });

  it('V-506 operating-commitments 4 cards pinned + each has a verifiable public URL', () => {
    expect(body).toContain('Operating commitments');
    expect(body).toMatch(/Pre-launch security audit, on a cadence/);
    expect(body).toMatch(/Disaster recovery rehearsed pre-launch/);
    expect(body).toMatch(/Sub-processor change-log per Article 28\(2\)/);
    expect(body).toMatch(/Source escrow for Enterprise \+ Self-hosted/);
    // Each card cross-links to a verifiable public page.
    expect(body).toMatch(/href="\/security"/);
    expect(body).toMatch(/href="\/trust\/incidents"/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
    expect(body).toMatch(/href="\/faq#acceptable-use"/);
  });

  it('DR runbook scope pinned: 11 rehearsable scenarios (host loss / Postgres / R2 / cert / multi-day Hetzner)', () => {
    expect(body).toMatch(/Eleven DR scenarios documented/);
    // Specific scenario callouts — a future copy edit that drops
    // any of these forces a discussion about coverage.
    for (const scenario of [
      'host loss',
      'Postgres corruption',
      'Redis loss',
      'R2 object loss',
      'signing-key rotation under attack',
      'multi-day Hetzner regional outage',
    ]) {
      expect(body, `DR scenario missing: ${scenario}`).toContain(scenario);
    }
  });

  it('Article 28(2) sub-processor 30-day notice + right-of-objection window pinned', () => {
    expect(body).toMatch(/published 30 days\s+before it takes effect/);
    expect(body).toMatch(/right-of-objection window/);
  });

  it('source-escrow framing: "Driftstack sunsets the cloud service" insurance commitment', () => {
    expect(body).toMatch(
      /If Driftstack\s+sunsets the cloud service, escrow releases the source\s+so customers can continue running on their own\s+hardware indefinitely/,
    );
  });

  it('R9 company facts: Dutch BV (legal entity, kept for legitimate transparency) / Netherlands HQ / "One product, deliberately narrow" focus / "Independent — customer-funded" — replaces the prior solo-founder/no-VC framing which read as indie-builder rather than enterprise-grade', () => {
    expect(body).toMatch(/<dd class="text-sm text-ink-primary">Dutch BV<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-ink-primary">Netherlands<\/dd>/);
    expect(body).toMatch(
      /<dd class="text-sm text-ink-primary">One product, deliberately narrow<\/dd>/,
    );
    expect(body).toMatch(
      /<dd class="text-sm text-ink-primary">Independent — customer-funded<\/dd>/,
    );
    expect(body).toContain('hello@driftstack.dev');
  });

  it('trial-pack CTA cross-link points at /pricing#trial-pack + figures pinned ($2.99 / 16h / 14-day)', () => {
    expect(body).toMatch(/href="\/pricing#trial-pack"/);
    expect(body).toMatch(/\$2\.99 buys 16 hours of iPhone Safari sessions/);
    expect(body).toMatch(/Used once per account, 14-day window/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('source-modified-WebKit-not-JS-patches engineering claim pinned', () => {
    // Load-bearing differentiator vs every Chromium-stealth-
    // plugin competitor. A future copy softening to "stealth
    // bundles" would break the entire positioning.
    expect(body).toMatch(/we run Apple's WebKit\s+source code/);
    expect(body).toMatch(/there's nothing for\s+detection to find/);
  });

  it('R9 hero claim pinned: "One engine. One product. Engineered for fidelity." + capability-led "EU-resident infrastructure, deliberately narrow scope" — replaces the prior solo-Dutch-founder identity framing', () => {
    expect(body).toMatch(/One engine\. One product\. Engineered for fidelity\./);
    expect(body).toMatch(/EU-resident infrastructure,\s*\n?\s*deliberately narrow scope/);
  });
});
