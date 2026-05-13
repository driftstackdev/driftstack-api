// W499.C — drift guard for apps/marketing-site/src/pages/about.astro.
// /about company page. Drift here either drops the WebKit C++ source
// modification framing (would let customers think Driftstack patches
// JS at runtime like every other stealth browser) or breaks the
// V-506 transparency commitments grid (would orphan customers from
// the canonical trust-promise references).
//
//   • 'A small Dutch company building one product well.' positioning.
//   • WebKit C++ source-level vs. JS runtime-patching framing.
//   • 3-card Posture: EU-resident-by-default sub-processors + no
//     behavioural data + Honest scope (no SOC 2 hype).
//   • V-506 4-card Operating commitments: security audit cadence /
//     DR rehearsed / sub-processor change-log Article 28(2) /
//     source escrow.
//   • Company facts 6-entry dl: Entity Dutch BV / HQ Netherlands /
//     Team solo founder + contractors / Funding bootstrapped no VC /
//     Sub-processors link / Contact hello@driftstack.dev.
//   • Trial-pack bottom CTA: $2.99 / 16 hours / once per account /
//     14-day window.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W499.C apps/marketing-site/src/pages/about.astro content parity', () => {
  const body = read(LIB);

  it("Hero framing: 'A small Dutch company building one product well.' + 'Driftstack ships iPhone Safari sessions on demand — same engine as the device, no patches, no detection-vendor surface area. We're solo-founded, EU-headquartered, and intentionally narrow: one product, two ladders, no land-grab.' — pinned so the solo-founded + EU-HQ + intentionally-narrow positioning all survives (drift to dropping 'no land-grab' would lose the 'we will stay focused' commitment customers evaluate when comparing against VC-backed competitors)", () => {
    expect(body).toMatch(/A small Dutch company building one product well\./);
    expect(body).toMatch(
      /Driftstack ships iPhone Safari sessions on demand — same engine\s*\n?\s*as the device, no patches, no detection-vendor surface area\./,
    );
    expect(body).toMatch(
      /We're solo-founded, EU-headquartered, and intentionally narrow:\s*\n?\s*one product, two ladders, no land-grab\./,
    );
  });

  it("WebKit C++ source modification framing pinned: 'Most stealth browsers patch JavaScript at runtime to fake an iOS fingerprint. Detection vendors built their industry on catching exactly that. Driftstack modifies WebKit's C++ source instead — there's nothing at the JavaScript layer to detect, because nothing was changed there. The fingerprint your code reads is the fingerprint a real iPhone reads.' — pinned so the source-vs-runtime distinction + the why-detection-fails framing both survive (drift to dropping would lose THE core technical differentiator)", () => {
    expect(body).toMatch(
      /Most stealth browsers patch JavaScript at runtime to fake an\s*\n?\s*iOS fingerprint\. Detection vendors built their industry on\s*\n?\s*catching exactly that\. Driftstack modifies WebKit's C\+\+ source\s*\n?\s*instead — there's nothing at the JavaScript layer to detect,\s*\n?\s*because nothing was changed there\. The fingerprint your code\s*\n?\s*reads is the fingerprint a real iPhone reads\./,
    );
  });

  it("EU-resident sub-processor 4-stack: 'Compute in Hetzner Falkenstein. Database on Neon EU. Object storage on Cloudflare R2 EU. Email through Postmark EU sending region. No silent transatlantic data flows.' — pinned so the 4-vendor sub-processor stack stays consistent with the /trust/sub-processors page (drift to dropping a vendor would create cross-page inconsistency; drift to a non-EU vendor would break the EU-resident-by-default commitment)", () => {
    expect(body).toMatch(
      /Compute in Hetzner Falkenstein\. Database on Neon EU\. Object\s*\n?\s*storage on Cloudflare R2 EU\. Email through Postmark EU\s*\n?\s*sending region\. No silent transatlantic data flows\./,
    );
  });

  it("'No behavioural data collection' posture: 'We don't log your destination URLs, response bodies, or session content. We don't train models on your traffic. We don't sell datasets. The control plane sees session metadata and license validity — that's the entire surface we touch.' — pinned so the 4-state no-collection commitment (no URL log + no body log + no training + no sale) + the 'metadata + license validity' scope all survive (drift to dropping would weaken the privacy posture marketing customers evaluate Driftstack on)", () => {
    expect(body).toMatch(
      /We don't log your destination URLs, response bodies, or\s*\n?\s*session content\. We don't train models on your traffic\. We\s*\n?\s*don't sell datasets\. The control plane sees session metadata\s*\n?\s*and license validity — that's the entire surface we touch\./,
    );
  });

  it("'Honest scope' posture: 'We say no to things we can't ship well. Behavioural simulation and recipe libraries are Phase 3 — we'll talk about them when they ship, not before. SOC 2 is a future-revenue milestone, not today's marketing line.' — pinned so the no-vaporware + no-SOC2-hype framing survive (drift to claiming SOC 2 would break the 'we don't market things we don't have' integrity; drift to teasing Phase 3 would conflict with the changelog/roadmap)", () => {
    expect(body).toMatch(
      /We say no to things we can't ship well\. Behavioural simulation\s*\n?\s*and recipe libraries are Phase 3 — we'll talk about them when\s*\n?\s*they ship, not before\. SOC 2 is a future-revenue milestone, not\s*\n?\s*today's marketing line\./,
    );
  });

  it('V-506 Operating commitments doc-comment framing pinned: \'transparency commitments. Surfaces public-facing trust signals already shipped (security audit cadence, DR runbooks, incident protocol, source-escrow for self-hosted) so the about page is not just "what we are" but "what we commit to". Visible in the About narrative because customers evaluating us read this page before /security and /trust.\' — pinned so the why-on-about-not-just-trust placement rationale survives', () => {
    expect(body).toMatch(
      /<!-- V-506 — transparency commitments\. Surfaces public-facing\s*\n?\s*trust signals already shipped \(security audit cadence, DR\s*\n?\s*runbooks, incident protocol, source-escrow for self-hosted\)/,
    );
  });

  it('V-506 4-card commitments grid: Pre-launch security audit cadence (→ /security) + DR rehearsed (→ /trust/incidents) + sub-processor change-log per Article 28(2) (→ /trust/sub-processors) + Source escrow for Enterprise + Self-hosted (→ /faq#acceptable-use) — pinned so the 4 trust signals + their canonical destination links all survive (drift to dropping any card would orphan customers from that trust commitment; drift to a different href would break the click-through)', () => {
    expect(body).toMatch(/Pre-launch security audit, on a cadence/);
    expect(body).toMatch(/Disaster recovery rehearsed pre-launch/);
    expect(body).toMatch(/Sub-processor change-log per Article 28\(2\)/);
    expect(body).toMatch(/Source escrow for Enterprise \+ Self-hosted/);
    expect(body).toMatch(/href="\/security"/);
    expect(body).toMatch(/href="\/trust\/incidents"/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
    expect(body).toMatch(/href="\/faq#acceptable-use"/);
  });

  it("11-scenario DR framing pinned: 'Eleven DR scenarios documented with concrete recovery commands — host loss, Postgres corruption, Redis loss, R2 object loss, signing-key rotation under attack, bad deploys, cert renewal failures, Cloudflare Pages regressions, multi-day Hetzner regional outage. Every scenario is rehearseable on staging before commercial activation.' — pinned so the 11-DR-scenario commitment stays explicit (drift to dropping the count would let the customer wonder how thorough the DR rehearsal is)", () => {
    expect(body).toMatch(
      /Eleven DR scenarios documented with concrete recovery\s*\n?\s*commands — host loss, Postgres corruption, Redis loss,\s*\n?\s*R2 object loss, signing-key rotation under attack,\s*\n?\s*bad deploys, cert renewal failures, Cloudflare Pages\s*\n?\s*regressions, multi-day Hetzner regional outage\./,
    );
  });

  it("Sub-processor change-log framing pinned: 'Every change to our sub-processor list (additions, removals, region migrations) is published 30 days before it takes effect at /trust/sub-processors. Customers get a right-of-objection window to terminate the affected portion of service if a new sub-processor doesn't meet their requirements.' — pinned so the 30-day-pre-notice + the right-of-objection commitment survive (drift to dropping the 30-day would lose the Article 28(2)-aligned advance notice; drift to dropping right-of-objection would weaken the data-processor contractual story)", () => {
    expect(body).toMatch(
      /Every change to our sub-processor list \(additions,\s*\n?\s*removals, region migrations\) is published 30 days\s*\n?\s*before it takes effect/,
    );
    expect(body).toMatch(
      /Customers get a right-of-objection window to\s*\n?\s*terminate the affected portion of service if a new\s*\n?\s*sub-processor doesn't meet their requirements\./,
    );
  });

  it("Source-escrow framing pinned: 'Enterprise customers and Self-hosted licensees get access to the WebKit fork + control-plane source under a written escrow agreement. If Driftstack sunsets the cloud service, escrow releases the source so customers can continue running on their own hardware indefinitely.' — pinned so the if-we-disappear customer-continuation promise survives (drift to dropping would orphan customers from the 'what if Driftstack goes away?' answer that's a deal-breaker for compliance-conscious buyers)", () => {
    expect(body).toMatch(
      /Enterprise customers and Self-hosted licensees get\s*\n?\s*access to the WebKit fork \+ control-plane source\s*\n?\s*under a written escrow agreement\./,
    );
    expect(body).toMatch(
      /If Driftstack\s*\n?\s*sunsets the cloud service, escrow releases the source\s*\n?\s*so customers can continue running on their own\s*\n?\s*hardware indefinitely\./,
    );
  });

  it("Company facts 6-entry dl: Entity Dutch BV + Headquarters Netherlands + Team Solo founder + contractors + Funding Bootstrapped — no VC + Sub-processors link + Contact hello@driftstack.dev — pinned so the canonical company facts stay consistent across the about page (drift to dropping any would create a 'what kind of company is this?' gap; drift to changing 'no VC' would change the company-vs-VC positioning)", () => {
    expect(body).toMatch(/<dd class="text-sm text-slate-900">Dutch BV<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-slate-900">Netherlands<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-slate-900">Solo founder \+ contractors<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-slate-900">Bootstrapped — no VC<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-slate-900">hello@driftstack\.dev<\/dd>/);
  });

  it("Trial-pack bottom CTA: 'Want to try it?' + '$2.99 buys 16 hours of iPhone Safari sessions to evaluate. Used once per account, 14-day window, no card-charging surprises.' + 'Get started — $2.99' button → /pricing#trial-pack — pinned so the trial-pack value-prop (16h / once-per-account / 14d) + the no-card-surprises reassurance + the CTA destination all survive (drift to dropping 'no card-charging surprises' would lose the 'this is not a subscription trap' framing)", () => {
    expect(body).toMatch(/Want to try it\?/);
    expect(body).toMatch(
      /\$2\.99 buys 16 hours of iPhone Safari sessions to evaluate\.\s*\n?\s*Used once per account, 14-day window, no card-charging surprises\./,
    );
    expect(body).toMatch(
      /<a href="\/pricing#trial-pack" class="btn-primary">Get started — \$2\.99<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
