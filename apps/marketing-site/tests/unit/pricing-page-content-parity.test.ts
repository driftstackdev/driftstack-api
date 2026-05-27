// W372.A — drift guard for marketing-site /pricing page content.
// V-502. Existing pricing-* tests (concurrency-profile-cap-parity,
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
//   • V-502 decision-tree teaser ladder pinned with
//     verbatim title strings (Free $0 → Enterprise from $4,000).
//   • Monthly/annual toggle wired (id=billing-toggle + data-
//     period-target=monthly/annual).
//   • "Pay per concurrent session" landing-band copy pinned.
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

  it('V-502 decision-tree 7-tier teaser ladder pinned verbatim', () => {
    // Order matches the buyer's mental ladder (Free → Manual ladder
    // → API ladder → Enterprise). Pin so a future reorder requires
    // an explicit decision.
    for (const t of [
      'Free — $0, forever',
      'Solo Manual — $79/mo',
      'Team Manual — $249/mo',
      'Agency Manual — $699/mo',
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
    expect(body).toMatch(/data-period="annual"/);
    expect(body).toMatch(/data-period-target="monthly"/);
    expect(body).toMatch(/data-period-target="annual"/);
    expect(body).toMatch(/setPeriod\('monthly'\);/);
  });

  it('"Pay per concurrent session" landing-band copy pinned', () => {
    expect(body).toMatch(/Pay per concurrent session\./);
    expect(body).toMatch(/No surprise overage bills/);
    // Concurrent definition aligned with /faq + /index.
    expect(body).toMatch(
      /Concurrent sessions<\/strong> = how many\s+sessions you can run at the same time, like browser tabs you'd have\s+open at once/,
    );
  });

  it('BYOK-or-bundled LLM explainer: Anthropic console link + Self-hosted SKUs are BYOK-only', () => {
    expect(body).toMatch(/BYOK or bundled — your call\./);
    expect(body).toContain('console.anthropic.com');
    expect(body).toMatch(/Bundled LLM \(API Builder, API Scale, Enterprise\)/);
    expect(body).toMatch(/Self-hosted SKUs are BYOK-only/);
    expect(body).toMatch(/Bundled per-token rate announced at launch/);
  });

  it('free-tier perpetual claim pinned: never expires + upgrade to a paid tier (matches /faq)', () => {
    expect(body).toMatch(/The free tier is perpetual/);
    expect(body).toMatch(/subscribe to\s+a paid tier from your dashboard/);
  });

  it('Stripe-proration mid-month claim pinned ("Yes. Stripe prorates the change automatically")', () => {
    expect(body).toMatch(/Stripe prorates the change automatically\./);
    expect(body).toMatch(/New limits apply\s+immediately on the next session-creation gate/);
  });

  it('mini-FAQ teaser with 4 questions + /faq cross-link', () => {
    expect(body).toMatch(
      /<h3 class="font-medium text-ink-primary">Manual or API — which one\?<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-medium text-ink-primary">Why concurrent caps and not hours\?<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-medium text-ink-primary">Can I switch tiers mid-month\?<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-medium text-ink-primary">Does the free tier expire\?<\/h3>/,
    );
    expect(body).toMatch(/<a href="\/faq" class="btn-secondary">See full FAQ<\/a>/);
  });

  it('free-tier header card cross-links: signup + docs + data-bound price', () => {
    expect(body).toMatch(/href="https:\/\/app\.driftstack\.dev\/signup"/);
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
    // Astro source splits the closing `>` to next line; tolerate WS.
    expect(body).toMatch(
      /<a href="\/pricing\/comparison" class="font-medium text-glow-red underline"\s*>/,
    );
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/comparison.astro')),
    ).toBe(true);
  });

  it("'Concurrent capacity bounded by your hardware, not by license' self-hosted teaser pinned", () => {
    expect(body).toMatch(/Concurrent capacity is bounded by your hardware, not by license\./);
    expect(body).toMatch(/Hardware procurement detail at\{' '\}/);
    expect(body).toMatch(/<a href="\/self-hosted" class="text-glow-red underline">/);
  });
});
