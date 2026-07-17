// W366.A — drift guard for marketing-site /comparison page
// content. V-472. The page positions Driftstack against
// Browserless / Bright Data / ScrapingBee / Browserbase. Existing
// tests cover positioning + overclaim + structural baseline; this
// guard pins the load-bearing claims a prospect compares before
// purchase:
//
//   • Exactly 4 competitors compared, no more no less (a future
//     "add a 5th competitor" needs an explicit decision, not a
//     drive-by).
//   • Each of the 12 COMPARISON_ROWS feature labels pinned —
//     this is the canonical category list a customer scans.
//   • Each competitor has a dedicated "Driftstack vs <name>"
//     card with both engine-fit + pricing-shape framing.
//   • "Where Driftstack isn't the fit" honesty section pinned
//     with 3 explicit non-fit categories (desktop-only,
//     pure-HTML-scraping, IP-pool-as-product).
//   • Free-tier CTA cross-link to /pricing#free.
//   • Free-tier framing (one profile / manual / perpetual) pinned.
//   • "Last reviewed YYYY-MM-DD" review date pinned (stops
//     freshness drifting silently).
//   • No performance-benchmark claims today — V-345 routes
//     those to /benchmarks once empirical data exists.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W366.A marketing-site /comparison page content parity', () => {
  const body = read(PAGE);

  it('exactly 4 competitors compared (Browserless / Bright Data / ScrapingBee / Browserbase)', () => {
    for (const c of ['Browserless', 'Bright Data', 'ScrapingBee', 'Browserbase']) {
      expect(body).toContain(c);
    }
    // The ComparisonRow interface has exactly 4 competitor keys
    // beyond `driftstack` and `feature` — pin the interface shape.
    expect(body).toMatch(
      /interface ComparisonRow \{\s*feature: string;\s*driftstack: string;\s*browserless: string;\s*brightData: string;\s*scrapingBee: string;\s*browserbase: string;\s*\}/,
    );
  });

  it('12 canonical feature rows pinned (no silent row drop or rename)', () => {
    for (const feature of [
      "'Browser engine'",
      "'Primary device target'",
      "'Stealth approach'",
      "'Fingerprint posture'",
      "'Pricing model'",
      "'Session metering surprises'",
      "'Customer-controlled proxies'",
      "'Data residency'",
      "'Point-and-click app for human operators'",
      "'SDK languages'",
      "'Self-hosted option'",
      "'Trial path'",
    ]) {
      expect(body, `feature row missing: ${feature}`).toContain(feature);
    }
  });

  it('each competitor has a "Driftstack vs <name>" card with engine + pricing-shape framing', () => {
    for (const vs of [
      'Driftstack vs Browserless',
      'Driftstack vs Bright Data',
      'Driftstack vs ScrapingBee',
      'Driftstack vs Browserbase',
    ]) {
      expect(body, `competitor card missing: ${vs}`).toContain(vs);
    }
    // Pricing-shape label appears once per card (4 occurrences).
    const pricingShape = body.match(/Pricing shape/g);
    expect(pricingShape).not.toBeNull();
    expect(pricingShape!.length).toBe(4);
  });

  it('honesty section "Where Driftstack isn\'t the fit" with 3 non-fit categories pinned (S20b: "IP-pool-as-product" heading reads plain)', () => {
    expect(body).toContain("Where Driftstack isn't the fit");
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">Desktop-only targets<\/h3>/);
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">Pure HTML scraping<\/h3>/);
    expect(body).toMatch(
      /<h3 class="text-lg font-medium text-tk-ink">When the proxy pool is the product<\/h3>/,
    );
  });

  it('free-tier CTA cross-link points at /pricing#free + framing pinned (one profile / manual / perpetual)', () => {
    expect(body).toMatch(/href="\/pricing\/#free"/);
    expect(body).toMatch(/Free tier — one profile, manual, perpetual\./);
    // The cross-linked anchor must exist on /pricing.
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('"Last reviewed YYYY-MM-DD" freshness stamp pinned', () => {
    expect(body).toMatch(/Last reviewed 20\d{2}-\d{2}-\d{2}\./);
  });

  it('V-345 no-performance-benchmark posture pinned (benchmarks future, not today)', () => {
    // The page comment commits to category-level facts, not
    // benchmarks — a future "we benchmarked X% faster" copy add
    // must update this comment first.
    expect(body).toMatch(
      /No performance benchmarks vs them — those land on the future\s*\n?\s*\/\/\s*\/benchmarks subdomain \(V-345\)/,
    );
  });

  it("per-row engine claim pinned: Driftstack = Apple WebKit, our own build of Apple's source code (source-level fork) — S20b plain words, same engine promise", () => {
    // Load-bearing differentiator — the page promises WebKit, not
    // Chromium-with-iOS-skin. A future copy softening to "iOS-
    // optimized Chromium" would break the entire positioning.
    expect(body).toMatch(
      /driftstack: "Apple WebKit — our own build of Apple's source code \(source-level fork\)"/,
    );
    // M.6 Path A: multi-archetype + Safari 26.5 launch scope per founder
    // verdict 2026-05-17. Single-archetype framing must NOT return.
    expect(body).toMatch(
      /driftstack: 'iPhone 15 Pro \/ 16 Pro \/ 17 family · iOS 18\.7 · Safari 26\.4-26\.5'/,
    );
    expect(body).not.toMatch(/driftstack: 'iPhone 16 Pro · iOS 18\.7 · Safari 26\.4'/);
  });

  it('"don\'t sell proxies; we don\'t mark up egress" anti-Bright Data positioning pinned', () => {
    // Load-bearing commercial claim — Driftstack does not bill GB
    // egress. Pin so a future revenue add can't quietly soften it.
    expect(body).toMatch(/We don't sell proxies; we don't\s+mark up egress/);
  });

  it('BYOK remains no-markup while provided model access is an included-service budget, not a Stripe line item', () => {
    expect(body).toMatch(
      /Bring-your-own\s+Anthropic key is supported with no Driftstack markup\. Optional\s+Driftstack-provided model access draws against an enforced\s+included-service budget and is not a separate Stripe line item today/,
    );
    expect(body).not.toMatch(/opt into bundled billing/);
  });

  it('support@driftstack.dev correction-mail link pinned (vendor-marketing-drift escape hatch)', () => {
    // The page commits to category-level facts pulled from each
    // vendor's own marketing. If a competitor's marketing
    // changes, this mail link is the user-facing correction path.
    expect(body).toContain('mailto:support@driftstack.dev');
  });
});
