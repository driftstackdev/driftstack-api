// W502.A — drift guard for apps/marketing-site/src/pages/pricing.astro.
// Pricing landing page — the canonical $79/$249/$699 Manual + $149/$499/$1,499
// API ladder + Enterprise-from-$4k + self-hosted SKUs + the perpetual free tier.
// Drift here either changes a tier price (would create marketing↔Stripe
// invoice divergence) or breaks the 'pay per concurrent session, no surprise
// overage' framing that the entire pricing narrative rests on.
//
//   • 5-import set from pricing.ts: API_TIERS + SELF_HOSTED_* (TRIAL_PACK retired).
//   • fmtUsd helper (whole vs decimal formatting branch).
//   • fmtAiAgent 3-state: byok_only / byok_or_bundled / byok_or_bundled_custom.
//   • Free-tier hero card: $0 perpetual, data-bound profiles/concurrent,
//     20-min session cap, never expires.
//   • Positioning band: 'Pay per concurrent session.' + 'No surprise
//     overage bills.' framing.
//   • v2 Band-A decision fork (2026-07-03): 'who drives the sessions'
//     question + '#manual / #api' anchor cards + both-workflows card.
//   • One-sentence concurrent/profile glossary above the ladders
//     (browser-tabs metaphor, consistent with the homepage).
//   • V-502 'Which tier is right for me?' decision-tree section: Free
//     $0 / Personal $79 / Team $249 / Agency $699
//     / API Starter $149 / API Builder $499 / API Scale $1,499 /
//     Enterprise from $4,000.
//   • Monthly/annual toggle with −20% annual savings badge.
//   • Product + AggregateOffer JSON-LD, figures DERIVED from API_TIERS
//     (lowPrice = free tier / highPrice = max listed monthly /
//     offerCount = tier count), NO fabricated ratings or reviews.
//   • BYOK / Bundled LLM explainer.
//   • Mini FAQ teaser: 4 questions + 'See full FAQ' link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W502.A apps/marketing-site/src/pages/pricing.astro content parity', () => {
  const body = read(LIB);

  it('5-import set from pricing.ts: API_TIERS + SELF_HOSTED_ARCHETYPE_UPDATES + SELF_HOSTED_SKUS + SELF_HOSTED_SOFTWARE_UPDATES + SELF_HOSTED_SOURCE_ACCESS (TRIAL_PACK retired) — pinned so the tier-data import stays sourced from the canonical pricing.ts (drift to hardcoding here would diverge from the pricing-page comparison + checkout + FAQ when the tier table changes)', () => {
    const imp = body.match(/import \{([\s\S]*?)\} from '\.\.\/data\/pricing\.ts';/);
    expect(imp).not.toBeNull();
    for (const sym of [
      'API_TIERS',
      'SELF_HOSTED_ARCHETYPE_UPDATES',
      'SELF_HOSTED_SKUS',
      'SELF_HOSTED_SOFTWARE_UPDATES',
      'SELF_HOSTED_SOURCE_ACCESS',
    ]) {
      expect(imp![1]!).toContain(sym);
    }
    expect(imp![1]!).not.toContain('TRIAL_PACK');
  });

  it("fmtAiAgent 3-state LLM-billing map: byok_only → 'BYOK — bring your own Anthropic key' (S20b self-glossing cell) / byok_or_bundled → 'BYOK or bundled (your choice)' / byok_or_bundled_custom → 'BYOK or bundled (custom rate)' — pinned so the 3-state AI-agent column display strings stay consistent (drift to dropping the Anthropic naming would obscure which model provider; drift to dropping 'custom rate' would lose the Enterprise-tier signal)", () => {
    expect(body).toMatch(/case 'byok_only':\s*\n?\s*return 'BYOK — bring your own Anthropic key';/);
    expect(body).toMatch(
      /case 'byok_or_bundled':\s*\n?\s*return 'BYOK or bundled \(your choice\)';/,
    );
    expect(body).toMatch(
      /case 'byok_or_bundled_custom':\s*\n?\s*return 'BYOK or bundled \(custom rate\)';/,
    );
  });

  it("Free-tier hero card pinned: 'A perpetual free tier to evaluate the platform' + data-bound profiles/concurrent + '20-minute' session cap + 'never expires' — pinned so the perpetual / 1-profile / 1-concurrent / 20-min-cap / no-expiry framing survives. (2026-05-28: free has API access within the 1-session/20-min limits; the old 'no API access' claim was dropped per the accept-+-reconcile-copy decision — paid API tiers remain the path to production-scale concurrency.)", () => {
    expect(body).toMatch(/A perpetual free tier to evaluate the platform/);
    expect(body).toMatch(/\{freeTier\.profiles\} profile/);
    expect(body).toMatch(/\{freeTier\.concurrent\}/);
    // S20b 2026-07-06: "concurrent session ... manual-only via the desktop
    // GUI client" → "session at a time ... driven by hand in our desktop
    // app" — same 20-minute cap, plain words.
    expect(body).toMatch(/session at a time \(up to 20 minutes each\)/);
    expect(body).toMatch(/it never expires/);
  });

  it("Free-tier mechanics framing pinned: 'No usage metering at all' + 'Upgrade to a paid tier when you need the API' — pinned so the no-metering / upgrade-for-API framing survives (drift here would blur the free↔paid boundary)", () => {
    expect(body).toMatch(/No usage metering at all/);
    expect(body).toMatch(/Upgrade to a paid tier when you need the\s+API/);
  });

  it("Positioning band pinned: 'Pay per concurrent session.' + 'Run as many hours as you want within your concurrent cap.' + 'No surprise overage bills.' — pinned so the 3-part flat-pricing-no-surprise narrative survives (drift to dropping 'No surprise overage bills' would weaken the central differentiation against per-hour vendors like Browserless)", () => {
    expect(body).toMatch(/Pay per concurrent session\./);
    expect(body).toMatch(/Run as many hours as you want within your concurrent cap\./);
    expect(body).toMatch(/No surprise overage bills\./);
  });

  it("V-502 decision-tree section 8 tier cards: Free $0 + Personal $79 + Team $249 + Agency $699 + API Starter $149 + API Builder $499 + API Scale $1,499 + Enterprise from $4,000 — pinned so the 8-tier 'which is right for me' decision-tree stays complete (drift to dropping any tier would orphan that-tier prospects; drift to changing a price would create marketing↔Stripe-invoice divergence)", () => {
    expect(body).toMatch(/Free — \$0, forever/);
    expect(body).toMatch(/Personal — \$79\/mo/);
    expect(body).toMatch(/Team — \$249\/mo/);
    expect(body).toMatch(/Agency — \$699\/mo/);
    expect(body).toMatch(/API Starter — \$149\/mo/);
    expect(body).toMatch(/API Builder — \$499\/mo/);
    expect(body).toMatch(/API Scale — \$1,499\/mo/);
    expect(body).toMatch(/Enterprise — from \$4,000\/mo/);
  });

  it("Personal decision-card framing pinned: 'One person clicking in the desktop app; up to 10 saved profiles. Run 1 session at a time across 10 different client identities' — pinned so the 1-session/10-profile/desktop framing stays consistent (drift to dropping '10 saved profiles' would create marketing↔pricing-table divergence on the per-tier profile counts). 2026-07-03 Band-A rewording: 'human clicking in the desktop GUI client' → 'person clicking in the desktop app', 'persistent profiles' → 'saved profiles' — same figures, plainer words", () => {
    expect(body).toMatch(
      /One person clicking in the desktop app; up to 10 saved profiles\.\s*\n?\s*Run 1 session at a time across 10 different client identities/,
    );
  });

  it("v2 Band-A decision fork pinned: 'who drives the sessions — a person clicking, or code calling?' question + '#manual'/'#api' anchor cards ('A person → Manual.' / 'Code → API.') + the quieter both-workflows card — pinned so the plain-language fork that routes non-technical buyers into the right ladder survives (drift to dropping an anchor card would strand one audience above the wrong ladder)", () => {
    expect(body).toMatch(/who drives the sessions — a person\s*\n?\s*clicking, or code calling\?/);
    expect(body).toMatch(/<a href="#manual" class="card block p-8">/);
    expect(body).toMatch(/<a href="#api" class="card block p-8">/);
    expect(body).toMatch(/A person → Manual\./);
    expect(body).toMatch(/You drive iPhones by hand in the desktop app\./);
    expect(body).toMatch(/Code → API\./);
    expect(body).toMatch(/Your scripts and automated jobs run the sessions\./);
    expect(body).toMatch(/Both ladders run the same engine and share the same free tier\./);
  });

  it("concurrent/profile glossary pinned above the ladders: 'concurrent means sessions running at the same time — think browser tabs' + 'profile is a saved iPhone identity that keeps its logins and history' — pinned so both ladder column headers stay defined in plain words before the tables use them (the browser-tabs metaphor matches the homepage metering band; drift here would re-jargonize the ladders' two load-bearing terms)", () => {
    expect(body).toMatch(
      /concurrent<\/strong> means\s*\n?\s*sessions running at the same time — think browser tabs/,
    );
    // S20b 2026-07-06: the glossary line grew a third term (BYOK) — the
    // profile definition now continues with ", and" instead of a period.
    expect(body).toMatch(
      /profile<\/strong> is a saved iPhone identity\s*\n?\s*that keeps its logins and history/,
    );
  });

  it("Product + AggregateOffer JSON-LD pinned: '@type Product' + '@type AggregateOffer' with lowPrice/highPrice/offerCount DERIVED from API_TIERS (String(freeTier.monthlyUsd) / String(Math.max(...listedMonthlyUsd)) / String(API_TIERS.length)) and NO aggregateRating/review keys — pinned so the structured data stays data-bound (hand-typed dollars would diverge from pricing.ts) and strictly factual (fabricated ratings are a hard guardrail violation + a Google structured-data penalty risk)", () => {
    expect(body).toMatch(
      /<script is:inline type="application\/ld\+json" set:html=\{JSON\.stringify\(pricingStructuredData\)\} \/>/,
    );
    expect(body).toMatch(/'@type': 'Product'/);
    expect(body).toMatch(/'@type': 'AggregateOffer'/);
    expect(body).toMatch(/priceCurrency: 'USD'/);
    expect(body).toMatch(/lowPrice: String\(freeTier\.monthlyUsd\)/);
    expect(body).toMatch(/highPrice: String\(Math\.max\(\.\.\.listedMonthlyUsd\)\)/);
    expect(body).toMatch(/offerCount: String\(API_TIERS\.length\)/);
    expect(body).not.toMatch(/aggregateRating/i);
    expect(body).not.toMatch(/reviewCount/i);
  });

  it("Annual −20% toggle pinned: 'Monthly' button + 'Annual' button + '−20%' badge — pinned so the monthly/annual toggle UI + the 20% annual savings positioning survives (drift to dropping the −20% badge would hide the annual-contract discount that drives high-ACV deals)", () => {
    expect(body).toMatch(/data-period="monthly"/);
    expect(body).toMatch(/data-period="annual"/);
    expect(body).toMatch(/−20%/);
  });

  it("Manual ladder header pinned: 'Manual — for humans' + 'Saved profiles that keep their logins. Drive sessions yourself in the desktop app. No code required.' (S20b plain words, same positioning) — pinned so the Manual-ladder positioning (humans + desktop app + no-code) stays consistent (drift to dropping 'No code required' would obscure why Manual is a separate ladder from API)", () => {
    expect(body).toMatch(/Manual — for humans/);
    expect(body).toMatch(
      /Saved profiles that keep their logins\. Drive sessions yourself in\s*\n?\s*the desktop app\. No code required\./,
    );
  });

  it("API ladder BYOK explainer pinned: 'bring your own API key from Anthropic for the optional AI agent feature. Your model spend goes to your provider account; Driftstack doesn't markup or proxy.' — pinned so the BYOK-anthropic + no-markup framing survives (drift to claiming markup would invite billing-transparency pushback; drift to dropping anthropic specificity would obscure which provider the BYOK uses)", () => {
    expect(body).toMatch(/<em>bring your own API key<\/em> from Anthropic for the optional AI/);
    // S20b 2026-07-06: no-markup claim in plain words, same commitment.
    expect(body).toMatch(
      /You pay Anthropic directly for the AI usage —\s*\n?\s*Driftstack adds no markup and never sits in the middle\./,
    );
  });

  it("Self-hosted ladder header pinned: 'Self-hosted — for full control' + 'Run the entire stack on your own hardware. No concurrent-session caps from us — your hardware is the cap. Driftstack licenses the software; you add machines whenever you need more capacity.' (S20b plain words) — pinned so the no-license-cap + hardware-is-the-cap unit-economics flip survives (drift to dropping 'No concurrent-session caps from us' would lose THE core self-hosted economic narrative)", () => {
    expect(body).toMatch(/Self-hosted — for full control/);
    expect(body).toMatch(
      /Run the entire stack on your own hardware\. No concurrent-session caps from\s*\n?\s*us — your hardware is the cap\. Driftstack licenses the software; you\s*\n?\s*add machines whenever you need more capacity\./,
    );
  });

  it('BYOK / Bundled LLM section pins the live $0.10 standard turn rate, Enterprise custom-rate boundary, desktop/API enablement, and self-hosted BYOK-only posture', () => {
    expect(body).toMatch(/BYOK or bundled — your call\./);
    expect(body).toMatch(/Bundled LLM \(API Builder, API Scale, Enterprise\)/);
    expect(body).toMatch(/\$0\.10 per agent turn/);
    expect(body).toMatch(/counts against the monthly cap you control/);
    expect(body).toMatch(/Enterprise can use a\s*\n?\s*contracted custom rate/);
    expect(body).toMatch(/Settings → AI &amp; billing/);
    expect(body).toMatch(/bundled-LLM settings API/);
    expect(body).not.toMatch(/announced at launch|per-token rate/i);
    // S20b 2026-07-06: same architectural reason, plain words.
    expect(body).toMatch(
      /Self-hosted\s+plans are BYOK-only\s+because we don't route AI calls into hardware you\s+own\./,
    );
  });

  it("Mini FAQ teaser 4 questions: 'Manual or API — which one?' + 'Why concurrent caps and not hours?' + 'Can I switch tiers mid-month?' + 'Does the free tier expire?' + 'See full FAQ' → /faq — pinned so the 4-question pricing-FAQ teaser stays complete (drift to dropping the concurrent-caps explainer would lose the why-not-hourly answer; drift to dropping the free-tier answer would orphan free-tier prospects)", () => {
    expect(body).toMatch(/Manual or API — which one\?/);
    expect(body).toMatch(/Why concurrent caps and not hours\?/);
    expect(body).toMatch(/Can I switch tiers mid-month\?/);
    expect(body).toMatch(/Does the free tier expire\?/);
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See full FAQ<\/a>/);
    expect(body).not.toContain('<a href="/faq" class="btn-secondary">See full FAQ</a>');
  });

  it("VAT framing pinned: 'All prices in USD. Sales tax (VAT — called BTW in the Netherlands) is added where EU rules require it. No setup fees on any tier. Annual contracts billed up front.' (S20b plain words) — pinned so the USD-base + VAT/BTW + no-setup-fee + annual-prepay 4-state commitment survives (drift to dropping VAT/BTW would surprise EU customers at checkout; drift to dropping 'no setup fees' would let prospects assume hidden onboarding charges)", () => {
    expect(body).toMatch(
      /All prices in USD\. Sales tax \(VAT — called BTW in the Netherlands\) is\s*\n?\s*added where EU rules require it\. No setup fees on any tier\. Annual\s*\n?\s*contracts billed up front\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
