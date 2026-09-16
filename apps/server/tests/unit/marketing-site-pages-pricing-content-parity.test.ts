// W502.A — drift guard for apps/marketing-site/src/pages/pricing.astro.
// Pricing landing page — the canonical $79/$249/$699 Manual + $149/$499/$1,499
// API ladder + Enterprise-from-$4k + self-hosted SKUs + the perpetual free tier.
// Drift here either changes a tier price (would create marketing↔Stripe
// invoice divergence) or breaks the fixed-browser-subscription + concurrent-cap
// framing that the entire pricing narrative rests on.
//
//   • 5-import set from pricing.ts: API_TIERS + SELF_HOSTED_* (TRIAL_PACK retired).
//   • fmtUsd helper (whole vs decimal formatting branch).
//   • fmtAiAgent 3-state: byok_only / byok_or_bundled / byok_or_bundled_custom.
//   • Free-tier hero card: $0 perpetual, data-bound profiles/concurrent,
//     20-min session cap, never expires.
//   • Positioning band: fixed browser subscription + no browser-usage overages.
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

  it('fmtAiAgent 3-state LLM map: byok_only / byok_or_bundled / byok_or_bundled_custom, with Enterprise custom-budget truth', () => {
    expect(body).toMatch(/case 'byok_only':\s*return 'BYOK — bring your own Anthropic key';/);
    expect(body).toMatch(/case 'byok_or_bundled':\s*return 'BYOK or bundled \(your choice\)';/);
    expect(body).toMatch(
      /case 'byok_or_bundled_custom':\s*return 'BYOK or bundled \(custom budget\)';/,
    );
  });

  it("Free-tier hero card pinned: 'A perpetual free tier to evaluate the platform' + data-bound profiles/concurrent + '20-minute' session cap + 'never expires' — pinned so the perpetual / 1-profile / 1-concurrent / 20-min-cap / no-expiry framing survives. (2026-05-28: free has API access within the 1-session/20-min limits; the old 'no API access' claim was dropped per the accept-+-reconcile-copy decision — paid API tiers remain the path to production-scale concurrency.)", () => {
    // 2026-09-15 plain words: 'perpetual' → 'never expires', said once.
    expect(body).toMatch(/A free tier that never expires — no card required\./);
    expect(body).toMatch(/\{freeTier\.profiles\} profile/);
    expect(body).toMatch(/\{freeTier\.concurrent\}/);
    // S20b 2026-07-06: "concurrent session ... manual-only via the desktop
    // GUI client" → "session at a time ... driven by hand in our desktop
    // app" — same 20-minute cap, plain words.
    expect(body).toMatch(/session at a time \(up to 20 minutes each\)/);
    expect(body).toMatch(/free tier that never expires/);
  });

  it("Free-tier mechanics framing pinned: 'No usage metering at all' + 'Upgrade to a paid tier when you need the API' — pinned so the no-metering / upgrade-for-API framing survives (drift here would blur the free↔paid boundary)", () => {
    expect(body).toMatch(/No hourly charges and no usage counting/);
    // 2026-09-16 (2nd pass): the upgrade trigger leads with the action instead
    // of holding the verb behind a six-item list, and "a VPN exit" — a term
    // Band A never glossed — became "your own VPN connection". Same free↔paid
    // boundary, same reasons, still a REASON list (Personal has no AI agent and
    // the same 1 session at a time as Free, so "every paid tier adds X" would
    // be false).
    expect(body).toMatch(
      /Move up to a paid tier when you need more\. That could be the\s+API, every device type, or longer sessions\./,
    );
    expect(body).toMatch(
      /Paid tiers also let sessions go out through your own VPN\s+connection, not just a proxy\./,
    );
    expect(body).not.toMatch(/a VPN exit/);
  });

  it('Positioning band pins fixed browser subscription, concurrent capacity and no browser-usage overages', () => {
    // 2026-09-15 plain-words pass — same four facts, no billing internals.
    // 2026-09-16 readability pass — same four facts again, under ONE name for
    // the thing being priced ("sessions at the same time"), with "concurrent
    // sessions" named once as the industry word instead of as the definition.
    expect(body).toMatch(
      /Browser plans are priced by how many sessions you can run at the same time\./,
    );
    expect(body).toMatch(/Use as many hours as you want within that limit\./);
    expect(body).toMatch(/No extra bills for browser usage\./);
    expect(body).toMatch(/Hours, API calls and page visits\s+inside that limit are unlimited/);
    expect(body).toMatch(
      /optional AI agent with\s+Driftstack-supplied AI access \(the "bundled" option\) has its own\s+monthly budget/,
    );
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
      /One person clicking in the desktop app; up to 10 saved profiles\.\s*Run 1 session at a time across 10 different client identities/,
    );
  });

  it("v2 Band-A decision fork pinned: 'who drives the sessions — a person clicking, or code calling?' question + '#manual'/'#api' anchor cards ('A person → Manual.' / 'Code → API.') + the quieter both-workflows card — pinned so the plain-language fork that routes non-technical buyers into the right ladder survives (drift to dropping an anchor card would strand one audience above the wrong ladder)", () => {
    expect(body).toMatch(/who drives the sessions — a person\s*clicking, or code calling\?/);
    expect(body).toMatch(/<a href="#manual" class="card block p-8">/);
    expect(body).toMatch(/<a href="#api" class="card block p-8">/);
    expect(body).toMatch(/A person → Manual\./);
    expect(body).toMatch(/You drive iPhones by hand in the desktop app\./);
    expect(body).toMatch(/Code → API\./);
    expect(body).toMatch(/Your scripts and automated jobs run the sessions\./);
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

  it("ladder terms defined in plain words before the tables use them: 'sessions at the same time' explained ONCE in the positioning band and then carried as the ladder row label itself, plus 'profile is a saved iPhone identity that keeps its logins and history' and BYOK above the ladders — pinned so both ladder column headers stay defined in plain words before the tables use them (the browser-tabs metaphor matches the homepage metering band; drift here would re-jargonize the ladders' load-bearing terms)", () => {
    // 2026-09-16 readability pass. The definition MOVED rather than vanished:
    // 'concurrent' used to be defined twice, in two wordings, and the tables
    // then used a third ('Concurrent sessions'). The page now explains
    // 'sessions at the same time' once, in the positioning band, and the
    // ladders carry that exact phrase as their row label — so this guard
    // follows the definition and additionally pins that the label and the
    // definition are the SAME words, which the old pin could not.
    expect(body).toMatch(/Sessions at the same time<\/strong> is what\s+you pay for\./);
    expect(body).toMatch(/Think of browser tabs you keep open at once\./);
    // 2026-09-16 (2nd pass): the industry term is named, not disowned — the
    // homepage still uses "concurrent sessions" as its own headline metric, so
    // "Other tools call this …" made the two pages contradict each other.
    expect(body).toMatch(/It is also\s+called "concurrent sessions"\./);
    const conc = body.match(/<dt class="text-tk-ink-3">Sessions at the same time<\/dt>/g);
    expect(conc, 'one plain-worded concurrency row label per ladder').toHaveLength(2);
    expect(body).not.toMatch(/<dt class="text-tk-ink-3">Concurrent sessions<\/dt>/);
    // S20b 2026-07-06: the glossary line grew a third term (BYOK) — the
    // profile definition now continues with ", and" instead of a period.
    expect(body).toMatch(
      /profile<\/strong> is a saved iPhone identity\s*that keeps its logins and history/,
    );
    expect(body).toMatch(/BYOK<\/strong> means you bring your own\s*Anthropic key/);
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
      /Saved profiles that keep their logins\. Drive sessions yourself in\s*the desktop app\. No code required\./,
    );
  });

  it("API ladder BYOK explainer pinned: 'bring your own API key from Anthropic for the optional AI agent feature. Your model spend goes to your provider account; Driftstack doesn't markup or proxy.' — pinned so the BYOK-anthropic + no-markup framing survives (drift to claiming markup would invite billing-transparency pushback; drift to dropping anthropic specificity would obscure which provider the BYOK uses)", () => {
    expect(body).toMatch(/<em>bring your own API key<\/em> from Anthropic for the optional AI/);
    // S20b 2026-07-06: no-markup claim in plain words, same commitment.
    expect(body).toMatch(
      /You pay Anthropic directly for the AI usage —\s*Driftstack adds no markup and never sits in the middle\./,
    );
  });

  it("Self-hosted ladder header pinned: 'Self-hosted — for full control' + 'Run the entire stack on your own hardware. No concurrent-session caps from us — your hardware is the cap. Driftstack licenses the software; you add machines whenever you need more capacity.' (S20b plain words) — pinned so the no-license-cap + hardware-is-the-cap unit-economics flip survives (drift to dropping 'No concurrent-session caps from us' would lose THE core self-hosted economic narrative)", () => {
    expect(body).toMatch(/Self-hosted — for full control/);
    expect(body).toMatch(
      // 2026-09-15 plain words — same no-license-cap + hardware-is-the-limit facts.
      /Run Driftstack entirely on your own hardware\. No session limits from\s*us — your hardware sets the limit\. You license the software from\s*Driftstack and add machines whenever you need more capacity\./,
    );
  });

  it('BYOK / Bundled LLM section pins the live included-service budget, Enterprise custom-budget boundary, enablement, self-hosted BYOK-only posture, and an intro that does not offer every plan a choice of who pays for the model', () => {
    // 2026-09-16 (2nd pass) TRUTH re-pin. "BYOK or bundled — your call." and
    // "you choose who pays for the AI behind it: you, or us" promised a choice
    // that only api_builder / api_scale / enterprise have — team_manual,
    // agency_manual and api_starter are llmBilling 'byok_only' in
    // data/pricing.ts, and self-hosted is BYOK-only two paragraphs down.
    expect(body).toMatch(/Who pays for the AI agent\./);
    expect(body).not.toMatch(/BYOK or bundled — your call/);
    expect(body).not.toMatch(/you choose who pays for the AI behind\s+it/);
    expect(body).toMatch(
      /On every plan that has it, you can bring your own\s+Anthropic key and pay Anthropic directly\. On API Builder, API Scale and\s+Enterprise you can instead use AI access Driftstack supplies\./,
    );
    expect(body).toMatch(/Bundled LLM \(API Builder, API Scale, Enterprise\)/);
    // 2026-09-15 plain words: same $0.10-per-agent-turn budget, included in
    // the plan and not billed separately today; enablement via the desktop
    // app or the API; self-hosted stays BYOK-only.
    expect(body).toMatch(
      /each agent turn counts <strong\s*>\$0\.10<\/strong\s*> against a monthly budget you set/,
    );
    expect(body).toMatch(
      /That budget is included in your plan\s*and is not billed separately today\./,
    );
    expect(body).toMatch(/Enterprise can arrange a custom budget/);
    expect(body).toMatch(/Settings → AI &amp; billing/);
    expect(body).toMatch(/, or through the API\./);
    expect(body).not.toMatch(/announced at launch|per-token rate|billed on one invoice/i);
    expect(body).toMatch(/Self-hosted plans are BYOK-only\./);
  });

  it("Mini FAQ teaser 4 questions: 'Manual or API — which one?' + 'Why concurrent caps and not hours?' + 'Can I switch tiers mid-month?' + 'Does the free tier expire?' + 'See full FAQ' → /faq — pinned so the 4-question pricing-FAQ teaser stays complete (drift to dropping the concurrent-caps explainer would lose the why-not-hourly answer; drift to dropping the free-tier answer would orphan free-tier prospects)", () => {
    expect(body).toMatch(/Manual or API — which one\?/);
    // 2026-09-16 (2nd pass) TRUTH re-pin: "at once" was the only word that made
    // the heading true — the page caps simultaneous sessions, not how many you
    // run ("Start as many iPhone Safari sessions as you like, one after
    // another"). The heading now carries the page's unified phrase.
    expect(body).toMatch(/Why limit sessions at the same time, and not hours\?/);
    expect(body).not.toMatch(/Why limit sessions, and not hours\?/);
    expect(body).toMatch(/Can I switch tiers mid-month\?/);
    expect(body).toMatch(/Does the free tier expire\?/);
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See full FAQ<\/a>/);
    expect(body).not.toContain('<a href="/faq" class="btn-secondary">See full FAQ</a>');
  });

  it("VAT framing pinned: 'All prices in USD. Sales tax (VAT — called BTW in the Netherlands) is added where EU rules require it. No setup fees on any tier. Annual contracts billed up front.' (S20b plain words) — pinned so the USD-base + VAT/BTW + no-setup-fee + annual-prepay 4-state commitment survives (drift to dropping VAT/BTW would surprise EU customers at checkout; drift to dropping 'no setup fees' would let prospects assume hidden onboarding charges)", () => {
    expect(body).toMatch(
      /All prices in USD\. Sales tax \(VAT — called BTW in the Netherlands\) is\s*added where EU rules require it\. No setup fees on any tier\. Annual\s*contracts billed up front\./,
    );
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
    // 2026-09-16 (2nd pass) READABILITY re-pin: same facts (no API/SDK, no VPN,
    // one saved proxy that may be SOCKS5 or HTTP, paid plans add the API and
    // OpenVPN/WireGuard), with the mechanism glossed in the sentence that uses
    // it. This bullet sits in the first screenful and used to drop SDK, SOCKS5,
    // HTTP proxy and "exits" on a first-time reader unexplained.
    expect(body).toMatch(
      /no API or SDK access, and no VPN\. Free sessions reach the\s*internet through a connection you supply: one saved proxy,\s*either SOCKS5 or HTTP\. A site then sees that address instead\s*of ours\./,
    );
    expect(body).toMatch(
      /Paid plans add the API, and let you use your own VPN\s*\(OpenVPN or WireGuard\) instead of a proxy\./,
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
    // 2026-09-16 (2nd pass): ONE name for the device dimension. The ladder rows
    // said "Device types" while the prose said "device profile", which collided
    // with the glossary's "profile" (a saved iPhone identity) and made
    // {selectableCount} read like a profile quota beside the "Saved profiles"
    // row. Prose says "device type", the glossary defines it, and the 31-word
    // stacked-aside opener is three short sentences. Bindings unchanged.
    // (Negatives scoped to the RENDERED phrases — the file's doc-comment quotes
    // the retired word to explain why it was retired.)
    expect(body).not.toMatch(/gives you every device profile/);
    expect(body).not.toMatch(/includes every device profile/);
    expect(body).not.toMatch(/Every device profile,/);
    expect(body).toMatch(
      /Every paid tier gives you every device type we offer\. That is 19 iPhone\s*models, from the 13 to the 17 Pro Max/,
    );
    // 2026-09-15 refuter: the catalog is 19 named models, not "every iPhone"
    // released between the endpoints (no SE 3rd gen, 16e or Air).
    expect(body).not.toMatch(/every\s*iPhone from the 13 to the 17 Pro Max/i);
    expect(body).toMatch(
      /\{DEVICE_SUPPORT\.selectableCount\} device\s*types in total\. They run iOS 18, with Safari \{DEVICE_SUPPORT\.safariVersions\}/,
    );
    expect(body).toMatch(
      /device type<\/strong> is one iPhone model,\s*paired with an iOS version and a Safari version\./,
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
    // 2026-09-16 (2nd pass): the free-tier FAQ answer leads with the action and
    // the reasons follow, in the page's one vocabulary.
    expect(body).toMatch(
      /Subscribe to a paid tier from\s+your dashboard when you need more\. That could be the API, every\s+device type, or longer sessions\./,
    );
  });

  it('concurrency is sessions, not people: the Team / Agency teaser cards and the Manual fork card count sessions at once (S31 conflation fix extended)', () => {
    expect(body).not.toMatch(/people clicking at the same time/);
    expect(body).not.toMatch(/people working at once/);
    expect(body).not.toMatch(/how many people can work at once/);
    expect(body).toMatch(
      /3 sessions at the same time; 50 profiles, shared with the\s*teammates you invite\./,
    );
    // 2026-09-16: one phrase for the cap everywhere on the page.
    expect(body).toMatch(/8 sessions at the same time; 200 profiles\./);
    expect(body).toMatch(
      /Tiers differ\s*by how many sessions run at the same time and how many profiles\s*you keep\./,
    );
    expect(body).not.toMatch(/sessions at once;/);
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
      // 2026-09-16 (2nd pass): "exits" is our word — the card body already says
      // proxy / OpenVPN / WireGuard, so the heading says it too.
      'Your own proxy or VPN, tested before launch',
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

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
