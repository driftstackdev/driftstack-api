// W372.A — drift guard for marketing-site /pricing page content.
// V-502 + v2 redesign (2026-07-03 "Plain Words, Same Teeth" pass).
// Existing pricing-* tests (concurrency-profile-cap-parity,
// pricing-data-binding-parity, pricing-section-anchors-baseline,
// pricing-hero-baseline, pricing-tier-ordering-parity, pricing-
// tier-id-schema-parity, ladder-coverage,
// crypto-parity, manual-tier-figures, api-tier-figures) cover the
// data-driven sections. This guard pins the load-bearing UX +
// content claims:
//
//   • SELF_HOSTED_SKUS + API_TIERS sourced from
//     ../data/pricing.ts (data-driven, not inline-hardcoded; TRIAL_PACK retired).
//   • 5 canonical section anchors: #free / #which-tier
//     (V-502 decision tree) / #manual / #api / #self-hosted.
//   • Band-A decision fork: "who drives the sessions" question +
//     #manual / #api anchor cards + the quieter both-workflows card.
//   • One-sentence glossary above the ladders (concurrent = browser
//     tabs metaphor, matching the homepage; profile = saved identity).
//   • V-502 decision-tree teaser ladder pinned with
//     verbatim title strings (Free $0 → Enterprise from $4,000).
//   • Monthly/annual toggle wired (id=billing-toggle + data-
//     period-target=monthly/annual).
//   • Fixed browser subscription + concurrent-cap landing copy pinned.
//   • Product + AggregateOffer JSON-LD, figures DERIVED from
//     API_TIERS, with NO fabricated ratings/reviews.
//   • BYOK-or-bundled LLM explainer: Anthropic console link +
//     Self-hosted SKUs are BYOK-only.
//   • Free tier is perpetual (never expires; matches /faq's claim).
//   • Stripe-proration mid-month claim pinned.
//   • Mini-FAQ teaser with 4 questions + /faq cross-link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');
const PRICING_DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W372.A marketing-site /pricing page content parity', () => {
  const body = read(PAGE);

  it('SELF_HOSTED_SKUS + API_TIERS sourced from ../data/pricing.ts (data-driven; TRIAL_PACK retired)', () => {
    expect(existsSync(PRICING_DATA)).toBe(true);
    const imp = body.match(/import \{([\s\S]*?)\} from '\.\.\/data\/pricing\.ts'/);
    expect(imp).not.toBeNull();
    expect(imp![1]!).toContain('API_TIERS');
    expect(imp![1]!).toContain('SELF_HOSTED_SKUS');
    expect(imp![1]!).not.toContain('TRIAL_PACK');
  });

  it('canonical section anchors pinned: #free / #which-tier / #manual / #api / #self-hosted', () => {
    expect(body).toMatch(/<section id="free"/);
    expect(body).toMatch(/<section\s*\n?[^>]*id="which-tier"/);
    expect(body).toMatch(/<section id="manual"/);
    expect(body).toMatch(/<section id="api"/);
    expect(body).toMatch(/<section id="self-hosted"/);
  });

  it('Band-A decision fork pinned: "who drives the sessions" question + #manual / #api anchor cards + both-workflows card', () => {
    expect(body).toMatch(/who drives the sessions — a person\s*clicking, or code calling\?/);
    // The two fork cards are anchor links straight into the ladders.
    expect(body).toMatch(/<a href="#manual" class="card block p-8">/);
    expect(body).toMatch(/<a href="#api" class="card block p-8">/);
    expect(body).toMatch(/A person → Manual\./);
    expect(body).toMatch(/You drive iPhones by hand in the desktop app\./);
    expect(body).toMatch(/Code → API\./);
    expect(body).toMatch(/Your scripts and automated jobs run the sessions\./);
    // The quieter third card: both ladders share the engine + free tier.
    expect(body).toMatch(/Both\? Neither yet\? Start free\./);
    expect(body).toMatch(/Both ladders run the same engine and share the same free tier\./);
  });

  it('one-sentence glossary above the ladders: concurrent (browser-tabs metaphor, matches homepage) + profile (saved iPhone identity)', () => {
    expect(body).toMatch(
      /concurrent<\/strong> means\s*sessions running at the same time — think browser tabs/,
    );
    // S20b 2026-07-06: the glossary line grew a third term (BYOK) — the
    // profile definition now continues with ", and" instead of a period.
    expect(body).toMatch(
      /profile<\/strong> is a saved iPhone identity\s*that keeps its logins and history/,
    );
  });

  it('Product + AggregateOffer JSON-LD: figures derived from API_TIERS, strictly factual (no ratings/reviews)', () => {
    expect(body).toMatch(
      /<script is:inline type="application\/ld\+json" set:html=\{JSON\.stringify\(pricingStructuredData\)\} \/>/,
    );
    expect(body).toMatch(/'@type': 'Product'/);
    expect(body).toMatch(/'@type': 'AggregateOffer'/);
    // Derived, not hand-typed: lowPrice = free tier, highPrice = max
    // listed monthly, offerCount = tier count.
    expect(body).toMatch(/lowPrice: String\(freeTier\.monthlyUsd\)/);
    expect(body).toMatch(/highPrice: String\(Math\.max\(\.\.\.listedMonthlyUsd\)\)/);
    expect(body).toMatch(/offerCount: String\(API_TIERS\.length\)/);
    expect(body).toMatch(/priceCurrency: 'USD'/);
    // Hard guardrail: never fabricate social proof in structured data.
    expect(body).not.toMatch(/aggregateRating/i);
    expect(body).not.toMatch(/"review"|'review'|reviewCount/i);
  });

  it('V-502 decision-tree 7-tier teaser ladder pinned verbatim', () => {
    // Order matches the buyer's mental ladder (Free → Manual ladder
    // → API ladder → Enterprise). Pin so a future reorder requires
    // an explicit decision.
    for (const t of [
      'Free — $0, forever',
      'Personal — $79/mo',
      'Team — $249/mo',
      'Agency — $699/mo',
      'API Starter — $149/mo',
      'API Builder — $499/mo',
      'API Scale — $1,499/mo',
      'Enterprise — from $4,000/mo',
    ]) {
      expect(body, `tier title missing: ${t}`).toContain(t);
    }
  });

  it('monthly/annual toggle wired (id=billing-toggle + data-period-target=monthly/annual)', () => {
    expect(body).toMatch(/id="billing-toggle"/);
    expect(body).toMatch(/role="group"\s*aria-label="Billing period"/);
    expect(body).toContain('aria-pressed="true"');
    expect(body).toContain('aria-pressed="false"');
    expect(body).toMatch(/btn\.setAttribute\(\s*'aria-pressed'/);
    expect(body).not.toContain('role="tablist"');
    expect(body).not.toContain('aria-selected');
    expect(body).toMatch(/data-period="annual"/);
    expect(body).toMatch(/data-period-target="monthly"/);
    expect(body).toMatch(/data-period-target="annual"/);
    expect(body).toMatch(/setPeriod\('monthly'\);/);
  });

  it('fixed browser subscription + concurrent-cap landing-band copy pinned', () => {
    expect(body).toMatch(/Browser subscriptions are priced by concurrent capacity\./);
    expect(body).toMatch(/No browser-usage overage bills/);
    expect(body).toMatch(/session hours, API calls, and page navigations are unmetered within/);
    expect(body).toMatch(/bundled LLM uses a separate included-service monthly budget/);
    // Concurrent definition aligned with /faq + /index.
    expect(body).toMatch(
      /Concurrent sessions<\/strong> = how many\s+sessions you can run at the same time, like browser tabs you'd have\s+open at once/,
    );
  });

  it('BYOK-or-bundled LLM explainer: included-service budget + Anthropic link + Self-hosted BYOK-only', () => {
    expect(body).toMatch(/BYOK or bundled — your call\./);
    expect(body).toContain('console.anthropic.com');
    expect(body).toMatch(/Bundled LLM \(API Builder, API Scale, Enterprise\)/);
    expect(body).toMatch(/Self-hosted\s*plans are BYOK-only/);
    expect(body).toMatch(/\$0\.10 per agent turn/);
    expect(body).toMatch(/included-service accounting value/);
    expect(body).toMatch(/not separately itemized on\s+today's Stripe invoice/);
    expect(body).not.toMatch(
      /billed on one invoice|bundled per-token rate is announced at launch/i,
    );
  });

  it('free-tier perpetual claim pinned: never expires + upgrade to a paid tier (matches /faq; S20b: whitespace-tolerant — the sentence rewrapped)', () => {
    expect(body).toMatch(/The free tier is perpetual/);
    expect(body).toMatch(/subscribe\s+to a paid tier from your dashboard/);
  });

  it('Stripe-proration mid-month claim pinned ("Yes. Stripe prorates the change automatically"; S20b: "session-creation gate" reworded plain, same when-it-applies fact)', () => {
    expect(body).toMatch(/Stripe prorates the change automatically\./);
    expect(body).toMatch(/New limits apply\s+the next time you start a session/);
  });

  it('mini-FAQ teaser with 4 questions + /faq cross-link', () => {
    expect(body).toMatch(/<h3 class="font-medium text-tk-ink">Manual or API — which one\?<\/h3>/);
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink">Why concurrent caps and not hours\?<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink">Can I switch tiers mid-month\?<\/h3>/,
    );
    expect(body).toMatch(/<h3 class="font-medium text-tk-ink">Does the free tier expire\?<\/h3>/);
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See full FAQ<\/a>/);
  });

  it('free-tier header card cross-links: signup + docs + data-bound price', () => {
    expect(body).toMatch(/href="https:\/\/app\.driftstack\.dev\/signup\/"/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev"/);
    expect(body).toMatch(/Free — \{fmtUsd\(freeTier\.monthlyUsd\)\}, forever/);
  });

  it('free-tier no-metering framing pinned', () => {
    expect(body).toMatch(/No usage metering at all/);
  });

  it('"720 browser-hours/month" surprise-overage example pinned (concurrent-caps rationale)', () => {
    expect(body).toMatch(/720 browser-hours\/month\s+and a surprise overage bill/);
  });

  it('cross-link to /pricing/comparison per-tier side-by-side pinned', () => {
    // Astro source splits attributes + the closing `>` across lines;
    // tolerate WS. v2: accent-colored TEXT uses the AA-safe
    // text-tk-accent-text token (raw text-tk-accent fails WCAG AA on
    // the dark bg).
    expect(body).toMatch(
      /<a\s*href="\/pricing\/comparison\/"\s*class="font-medium text-tk-accent-text underline[^"]*"\s*>/,
    );
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/comparison.astro')),
    ).toBe(true);
  });

  it("'sessions-at-once limited by your hardware, not the license' self-hosted teaser pinned (S20b plain words, same fact) + the source-escrow gloss", () => {
    expect(body).toMatch(
      /How many sessions run at once is limited by your hardware, not\s*by the license\./,
    );
    expect(body).toMatch(/Source escrow means a neutral third party/);
    expect(body).toMatch(/Hardware procurement detail at\{' '\}/);
    // v2: accent-colored TEXT uses the AA-safe text-tk-accent-text token.
    expect(body).toMatch(
      /<a\s*href="\/self-hosted\/"\s*class="text-tk-accent-text underline[^"]*"\s*>/,
    );
  });
});
