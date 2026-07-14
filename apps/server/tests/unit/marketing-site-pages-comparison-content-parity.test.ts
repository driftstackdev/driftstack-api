// W501.A — drift guard for apps/marketing-site/src/pages/comparison.astro.
// V-472 comparison page. Drift here either drops a competitor from
// the 4-vendor table (would create marketing↔customer-mental-model
// divergence for prospects coming from that vendor) or breaks the
// 'tone: differentiation, not disparagement' framing (would shift to
// adversarial marketing).
//
//   • V-472 doc-comment framing + 'no performance benchmarks' deferral.
//   • ComparisonRow interface + 12 feature-row taxonomy.
//   • 4-competitor scope: Browserless / Bright Data / ScrapingBee /
//     Browserbase.
//   • Per-competitor 'When the right answer' 4-section grid with
//     'Pricing shape' header on each.
//   • 'Last reviewed 2026-05-10' freshness stamp + mailto:support@
//     drift-correction path.
//   • When NOT Driftstack 3-card: Desktop-only / Pure HTML scraping /
//     IP-pool-as-product.
//   • Free-tier CTA: one profile / manual / perpetual.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W501.A apps/marketing-site/src/pages/comparison.astro content parity', () => {
  const body = read(LIB);

  it("V-472 framing pinned: 'comparison page. Driftstack vs Browserless / Bright Data / ScrapingBee / Browserbase. Tone: differentiation, not disparagement. Each competitor has a legitimate audience and use-case; the page names where Driftstack's posture is materially different and where it isn't a fit.' — pinned so the differentiation-not-disparagement tone + the 4-vendor scope + the 'name where Driftstack isn't a fit' commitment all survive (drift to disparagement would invite legal-shaped pushback; drift to adding more vendors would dilute the comparison)", () => {
    expect(body).toMatch(
      /\/\/ V-472 — comparison page\. Driftstack vs Browserless \/ Bright Data \/\s*\n?\s*\/\/ ScrapingBee \/ Browserbase\. Tone: differentiation, not disparagement\./,
    );
    expect(body).toMatch(
      /\/\/ Each competitor has a legitimate audience and use-case; the page\s*\n?\s*\/\/ names where Driftstack's posture is materially different and where\s*\n?\s*\/\/ it isn't a fit\./,
    );
  });

  it("'No performance benchmarks vs them — those land on the future /benchmarks subdomain (V-345) once empirical data is collected.' — pinned so the no-benchmarks-without-data commitment + the V-345 future-page reference survive (drift to claiming benchmarks would invite empirical pushback; drift to dropping V-345 reference would orphan the future-benchmarks plan)", () => {
    expect(body).toMatch(
      /\/\/ No performance benchmarks vs them — those land on the future\s*\n?\s*\/\/ \/benchmarks subdomain \(V-345\) once empirical data is collected\./,
    );
  });

  it('ComparisonRow interface 6-field shape: feature + driftstack + browserless + brightData + scrapingBee + browserbase — pinned so the comparison-row TS shape stays correct (drift to dropping a vendor field would break the table render; drift to adding a vendor would require updating the table header alongside)', () => {
    expect(body).toMatch(
      /interface ComparisonRow \{\s*\n?\s*feature: string;\s*\n?\s*driftstack: string;\s*\n?\s*browserless: string;\s*\n?\s*brightData: string;\s*\n?\s*scrapingBee: string;\s*\n?\s*browserbase: string;\s*\n?\s*\}/,
    );
  });

  it("12-row COMPARISON_ROWS feature taxonomy: Browser engine + Primary device target + Stealth approach + Fingerprint posture + Pricing model + Session metering surprises + Customer-controlled proxies + Data residency + GUI for human operators + SDK languages + Self-hosted option + Trial path — pinned so the 12-feature comparison-table surface stays consistent (drift to dropping rows would shrink the comparison surface; drift to changing order would lose the table's narrative flow)", () => {
    expect(body).toMatch(/feature: 'Browser engine',/);
    expect(body).toMatch(/feature: 'Primary device target',/);
    expect(body).toMatch(/feature: 'Stealth approach',/);
    expect(body).toMatch(/feature: 'Fingerprint posture',/);
    expect(body).toMatch(/feature: 'Pricing model',/);
    expect(body).toMatch(/feature: 'Session metering surprises',/);
    expect(body).toMatch(/feature: 'Customer-controlled proxies',/);
    expect(body).toMatch(/feature: 'Data residency',/);
    expect(body).toMatch(/feature: 'Point-and-click app for human operators',/);
    expect(body).toMatch(/feature: 'SDK languages',/);
    expect(body).toMatch(/feature: 'Self-hosted option',/);
    expect(body).toMatch(/feature: 'Trial path',/);
  });

  it("Driftstack engine row: Apple WebKit, our own build of Apple's source code (source-level fork) — S20b plain words; pinned so the canonical engine description (Apple WebKit + source-level fork) stays consistent across pages (drift would create marketing↔homepage↔about divergence)", () => {
    expect(body).toMatch(
      /driftstack: "Apple WebKit — our own build of Apple's source code \(source-level fork\)",/,
    );
  });

  it("Driftstack pricing-model row: 'Per concurrent session, hours unmetered' + Driftstack session-metering-surprises row: 'None — flat within concurrent cap' — pinned so the no-hourly-meter + no-surprise framing survives in the table (drift to adding per-call or per-hour would create cross-page divergence with the FAQ + pricing pages)", () => {
    expect(body).toMatch(/driftstack: 'Per concurrent session, hours unmetered',/);
    expect(body).toMatch(/driftstack: 'None — flat within concurrent cap',/);
  });

  it("Driftstack data-residency row: 'EU compute + database; file storage on Cloudflare R2 (EU + US replication)' (S30 2026-07-07 founder decision: soften — supersedes 'EU-only compute + storage': R2-held file objects use the default jurisdiction, so only compute + database are EU-guaranteed) + customer-controlled-proxies row: SOCKS5/OpenVPN/WireGuard per profile (shipped). 2026-05-22 — egress impl ships per planning 133 Phase 1; cell flipped from the prior 'Roadmap' framing now that the differentiator is real.", () => {
    expect(body).toMatch(
      /driftstack: 'EU compute \+ database; file storage on Cloudflare R2 \(EU \+ US replication\)',/,
    );
    // S30 negative pin — the absolutist cell must not silently return.
    expect(body).not.toMatch(/EU-only compute \+ storage/);
    // S20b 2026-07-06 plain words: same three protocols, same per-profile
    // scope, same every-traffic-type coverage.
    expect(body).toMatch(
      /driftstack: 'Bring your own: SOCKS5 proxy, OpenVPN, or WireGuard VPN — per profile, covering every traffic type \(incl\. UDP\/QUIC\/WebRTC\)',/,
    );
  });

  it("Per-competitor 4-section comparison: each h3 + 'Pricing shape' subhead. 2026-05-23 — h3 labels wrapped in gradient-text span; pin loosened to per-vendor label presence + Pricing-shape count invariant.", () => {
    expect(body).toMatch(/Driftstack vs Browserless/);
    expect(body).toMatch(/Driftstack vs Bright Data/);
    expect(body).toMatch(/Driftstack vs ScrapingBee/);
    expect(body).toMatch(/Driftstack vs Browserbase/);
    const pricingShapeMatches = body.match(/Pricing shape/g) || [];
    expect(pricingShapeMatches.length).toBeGreaterThanOrEqual(4);
  });

  it("vs Bright Data BYO-proxy framing pinned: 'Bring your own proxy network or use SOCKS5 / OpenVPN / WireGuard to whatever IP pool you've already paid for. We don't sell proxies; we don't mark up egress.' — pinned so the 'BYO egress, no markup' positioning survives (drift to dropping would weaken the cost-comparison case against Bright Data who sells proxies). Priority order SOCKS5 / OpenVPN / WireGuard matches the API server's user-facing 503 messages + the founder verdict 2026-05-16 (Phase 1 / Phase 2 / Phase 3 deferred).", () => {
    expect(body).toMatch(
      /Bring your own\s*\n?\s*proxy network or use SOCKS5 \/ OpenVPN \/ WireGuard to whatever IP\s*\n?\s*pool you've already paid for\. We don't sell proxies; we don't\s*\n?\s*mark up egress/,
    );
    // S20b 2026-07-06: the load-bearing sentence continues with a plain
    // gloss of what egress means.
    expect(body).toMatch(
      /the traffic leaving for the open internet runs\s*\n?\s*over your own exit, so it's not ours to meter\./,
    );
  });

  it("When NOT Driftstack 3-card: Desktop-only targets + Pure HTML scraping + IP-pool-as-product — pinned so the honest-anti-recommendation 3-card list survives (drift to dropping would hide the where-Driftstack-isn't-the-fit guidance the V-472 doc-comment commits to)", () => {
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">Desktop-only targets<\/h3>/);
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">Pure HTML scraping<\/h3>/);
    // S20b 2026-07-06: "IP-pool-as-product" heading reads plain.
    expect(body).toMatch(
      /<h3 class="text-lg font-medium text-tk-ink">When the proxy pool is the product<\/h3>/,
    );
  });

  it("Freshness stamp: 'Last reviewed 2026-05-10' + drift-correction mailto:support@driftstack.dev — pinned so the page-staleness signal + the customer-driven correction channel survive (drift to dropping the timestamp would let competitor rows go stale without a reviewer signal)", () => {
    expect(body).toMatch(/Last reviewed 2026-05-10\./);
    expect(body).toMatch(
      /If a competitor row drifts from current\s*\n?\s*public marketing, mail\s*\n?\s*<a href="mailto:support@driftstack\.dev"/,
    );
  });

  it("Bottom CTA: 'Free tier — one profile, manual, perpetual.' + 'Start free' → canonical /pricing/#free — pinned so the free-tier copy + conversion path stay consistent", () => {
    expect(body).toMatch(/Free tier — one profile, manual, perpetual\./);
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary">Start free<\/a>/);
    expect(body).not.toMatch(/href="\/pricing#free"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
