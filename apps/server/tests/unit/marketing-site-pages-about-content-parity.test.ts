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
//   • Free-tier bottom CTA: one profile / 20-minute manual sessions /
//     no card / perpetual.

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

  it("R9 hero framing (capability-led, no solo-founder identity) + 2026-05-16 honesty pass: 'One engine. One product. Engineered for fidelity.' + 'iPhone Safari sessions on demand, built on real WebKit — the same engine on every physical iPhone, with nothing patched at runtime' positioning (was 'real iPhone Safari sessions' — reframed to 'real WebKit' since we build the WebKit engine, not the literal Safari binary) + 'EU-resident infrastructure, deliberately narrow scope' framing.", () => {
    expect(body).toMatch(/One engine\. One product\. Engineered for fidelity\./);
    expect(body).toMatch(
      /Driftstack ships iPhone Safari sessions on demand, built on\s*\n?\s*real WebKit — the same engine on every physical iPhone, with\s*\n?\s*nothing patched at runtime that detection systems could spot/,
    );
    expect(body).toMatch(
      /EU-resident infrastructure, deliberately narrow scope: one\s*\n?\s*product, two ways to use it, no land-grab\./,
    );
    expect(body).not.toMatch(/Driftstack ships real iPhone Safari sessions/);
  });

  it("WebKit source-code framing pinned (R6 plain-English rewrite + 2026-05-16 unique-per-session contrast): 'we run Apple's WebKit source code, the same engine that ships on every real iPhone' kept; the contrast paragraph now names the 100% unique canvas/WebGL hashes competitors leak as the literal opposite of a real iPhone returning the same hash as millions of others", () => {
    expect(body).toMatch(
      /Most stealth browsers fake an iPhone by rewriting JavaScript\s*\n?\s*at runtime\. Detection systems are built to catch exactly that —\s*\n?\s*the canvas and WebGL hashes those tools return are 100% unique\s*\n?\s*per session, the literal opposite of a real iPhone returning\s*\n?\s*the same hash as millions of other iPhones\. Driftstack takes\s*\n?\s*a different approach: we run Apple's WebKit source code, the\s*\n?\s*same engine that ships on every real iPhone\./,
    );
  });

  it("F-5 (Issue 6) EU-resident card no longer names vendors on the about page (moved to /trust/sub-processors). The 'no silent transatlantic data flows' commitment is preserved + a link to the dedicated sub-processor page replaces the vendor enumeration.", () => {
    expect(body).toMatch(
      /Compute, database, object storage, and email all run in\s*\n?\s*the EU\. Single-region — no silent transatlantic data\s*\n?\s*flows\./,
    );
    expect(body).toMatch(
      /<a href="\/trust\/sub-processors" class="text-glow-red underline">\/trust\/sub-processors<\/a>/,
    );
    // Vendor names must not appear in the about-page splash strip
    // (still appear in security.astro and /trust/sub-processors, both
    // legitimate compliance surfaces).
    expect(body).not.toMatch(/Compute in Hetzner Falkenstein\./);
    expect(body).not.toMatch(/Database on Neon EU\./);
    expect(body).not.toMatch(/Object\s*\n?\s*storage on Cloudflare R2 EU\./);
  });

  it("'No behavioural data collection' posture: 'We don't log your destination URLs, response bodies, or session content. We don't train models on your traffic. We don't sell datasets. The control plane sees session metadata and license validity — that's the entire surface we touch.' — pinned so the 4-state no-collection commitment (no URL log + no body log + no training + no sale) + the 'metadata + license validity' scope all survive (drift to dropping would weaken the privacy posture marketing customers evaluate Driftstack on)", () => {
    expect(body).toMatch(
      /We don't log your destination URLs, response bodies, or\s*\n?\s*session content\. We don't train models on your traffic\. We\s*\n?\s*don't sell datasets\. The control plane sees session metadata\s*\n?\s*and license validity — that's the entire surface we touch\./,
    );
  });

  it("'Honest scope' posture (slice 143 update — recipe library shipped at v1.0 write-only per slice 121, so the prior 'recipe libraries are Phase 3' framing contradicted the roadmap NOW section and the docs/api/recipes.md docs page; behavioural simulation still genuinely Phase 3 so stays in the no-vaporware line. Drift to claiming SOC 2 still trips the integrity check; drift to re-Phase-3-ing recipes would reopen the marketing-vs-reality gap)", () => {
    expect(body).toMatch(
      /We say no to things we can't ship well\. Behavioural simulation\s*\n?\s*is Phase 3 — we'll talk about it when it ships, not before\. The\s*\n?\s*recipe library is live at v1\.0 in its write-only form/,
    );
    expect(body).toMatch(/read \/ list \/\s*\n?\s*execute \/ delete land at v1\.1/);
    expect(body).toMatch(
      /SOC 2 is a future-revenue\s*\n?\s*milestone, not today's marketing line\./,
    );
    // Drift sentinel — the pre-slice-143 "recipe libraries are Phase 3"
    // shape was wrong (contradicted slice 121's roadmap NOW promotion
    // + the live docs/api/recipes.md page). MUST NOT come back.
    expect(body).not.toMatch(/Behavioural simulation\s*\n?\s*and recipe libraries are Phase 3/);
  });

  it('V-506 Operating commitments doc-comment framing pinned: \'transparency commitments. Surfaces public-facing trust signals already shipped (security audit cadence, DR runbooks, incident protocol, source-escrow for self-hosted) so the about page is not just "what we are" but "what we commit to". Visible in the About narrative because customers evaluating us read this page before /security and /trust.\' — pinned so the why-on-about-not-just-trust placement rationale survives', () => {
    expect(body).toMatch(
      /<!-- V-506 — transparency commitments\. Surfaces public-facing\s*\n?\s*trust signals already shipped \(security audit cadence, DR\s*\n?\s*runbooks, incident protocol, source-escrow for self-hosted\)/,
    );
  });

  it('V-506 4-card commitments grid (F-5 — "Pre-launch" framing dropped per Issue 5; card titles now describe the ongoing cadence, not the launch-window milestone): Per-merge security audit (→ /security) + DR rehearseable on staging (→ /trust/incidents) + Sub-processor change-log per Article 28(2) (→ /trust/sub-processors) + Source escrow for Enterprise + Self-hosted (→ /faq#acceptable-use)', () => {
    expect(body).toMatch(/Per-merge security audit, on a cadence/);
    expect(body).toMatch(/Disaster recovery, rehearseable on staging/);
    expect(body).toMatch(/Sub-processor change-log per Article 28\(2\)/);
    expect(body).toMatch(/Source escrow for Enterprise \+ Self-hosted/);
    expect(body).toMatch(/href="\/security"/);
    expect(body).toMatch(/href="\/trust\/incidents"/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
    expect(body).toMatch(/href="\/faq#acceptable-use"/);
    // F-5 — "Pre-launch" prefix must not return on these card titles.
    expect(body).not.toMatch(/Pre-launch security audit, on a cadence/);
    expect(body).not.toMatch(/Disaster recovery rehearsed pre-launch/);
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

  it("R9 Company facts 6-entry dl: Entity Dutch BV (legal entity, kept) + Headquarters Netherlands + Focus 'One product, deliberately narrow' + Funding 'Independent — customer-funded' + Sub-processors link + Contact hello@driftstack.dev — replaces 'Team Solo founder + contractors' + 'Bootstrapped — no VC' which read as indie-builder framing; capability + funding-model surfaces stay legitimate", () => {
    expect(body).toMatch(/<dd class="text-sm text-ink-primary">Dutch BV<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-ink-primary">Netherlands<\/dd>/);
    expect(body).toMatch(
      /<dd class="text-sm text-ink-primary">One product, deliberately narrow<\/dd>/,
    );
    expect(body).toMatch(
      /<dd class="text-sm text-ink-primary">Independent — customer-funded<\/dd>/,
    );
    expect(body).toMatch(/<dd class="text-sm text-ink-primary">hello@driftstack\.dev<\/dd>/);
  });

  it("Free-tier bottom CTA: 'Want to try it?' + 'Start free — one profile, 20-minute manual sessions on real iPhone Safari, no card required. Perpetual, no expiry.' + 'Start free' button → /pricing#free — pinned so the free-tier value-prop (one profile / 20-minute manual / no card / perpetual) + the CTA destination all survive (drift would re-introduce the retired trial-pack framing)", () => {
    expect(body).toMatch(/Want to try it\?/);
    expect(body).toMatch(
      /Start free — one profile, 20-minute manual sessions on real\s*\n?\s*iPhone Safari, no card required\. Perpetual, no expiry\./,
    );
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary">Start free<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
