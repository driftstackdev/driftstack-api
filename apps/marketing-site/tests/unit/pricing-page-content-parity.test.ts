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
    expect(body).toMatch(
      /Both plan families give you the same real iPhones and share the same free tier\./,
    );
    // 2026-09-15 refuter: the free tier cannot run a session from code
    // (TIER_FEATURES.free.apiAccess false; requireProgrammaticApiAccess) —
    // the both-workflows card must not promise "run one from code".
    expect(body).not.toMatch(/run one from code/);
    expect(body).toMatch(
      /Start free and drive a session by hand; the API and SDKs come with\s*any paid plan, so you can try code-driven sessions the moment you\s*upgrade\./,
    );
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
    // 2026-09-15 plain-words pass: same facts (priced by sessions-at-once,
    // hours/calls/visits unlimited inside it, no browser-usage extras, the
    // bundled AI budget is separate) without billing-internals vocabulary.
    expect(body).toMatch(/Browser plans are priced by how many sessions you can run at once\./);
    expect(body).toMatch(/No extra bills for browser usage\./);
    expect(body).toMatch(/hours, API calls and page visits inside it are unlimited/);
    expect(body).toMatch(
      /optional AI agent with Driftstack-supplied AI access \(the\s+"bundled" option\), that has its own monthly budget/,
    );
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
    // 2026-09-15 plain words: $0.10 per agent turn against a budget the
    // customer sets; the budget is included, not billed separately today.
    expect(body).toMatch(
      /each agent turn counts <strong\s*>\$0\.10<\/strong\s*> against a monthly budget you set/,
    );
    expect(body).toMatch(
      /That budget is included in your plan\s+and is not billed separately today\./,
    );
    expect(body).not.toMatch(
      /billed on one invoice|bundled per-token rate is announced at launch/i,
    );
  });

  it('free-tier perpetual claim pinned: never expires + upgrade to a paid tier (matches /faq; S20b: whitespace-tolerant — the sentence rewrapped)', () => {
    expect(body).toMatch(/The free tier never expires/);
    expect(body).toMatch(/subscribe\s+to a paid tier from your dashboard/);
  });

  it('Stripe-proration mid-month claim pinned ("Yes. Stripe prorates the change automatically"; S20b: "session-creation gate" reworded plain, same when-it-applies fact)', () => {
    // 2026-09-15: processor name + "prorates" dropped; the customer-facing
    // facts (upgrade now, pay the difference; downgrade at renewal) pinned.
    expect(body).toMatch(
      /Moving up takes effect right away and you pay only the\s+difference for the rest of the billing period\. Moving down takes\s+effect at your next renewal\./,
    );
    expect(body).toMatch(/New limits apply\s+the next time you\s+start a session/);
  });

  it('mini-FAQ teaser with 4 questions + /faq cross-link', () => {
    expect(body).toMatch(/<h3 class="font-medium text-tk-ink">Manual or API — which one\?<\/h3>/);
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink">Why limit sessions at once, and not hours\?<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink">Can I switch tiers mid-month\?<\/h3>/,
    );
    expect(body).toMatch(/<h3 class="font-medium text-tk-ink">Does the free tier expire\?<\/h3>/);
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See full FAQ<\/a>/);
  });

  // 2026-09-15 truth pass — the free tier's real shape (TIER_FEATURES: apiAccess
  // false / vpnEgress false / aiAgent false; ARCHETYPE_DEVICES_PER_TIER.free =
  // iPhone 13 + 13 mini) is stated on the card, data-bound where the data
  // exists; paid-tier device breadth binds to DEVICE_SUPPORT; concurrency is
  // counted in sessions, never people; the "What comes with your plan" band
  // names shipped, un-gated features only.
  it('free-tier card states no API/SDK, no VPN (one SOCKS5 or HTTP proxy you bring — only the VPN schemes are gated), no AI agent, and binds its device entitlement to freeTier.archetypeAccess; the engine bullet is house style', () => {
    expect(body).toMatch(/our desktop app, on the \{freeTier\.archetypeAccess\}\./);
    // 2026-09-15 refuter: the free tier's one saved proxy may be SOCKS5 or
    // HTTP — routes/account-me.ts gates only openvpn/wireguard on vpnEgress.
    expect(body).not.toMatch(/one saved SOCKS5 proxy on the free plan/);
    expect(body).toMatch(
      /no API or SDK access, and no VPN\. Sessions browse through a\s*proxy you bring — one saved SOCKS5 or HTTP proxy on the free plan\./,
    );
    expect(body).toMatch(
      /Every paid plan includes the API and adds OpenVPN and\s*WireGuard exits\./,
    );
    expect(body).toMatch(
      /No AI agent on the free plan — it starts at Team, and is\s*on every API plan\./,
    );
    expect(body).not.toMatch(/access from code \(the API and SDKs\) starts with the API\s*plans/);
    expect(body).not.toMatch(/nothing patched on top to fake it/);
    expect(body).toMatch(
      /A build of Apple's own <a href="\/glossary\/#webkit"[^>]*>WebKit<\/a> — the engine family behind iPhone Safari\./,
    );
  });

  it('"every tier gives you the same real iPhones" is gone: paid tiers get every device profile (DEVICE_SUPPORT-bound), the free tier runs freeTier.archetypeAccess, the AI agent is Team-and-up + every API plan (stated on the fork, the Manual header, the BYOK explainer and the free FAQ)', () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/data\/capabilities';/);
    expect(body).not.toMatch(/Every tier gives you the same real iPhones\./);
    expect(body).toMatch(
      /Every paid tier gives you every device profile we offer — 19 iPhone\s*models, from the 13 to the 17 Pro Max/,
    );
    // 2026-09-15 refuter: the catalog is 19 named models, not "every iPhone"
    // released between the endpoints (no SE 3rd gen, 16e or Air).
    expect(body).not.toMatch(/every\s*iPhone from the 13 to the 17 Pro Max/i);
    expect(body).toMatch(
      /\{DEVICE_SUPPORT\.selectableCount\} device\s*profiles\) on iOS 18, with Safari \{DEVICE_SUPPORT\.safariVersions\}/,
    );
    expect(body).toMatch(/The free tier runs the\s*\{freeTier\.archetypeAccess\}\./);
    expect(body).toMatch(/the AI agent \(Team and up, and every API\s*plan\)/);
    expect(body).toMatch(
      /The AI agent is on Team and Agency \(bring your own\s*Anthropic key\); Personal is hands-on only\./,
    );
    expect(body).toMatch(
      /The AI agent is on Team and Agency and on every API plan; Free and\s*Personal don't include it\./,
    );
    expect(body).toMatch(
      /The AI agent is on every API plan\. Your\s*code signs in with a scoped API key/,
    );
    expect(body).toMatch(
      /When you need the API, every\s*device profile, a VPN exit, more sessions at once/,
    );
  });

  it('concurrency is sessions, not people: the Team / Agency teaser cards and the Manual fork card count sessions at once (S31 conflation fix extended)', () => {
    expect(body).not.toMatch(/people clicking at the same time/);
    expect(body).not.toMatch(/people working at once/);
    expect(body).not.toMatch(/how many people can work at once/);
    expect(body).toMatch(
      /3 sessions at the same time; 50 profiles, shared with the\s*teammates you invite\./,
    );
    expect(body).toMatch(/8 sessions at once; 200 profiles\./);
    expect(body).toMatch(
      /Tiers differ\s*by how many sessions run at once and how many profiles you keep\./,
    );
  });

  it('both ladders carry a data-bound "Device types" row ({tier.archetypeAccess}) — exactly twice, once per ladder', () => {
    const rows = body.match(
      /<dt class="text-tk-ink-3">Device types<\/dt>\s*<dd class="text-right text-tk-ink">\{tier\.archetypeAccess\}<\/dd>/g,
    );
    expect(rows).toHaveLength(2);
  });

  it('"What comes with your plan" band names shipped, reachable features only (recycle bin / export-import / proxy Test readouts / floating device window / local recordings / teammates with roles / MFA + web sessions + audit CSV / per-turn AI cost + web-dashboard billing / card or crypto) — never cost ALERTS (sink logger-only in bootstrap.ts), never the unmounted account cost VIEW, never snapshot-as-rollback, never "members … work on", never receipts "from the desktop app"', () => {
    expect(body).toMatch(/title="What comes with your plan\."/);
    for (const h of [
      'Profiles you can look after',
      'Your own exits, tested before launch',
      'A floating device window',
      'Recordings that stay on your machine',
      'Teammates with roles',
      'Account security',
      'Costs in view',
      'Pay by card or crypto',
    ]) {
      expect(body, h).toContain(`<h3 class="font-medium text-tk-ink">${h}</h3>`);
    }
    expect(body).toMatch(
      /Recordings are kept on your own computer and can be exported as a\s*file; they are not uploaded\./,
    );
    // 2026-09-15 refuter pass — four cards re-scoped to what a customer can
    // reach: snapshots are metadata-only + API-only (dropped from the profiles
    // card); members are read-only (team-rbac.md); the account cost view is
    // mounted nowhere (BillingCostView has no importer; App.tsx routes
    // 'billing' to BillingMovedView; the dashboard never reads
    // /v1/account/cost); crypto receipts download from the web dashboard's
    // billing page (customer-dashboard billing.astro), not the desktop app.
    expect(body).not.toMatch(/Take a snapshot of a profile before a risky change/);
    expect(body).not.toMatch(/bring that\s*state back later/);
    expect(body).toMatch(
      /Deleted profiles go to a recycle bin first, and you can bring one\s*back from there\./,
    );
    expect(body).not.toMatch(/On a paid plan, invite teammates as members or admins\./);
    expect(body).toMatch(
      /invite teammates as admins, who can run your\s*profiles and sessions under your account, or as read-only members,\s*who can view them but not change anything\./,
    );
    expect(body).not.toMatch(/billing cycle's spend in the desktop app/);
    expect(body).toMatch(/The AI agent shows the cost of each turn as it runs\./);
    expect(body).not.toMatch(/download as PDF from the desktop app/);
    expect(body).toMatch(
      /crypto receipts\s*download as PDF from the billing page of your web dashboard\./,
    );
    expect(body).not.toMatch(/cost alert/i);
    // 2026-09-15 refuter (same class as the free card): the proxy a profile
    // can carry is SOCKS5 or HTTP — routes/account-me.ts gates only the
    // openvpn/wireguard schemes on vpnEgress, so the exits card must not
    // say "SOCKS5" alone.
    expect(body).not.toMatch(/Attach a SOCKS5 proxy to each profile/);
    expect(body).toMatch(
      /Attach a SOCKS5 or HTTP proxy to each profile; paid plans add OpenVPN and\s*WireGuard tunnels\./,
    );
    // The Network pane cannot populate today (no producer on either side) —
    // the floating-window card must not advertise it.
    expect(body).not.toMatch(/panes for cookies,[^.]*network/i);
  });

  it('free-tier header card cross-links: signup + docs + data-bound price', () => {
    expect(body).toMatch(/href="https:\/\/app\.driftstack\.io\/signup\/"/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.io"/);
    expect(body).toMatch(/Free — \{fmtUsd\(freeTier\.monthlyUsd\)\}, forever/);
  });

  it('free-tier no-metering framing pinned', () => {
    expect(body).toMatch(/No hourly charges and no usage counting/);
  });

  it('"720 browser-hours/month" surprise-overage example pinned (concurrent-caps rationale)', () => {
    expect(body).toMatch(/720 hours a month\s+and a surprise bill/);
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
    expect(body).toMatch(/Hardware guidance at\{' '\}/);
    // v2: accent-colored TEXT uses the AA-safe text-tk-accent-text token.
    expect(body).toMatch(
      /<a\s*href="\/self-hosted\/"\s*class="text-tk-accent-text underline[^"]*"\s*>/,
    );
  });
});
