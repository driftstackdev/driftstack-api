// W500.C (Homepage v2 2026-07-03 "Plain Words, Same Teeth") — drift guard
// for apps/marketing-site/src/pages/index.astro. The homepage was rebuilt
// from ~22 sections to 13, adopting the shared Fleet v2 component kit
// (Section/Card/Stat/FeatureRow/CodeWindow/CtaBand) and binding all tier
// figures to src/data/pricing.ts (W292.B — no hand-typed dollars). Three
// altitude bands: A (plain language, hero→use cases), B (big plain line +
// small mono technical line), C (// for developers). This guard pins the
// load-bearing claims that survived the rebuild.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W500.C apps/marketing-site/src/pages/index.astro content parity', () => {
  const body = read(LIB);

  it("W452 noob-friendly SEO description — plain-language outcome (a real iPhone browser every site sees as genuine, never a bot) + access paths, jargon stripped (no 'pixel-identical / bit-identical canvas/WebGL/audio'). Title='Driftstack'.", () => {
    expect(body).toMatch(/<BaseLayout\s*title="Driftstack"/);
    expect(body).toMatch(
      /description="A real iPhone browser in the cloud that every website sees as a genuine iPhone — never a bot\. Automate iPhone Safari from TypeScript, Python, Go, or a desktop app\. Start free\."/,
    );
    // Jargon-heavy SEO framing must not return.
    expect(body).not.toMatch(/Pixel-identical iPhone Safari sessions in the cloud\. Bit-identical/);
  });

  it('Developer band ("// for developers") W452 noob-friendly rewrite — plain-language, benefit-led, jargon stripped (Canvas/WebGL-hash + Chromium-stealth-API removed). Two-line title: "Real iPhone Safari." + "Programmable from any language." (2026-09-16: "Indistinguishable iPhone Safari." retired — a blanket identity claim the fingerprint engineer asked us not to make; evidence is per surface). Lead sentence opens with the outcome (every site sees a genuine iPhone, never a bot/emulator) + use-cases (scraping/testing/automation) + the four access paths (desktop app, not "GUI").', () => {
    expect(body).toMatch(/title="Real iPhone Safari\. Programmable from any language\."/);
    expect(body).toMatch(/Programmable from any language\./);
    // The retired blanket claim must NOT return as the band title.
    expect(body).not.toMatch(/Indistinguishable iPhone Safari\./);
    expect(body).toMatch(/Run a real iPhone browser in the cloud that every website treats as/);
    expect(body).toMatch(/a genuine iPhone — never a bot, never an emulator\. Built for/);
    expect(body).toMatch(/scraping, testing, and automation that has to pass as a real mobile/);
    expect(body).toMatch(/user\. Drive it from TypeScript, Python, Go, or the desktop app\./);
    // Jargon-heavy + pre-rewrite framings must not return.
    expect(body).not.toMatch(/Canvas \+ WebGL\s*hashes match the millions/);
    expect(body).not.toMatch(/unique-per-session leak every Chromium-stealth API surfaces/);
    expect(body).not.toMatch(/Pixel-identical iPhone Safari\. Cloud-hosted\. API, SDK, or GUI\./);
    expect(body).not.toMatch(/Other API browsers patch JavaScript at runtime/);
  });

  it('W456 — plain-language "How it works in 3 steps" section (noob-friendly explainer placed early): "How it works" label + "Three steps to a real iPhone in the cloud." h2 + three step headings (Pick an iPhone profile / Start a session / Drive it your way). Pinned so the non-technical explainer stays.', () => {
    expect(body).toMatch(/Three steps to a real iPhone in the cloud\./);
    expect(body).toMatch(/Pick an iPhone profile/);
    expect(body).toMatch(/Start a session/);
    expect(body).toMatch(/Drive it your way/);
    // 2026-09-16 RE-PIN (truth): card 1 promises PERSISTENCE, never session
    // RESUMPTION. A profile keeps cookies, local storage, IndexedDB and the
    // fingerprint between sessions (docs guides/profile-management); nothing
    // in packages/api-types profiles.ts stores open pages, tabs or a last
    // URL. "so the next session carries on where the last one stopped" made
    // a beginner expect their previous page back.
    expect(body).toMatch(
      /A profile remembers\s+its logins, cookies and history, so the next session is still signed\s+in\./,
    );
    expect(body).not.toMatch(/carries on where\s+the last one stopped/);
  });

  it('M.3 + M.6 — "One iPhone among millions." giant-headline framing (M.3 Plan Item 5 dedupe took "Indistinguishable" down to once; 2026-09-16 the last use — the developer-band title — was retired too, so the word now appears ZERO times on the page; M.6 Path A: multi-archetype family — iPhone 15 Pro / 16 Pro / 17 lineup, iOS 18.7 / Safari 26.4-26.5 per founder verdict 2026-05-17) + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/One iPhone among millions\./);
    // M.6 Path A: multi-archetype family + Safari 26.5 span.
    // 2026-09-15: the device sentence is bound to DEVICE_SUPPORT (19 models,
    // 96 profiles, Safari 18.4–26.6) instead of hand-naming three models.
    expect(body).toMatch(/\{DEVICE_SUPPORT\.deviceFamilies\}/);
    expect(body).toMatch(/\{DEVICE_SUPPORT\.selectableCount\}/);
    expect(body).toMatch(/\{DEVICE_SUPPORT\.safariVersions\}/);
    expect(body).toMatch(/iPhone 17 on iOS 18\.7 \/ Safari 26\.4/);
    expect(body).toMatch(/Nothing bolted on top/);
    // Prior wording must NOT return — covers both M.3 (Indistinguishable
    // duplicate) and M.6 (single-archetype reference) regressions.
    expect(body).not.toMatch(
      /<span class="bg-gradient-to-br[^>]+>\s*Indistinguishable from a real iPhone\./,
    );
    // 2026-09-16: ZERO occurrences, any case. "Indistinguishable" is a
    // blanket identity claim the fingerprint engineer asked us not to make
    // (evidence is per surface), so no slot on the page may carry it.
    expect(body).not.toMatch(/indistinguishable/i);
    expect(body).not.toMatch(/Reference device: iPhone 16 Pro, iOS 18\.7, Safari 26\.4\./);
  });

  it('Stack framing inside the v2 proof section: "Apple\'s engine. Not a Chromium copy." + the "WebKit, Core Text, and the iOS rendering pipeline" capability sentence. The Chromium-fork/Playwright-patch competitor contrast now lives on /comparison (linked from this section).', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    // S20b 2026-07-06 plain-language pass: Core Text + the pipeline are now
    // glossed inline; the same capability sentence survives with glosses.
    expect(body).toMatch(/Driftstack runs its own build of Apple's WebKit, from Apple's\s*source/);
    expect(body).toMatch(
      /are drawn the way an iPhone draws them,\s*checked against real devices\./,
    );
    expect(body).toMatch(/href="\/comparison\/"/);
  });

  it("Hero CTAs + free-tier subline (R5: 'Start free' → /pricing/#free + M.3 Plan Item 2 'Compare the alternatives' generic CTA — replaces 'Why not Browserless?' which gave free SEO to a competitor and read defensive). The 2026-05-19 polish stripped the mobile-responsive w-full sm:w-auto wrappers since the hero already uses flex-wrap; the buttons relax to their natural width on small screens via the parent container.", () => {
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary">Start free<\/a>/);
    // v2 2026-07-03: the hero secondary CTA anchors to the in-page
    // how-it-works section (the /comparison deep link moved into the proof
    // section as the tool-by-tool "comparison page" link).
    expect(body).toMatch(/<a href="#how-it-works" class="btn-secondary">See how it works<\/a>/);
    expect(body).toMatch(/One profile · 20-minute sessions · no card required\./);
    // The defensive "Why not Browserless?" CTA must NOT return.
    expect(body).not.toMatch(/Why not Browserless\?/);
  });

  it("Code example contract — REAL SDK usage. The previous pin asserted a fictional API (proxy in CreateSessionRequest + session.waitForChallenge / instance-method form) which doesn't exist; customers landing on the front door would copy code that doesn't compile. Now pins the actual resource-method pattern matching the TS quickstart: client.sessions.create({ label }) + sessions.navigate(id, ...) + sessions.capture(id, { kind }) + sessions.getState(id) + sessions.destroy(id). NO proxy field (egress is shipped as 503-stub per the egress card contradiction).", () => {
    expect(body).toMatch(/archetype: 'iphone17_ios18_7_safari26_4',/);
    expect(body).toMatch(/label: 'target-flow',/);
    // Real resource-method pattern: ds.sessions.<method>(session.id, ...).
    expect(body).toMatch(
      /await ds\.sessions\.navigate\(session\.id, \{ url: 'https:\/\/target\.example' \}\);/,
    );
    expect(body).toMatch(/await ds\.sessions\.capture\(session\.id, \{ kind: 'screenshot' \}\);/);
    expect(body).toMatch(/const state = await ds\.sessions\.getState\(session\.id\);/);
    expect(body).toMatch(/await ds\.sessions\.destroy\(session\.id\);/);
    // The fictional shapes must not return.
    expect(body).not.toMatch(/proxy: \{ type: 'wireguard'/);
    expect(body).not.toMatch(/session\.waitForChallenge\(\)/);
    expect(body).not.toMatch(/session\.navigate\(\{ url:/);
  });

  it('Concurrent metering framing pinned (v2 trust band): "One metric. Concurrent sessions. That\'s it." headline + no-per-call-markup / no-per-element-fees callouts + 200-pages-on-one-session concrete example', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No per-call markup\. No\s*per-element fees\./);
    expect(body).toMatch(/Visit 200 pages on one\s*session for the cost of\s*visiting one\./);
  });

  it('EU compliance pinned (v2 trust band): "EU-hosted by default." + plain-English body ("Your account data lives on EU servers. We don\'t log what your sessions visit or do — only the operational metadata we need to bill (session duration, archetype, cap usage)") + the live/roadmap egress framing cross-links /trust/security-overview. S30 2026-07-07 (founder decision: soften): supersedes "EU-only by default." / "Your data stays in the EU." — file objects live on Cloudflare R2 default jurisdiction (EU + US replication), so only DB-resident account data is EU-guaranteed.', () => {
    expect(body).toMatch(/EU-hosted by default\./);
    expect(body).toMatch(/Your account data lives on EU servers\./);
    expect(body).toMatch(/only what we need to bill you/);
    // S20b 2026-07-06: the billing-metadata triple reads in plain words
    // (duration / archetype glossed via the glossary link / cap usage).
    expect(body).toMatch(
      /how long a session ran, which\s*iPhone model, iOS and Safari version it used/,
    );
    expect(body).toMatch(/how many sessions\s*you had running at once/);
    expect(body).toMatch(
      /route each profile's traffic through your own SOCKS5\s*proxy, OpenVPN, or WireGuard connection today/,
    );
    expect(body).toMatch(/href="\/trust\/security-overview\/"/);
    // Prior framings must NOT return at this slot.
    expect(body).not.toMatch(/Customer data stays in the EU\./);
    expect(body).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s*single-region\./,
    );
    expect(body).not.toMatch(/We log session metadata only/);
    expect(body).not.toMatch(/Hetzner\s*Falkenstein, Neon EU, and Cloudflare R2/);
    // S30 negative pins — the absolutist residency claims must not
    // silently return (founder decision 2026-07-07: soften).
    expect(body).not.toMatch(/EU-only by default/);
    expect(body).not.toMatch(/Your data stays in the EU/);
  });

  it('Manual ladder framing BOUND from pricing.ts (W292.B — no hand-typed dollars): {manualLineup} + {manualCaps} concurrent + unlimited hours within cap. The $79/$249/$699 values are guarded by pricing-manual-tier-figures-baseline.', () => {
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/data\/pricing'/);
    expect(body).toMatch(/const manualLineup = manualLadder/);
    expect(body).toMatch(/\{manualLineup\}/);
    expect(body).toMatch(/\{manualCaps\} concurrent sessions per tier/);
    expect(body).toMatch(/Unlimited hours within your concurrent cap/);
    expect(body).not.toMatch(/Personal \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
  });

  // S26 2026-07-06 (#132) — re-pinned: the old wording's trailing
  // "(API Builder and up)" misread as BYOK-gated-to-Builder, but per
  // packages/api-types/src/common.ts TIER_FEATURES every API tier has
  // the AI agent with BYOK (api_starter: llmBilling 'byok_only');
  // only the bundled option starts at api_builder
  // ('byok_or_bundled').
  it('API ladder framing BOUND from pricing.ts (W292.B): {apiLineup} + {apiCaps} concurrent; Enterprise custom + BYOK on every API tier with bundled AI on Builder+. The $149/$499/$1,499 values are guarded by pricing-api-tier-figures-baseline.', () => {
    expect(body).toMatch(/const apiLineup = apiLadder/);
    expect(body).toMatch(/\{apiLineup\}/);
    expect(body).toMatch(/\{apiCaps\} concurrent sessions per tier; Enterprise custom/);
    expect(body).toMatch(
      /AI assistant on every API tier — connect your own Anthropic key and pay Anthropic directly, no Driftstack markup; an optional bundled assistant \(no key needed\) comes with API Builder and up/,
    );
    expect(body).not.toMatch(/API Starter \$149\/mo · Builder \$499\/mo · Scale \$1,499\/mo/);
  });

  it("Pricing teaser: 'Two ladders. A free tier to start.' + 20% annual savings", () => {
    expect(body).toMatch(/Two plan families\. A free tier to start\./);
    expect(body).toMatch(/Annual contracts save 20%\./);
    // 2026-09-16: the pricing LEAD offers the choice; it does not stop to
    // TEACH the internal label. "We call the two kinds plan families —" did
    // no work in the sentence (which reads identically without it) and the
    // mandate was to remove terms a first-time visitor has to decode, not to
    // introduce one and define it. The label still stands, unexplained and
    // self-evident from its own clause, in the teaser line above.
    expect(body).toMatch(
      /Then pick the kind of plan that fits how you work — Manual if a person drives the sessions, API if your code does\./,
    );
    expect(body).not.toMatch(/We call the two kinds plan families/);
  });

  it('Self-hosted teaser pinned (v2 compact band): "Run Driftstack on your own infrastructure." + /self-hosted link', () => {
    expect(body).toMatch(/Run Driftstack on your own infrastructure\./);
    expect(body).toMatch(/href="\/self-hosted\/"/);
  });

  it('use-case section pinned (v2 Band-A personas, operators first): "Built for the work you actually do." headline + 3 persona cards (Run many accounts, safely apart / Test on the real thing / See what iPhone users see)', () => {
    expect(body).toMatch(/Built for the work you actually do\./);
    expect(body).toMatch(/Run many accounts, safely apart/);
    expect(body).toMatch(/Test on the real thing/);
    expect(body).toMatch(/See what iPhone users see/);
  });

  it('final-CTA pinned (v2 CtaBand component): "See it for yourself. Free." + "Read the docs" secondary CTA → docs.driftstack.io', () => {
    expect(body).toMatch(/See it for yourself\. Free\./);
    expect(body).toMatch(/secondaryLabel="Read the docs"/);
    expect(body).toMatch(/secondaryHref="https:\/\/docs\.driftstack\.io"/);
  });

  // 2026-09-11 — the hero visual is a REAL capture of the desktop app (the
  // owner: "update our marketing website too with these latest views, as it
  // still has old GUI images"). The hand-drawn fan of iPhone windows it
  // replaces (S4.5 2026-07-03) had drifted from the app.
  //
  // 2026-09-21 — "Bringing The Stage everywhere" §4/§7: the hero capture
  // changed AGAIN, from the profiles grid to the AI view mid-task (scene
  // `ai-running`, cropped to `ai-running-hero.png`) — the real, lit iPhone a
  // prospect actually remembers. Headline, intro paragraph and CTAs are
  // UNCHANGED copy (only the image + its alt changed); the profiles-grid
  // capture and its own caption strip moved to §2, verbatim, as their own
  // arm below — not deleted, not rewritten.
  // What each arm guards, and why reverting the production line reds it:
  //   • `import heroScreen from '../assets/screens/ai-running-hero.png'` +
  //     `<AppScreen src={heroScreen}` — the hero draws the capture; a return
  //     to markup (or a different scene) fails here.
  //   • `priority` on the hero AppScreen — it is the LCP element; dropping the
  //     prop makes it lazy (the component's default) and the pin reds.
  //   • `alt={HERO_ALT}` + the constant's content — a real alt that says what
  //     the screen shows (the AI mid-task, the plan beside it, WHAT not HOW —
  //     no fleet/node/harness/vendor words). A bare alt="" or a slogan fails.
  //   • The fan markup must NOT return (heroFleet / New Tab / market.example).
  it("Hero AI-view visual pinned: 'Your own real iPhones, in the cloud.' + identity/history/geo triad + 'just people on phones' close (unchanged copy) + the REAL ai-running capture (AppScreen, priority/LCP, real alt) — the hand-drawn fan and the old profiles-grid hero are gone from this slot", () => {
    expect(body).toMatch(/Your own real iPhones, in the cloud\./);
    // 2026-09-16 Band-A readability pass — the identity/history/geo triad
    // survives, in words a first-time visitor can act on: "its own corner
    // of the world" named no thing the reader gets, and the 27-word
    // sentence carrying the triad is now two. The close is untouched.
    expect(body).toMatch(
      /Each one keeps its own\s*logins, its own history, and its own location\./,
    );
    expect(body).not.toMatch(/its own corner of the world/);
    expect(body).toMatch(/they're just\s*people on phones\./);
    // "by hand, by code, or by AI" — unchanged, and now literally what the
    // hero image beside it shows.
    expect(body).toMatch(/Drive them by hand,\s*by code, or by AI\./);
    // the capture, wired through AppScreen as the LCP element
    expect(body).toMatch(/import AppScreen from '\.\.\/components\/AppScreen\.astro'/);
    expect(body).toMatch(/import heroScreen from '\.\.\/assets\/screens\/ai-running-hero\.png'/);
    expect(body).toMatch(
      /<AppScreen\s+src=\{heroScreen\}\s+alt=\{HERO_ALT\}\s+priority\s+accent\s+sizes="\(min-width: 768px\) 552px, calc\(100vw - 48px\)"\s*\/>/,
    );
    // a real alt: WHAT the screen shows (Band A / WHAT-not-HOW) — the AI
    // mid-task, a real iPhone, the plan beside it; never infrastructure
    // words (fleet/node/harness/control plane/observer/vantage) or "device
    // internals", never "undetectable", no personal names.
    expect(body).toMatch(
      /const HERO_ALT =\s*\n\s*'The Driftstack desktop app, AI Browser Automation view: the AI running a ' \+\s*\n\s*'task on a real iPhone, lit up mid-task, with the six steps it planned ' \+\s*\n\s*'beside it/,
    );
    // Scoped to the alt text itself, not the whole page — the file's own
    // header comments say "Fleet homepage" freely, which is not the hazard
    // this pin exists to catch (a device-internals word IN THE ALT TEXT a
    // screen reader speaks).
    const heroAltDecl = body.match(/const HERO_ALT =[\s\S]*?';/)?.[0];
    expect(heroAltDecl, 'the HERO_ALT declaration').toBeDefined();
    expect(heroAltDecl).not.toMatch(/fleet|harness|control plane|observer|vantage/i);
    expect(heroAltDecl).not.toMatch(/undetectable/i);
    // the old hero's own caption strip must not be reachable from this slot
    // any more — it moved to §2 with the picture it describes (own arm below).
    const heroDiv = body.match(
      /<div class="relative animate-fade-up">\s*<AppScreen[\s\S]*?<\/div>/,
    )?.[0];
    expect(heroDiv, 'the hero AppScreen wrapper div').toBeDefined();
    expect(heroDiv).not.toMatch(/8 iPhone profiles/);
    expect(heroDiv).not.toMatch(/🇳🇱 Amsterdam/);
    // the hand-drawn fan and its claims must not return
    expect(body).not.toMatch(/heroFleet/);
    expect(body).not.toMatch(/market\.example\.com/);
    expect(body).not.toMatch(/New Tab/);
    expect(body).not.toMatch(/4 iPhones<\/b> in your fleet/);
    expect(body).not.toMatch(/all <b class="text-tk-ready-text">healthy<\/b>/);
    expect(body).not.toMatch(
      /<div class="flex items-end justify-center pt-2" data-contrast-decorative>/,
    );
    // the pre-v2 technical telemetry line must not return above the fold
    expect(body).not.toMatch(/fingerprint coherence <b/);
    expect(body).not.toMatch(/CreepJS/);
  });

  // 2026-09-21 — the profiles-grid capture the hero used to show, relocated
  // (image + its own Band-A caption strip, byte-for-byte the same copy) to §2
  // "What is Driftstack?", whose own claim ("each iPhone can browse from the
  // country you choose") is what the caption already describes. Not deleted,
  // not rewritten — moved, per the rule that a capture whose section's copy
  // refers to it stays on the page.
  it('relocated fleet visual pinned: the profiles-grid capture + its unchanged caption strip now live in §2, no longer in the hero, and carry no `priority`/`accent` there', () => {
    expect(body).toMatch(
      /import fleetScreen from '\.\.\/assets\/screens\/profiles-grid-hero\.png'/,
    );
    expect(body).toMatch(
      /const FLEET_ALT =\s*\n\s*'The Driftstack desktop app, Profiles view: eight iPhone profile cards/,
    );
    expect(body).toMatch(
      /whether it is Live ' \+\s*\n\s*'or Idle, the city it browses from \(Amsterdam, Tokyo, Zurich, Berlin, London, ' \+\s*\n\s*'Paris\)/,
    );
    expect(body).toMatch(/<AppScreen src=\{fleetScreen\} alt=\{FLEET_ALT\} \/>/);
    // the caption strip — real copy, unchanged, matches the picture
    expect(body).toMatch(
      /🇳🇱 Amsterdam · 🇯🇵 Tokyo · 🇩🇪 Berlin · 🇬🇧 London · 🇫🇷 Paris — each on its own connection/,
    );
    expect(body).toMatch(/<b class="text-tk-ready-text">8 iPhone profiles<\/b>, ready to launch/);
    expect(body).toMatch(/each with <b class="text-tk-ink-2">its own identity<\/b>/);
    expect(body).toMatch(/each on <b class="text-tk-ready-text">its own connection<\/b>/);
    // it sits in §2, not wired as the LCP hero any more
    expect(body).not.toMatch(/<AppScreen src=\{fleetScreen\}[^>]*\bpriority\b/);
    expect(body).not.toMatch(/<AppScreen src=\{fleetScreen\}[^>]*\baccent\b/);
  });

  // 2026-09-21 — §5 "Two ways to drive it" already told a prospect, in
  // unchanged copy, that "the built-in AI agent does it while you watch" —
  // until now nothing on the page showed it. The AI-running capture (full
  // frame, not the hero's crop) sits right under that sentence.
  it('§5 AI-agent claim now has a real capture beside it: the ai-running scene, not `accent` (reserved for the hero)', () => {
    expect(body).toMatch(/The built-in AI agent does it while you watch\./);
    expect(body).toMatch(/import aiRunningScreen from '\.\.\/assets\/screens\/ai-running\.png'/);
    expect(body).toMatch(
      /const AI_RUNNING_ALT =\s*\n\s*'The Driftstack desktop app, AI Browser Automation view, mid-task/,
    );
    expect(body).toMatch(/<AppScreen src=\{aiRunningScreen\} alt=\{AI_RUNNING_ALT\} \/>/);
    expect(body).not.toMatch(/<AppScreen src=\{aiRunningScreen\}[^>]*\baccent\b/);
    expect(body).not.toMatch(/<AppScreen src=\{aiRunningScreen\}[^>]*\bpriority\b/);
  });

  // 2026-09-11 — the other GUI depictions on the page are captures too.
  //   • §5 "Two ways to drive it": the floating device window is the REAL
  //     simulator window (scene `simulator`), full width, lazy (the
  //     component default — the pin asserts NO `priority` here, because a
  //     second eager+high image would compete with the hero for bandwidth).
  //   • §9 console rows: the Identity Wardrobe shows the Profiles LIST view
  //     (scene `profiles-list`), the egress row the Proxies view (scene
  //     `proxies`) — each through the FeatureRow media slot.
  //   • The hand-drawn cockpit (cockpitProfiles, "98% proxy health", the
  //     floating shop.example.com window), the tilted wardrobe cards
  //     (jp-market / us-retail-qa) and the dotted-globe SVG must not return.
  it('§5 + §9 GUI depictions are real captures: simulator window (lazy, not priority), profiles-list + proxies via the FeatureRow media slot — the hand-drawn cockpit / wardrobe cards / globe SVG are gone', () => {
    expect(body).toMatch(/import simulatorScreen from '\.\.\/assets\/screens\/simulator\.png'/);
    expect(body).toMatch(
      /import profilesListScreen from '\.\.\/assets\/screens\/profiles-list\.png'/,
    );
    expect(body).toMatch(/import proxiesScreen from '\.\.\/assets\/screens\/proxies\.png'/);
    expect(body).toMatch(/<AppScreen src=\{simulatorScreen\} alt=\{SIMULATOR_ALT\} \/>/);
    expect(body).toMatch(
      /<AppScreen\s+slot="media"\s+src=\{profilesListScreen\}\s+alt=\{PROFILES_LIST_ALT\}/,
    );
    expect(body).toMatch(/<AppScreen\s+slot="media"\s+src=\{proxiesScreen\}\s+alt=\{PROXIES_ALT\}/);
    // every alt says what the screen shows
    expect(body).toMatch(
      /const SIMULATOR_ALT =\s*\n\s*'A floating device window in the Driftstack desktop app/,
    );
    expect(body).toMatch(
      /const PROFILES_LIST_ALT =\s*\n\s*'The Driftstack desktop app, Profiles view as a list/,
    );
    expect(body).toMatch(/const PROXIES_ALT =\s*\n\s*'The Driftstack desktop app, Proxies view/);
    // exactly ONE priority image on the page — the hero
    expect(body.match(/\bpriority\b/g)?.length, 'priority props on the page').toBe(1);
    // the hand-drawn depictions must not return
    expect(body).not.toMatch(/cockpitProfiles/);
    expect(body).not.toMatch(/98% proxy health/);
    expect(body).not.toMatch(/shop\.example\.com/);
    expect(body).not.toMatch(/jp-market|us-retail-qa|amsterdam-shopper/);
    expect(body).not.toMatch(/stroke-dasharray="4 4"/);
  });

  it("Proof section costume metaphor + detection matrix (v2 merge of the former comparison teaser + why-works + how-its-built): 'One iPhone among millions.' + the costume-metaphor lead + the 7-signal 'What detection systems see' matrix + /comparison cross-link. The standalone 'Not another anti-detect browser.' teaser table was folded in here.", () => {
    expect(body).toMatch(/One iPhone among millions\./);
    expect(body).toMatch(/Most tools dress up a desktop browser to look like a phone/);
    expect(body).toMatch(/What websites see/);
    expect(body).toMatch(/Same signals as a physical iPhone\. Not "close enough"\./);
    expect(body).toMatch(/href="\/comparison\/"/);
    // the retired standalone teaser table headline must not return
    expect(body).not.toMatch(/Not another anti-detect browser\./);
    // 2026-09-16 RE-PIN (truth consistency): the first proof card's eyebrow
    // read "Pixel-exact" — an unscoped blanket identity claim of exactly the
    // retired family, sitting as the STRONGEST claim on a card whose own body
    // scopes to "checked against real iPhones, check by check" (the scoping
    // rule the 2026-09-15 truth pass recorded: 81 of 96 device profiles
    // byte-identical, not a blanket identity). The eyebrow now says only what
    // the body under it supports.
    expect(body).toMatch(/>Measured, not guessed<\/p>/);
    expect(body).not.toMatch(/Pixel-exact/);
  });

  it("Human-by-design behavioural section pinned (v2 headline 'It even moves like a person.'): the bots-move-in-straight-lines lead + touch/scroll + typing-rhythm + same-person-each-time cards — all backed by packages/behavioural-simulation (prod-wired). 2026-09-16 Band-A readability pass: same three cards, same facts (motion is available per profile), in plain words — 'momentum flicks' / 'per-character rhythm with variance' / 'motion signature' were the mechanism's names, not the reader's.", () => {
    expect(body).toMatch(/It even moves like a person\./);
    expect(body).toMatch(/Bots move in straight lines at a constant speed\./);
    // 2026-09-16 RE-PIN (truth): the readability pass briefly turned the
    // availability statement into an INSTRUCTION — "Switch human-like motion
    // on for a profile" — which tells a first-time visitor there is a
    // per-profile on/off control and that motion is OFF until they find it.
    // Neither is true: `behavioral_profile` is an optional per-SESSION persona
    // on CreateSessionRequest (casual/regular/power_user, no "off" value) and
    // the service defaults it (services/sessions.ts: `?? DEFAULT_BEHAVIORAL_
    // PROFILE`); profiles.ts carries no behavioural field and the desktop app
    // exposes no switch. The app's own Behavior tab is the wording of record:
    // "On by default for every session this profile launches." The lead now
    // states availability + default, still scoped per profile.
    expect(body).toMatch(/on by default for every session a profile launches/);
    // the non-existent per-profile control must not come back
    expect(body).not.toMatch(/Switch human-like motion on/);
    expect(body).toMatch(
      /Flicks that carry momentum, and touches that don't all last exactly\s*the same time\./,
    );
    expect(body).toMatch(/the path your finger\s*traces curves the way a real one does/);
    expect(body).toMatch(/Letters arrive one at a time, with the small pauses and uneven speed/);
    expect(body).toMatch(/keeps the same way of moving from one session to the\s*next/);
    // the mechanism-named phrasings must not return to Band A
    expect(body).not.toMatch(/Momentum flicks, natural variation/);
    expect(body).not.toMatch(/Per-character rhythm/);
    expect(body).not.toMatch(/motion signature/);
  });

  it("Console section pins only current product surfaces: live Identity Wardrobe and live 'Exit anywhere. Leak nowhere.' egress", () => {
    expect(body).toMatch(/Your iPhones, kept in order\./);
    expect(body).toMatch(/title="Each profile is its own iPhone" chip="live"/);
    expect(body).toMatch(/Exit anywhere\. Know what gets through\./);
    // 2026-09-16 RE-PIN (Band-A readability). Row 1 opened with a 26-word
    // DEFINITION and a six-item parts list, so the reader met the parts
    // before the point; it now leads with the payoff. Row 2 glossed the two
    // acronyms a visitor is least likely to meet (WebRTC, HTTP/3) and left
    // SOCKS5 — the term in that list that means nothing without one — bare;
    // it is now glossed like its neighbours.
    expect(body).toMatch(/Come back to a profile next month and websites see the same phone\./);
    expect(body).toMatch(/a SOCKS5 proxy \(a\s+relay your traffic passes through\)/);
    expect(body).not.toMatch(/A profile is a whole iPhone of its own/);
    expect(body).not.toMatch(/title="Session Replay"/);
    expect(body).not.toMatch(/title="Warm-up Scheduler"/);
    expect(body).not.toMatch(/chip="roadmap"|chip="rolling-out"/);
    // the trust-center console row folded into the trust band (§10);
    // "Sealed by architecture" is no longer a console row.
    expect(body).not.toMatch(/Run identities like infrastructure\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
