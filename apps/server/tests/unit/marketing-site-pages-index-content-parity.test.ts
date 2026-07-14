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
    expect(body).toMatch(/<BaseLayout\s*\n?\s*title="Driftstack"/);
    expect(body).toMatch(
      /description="A real iPhone browser in the cloud that every website sees as a genuine iPhone — never a bot\. Automate iPhone Safari from TypeScript, Python, Go, or a desktop app\. Start free\."/,
    );
    // Jargon-heavy SEO framing must not return.
    expect(body).not.toMatch(/Pixel-identical iPhone Safari sessions in the cloud\. Bit-identical/);
  });

  it('Hero copy W452 noob-friendly rewrite — plain-language, benefit-led, jargon stripped (Canvas/WebGL-hash + Chromium-stealth-API removed). Two-line H1 kept: "Indistinguishable iPhone Safari." (gradient span) + "Programmable from any language." Sub-paragraph leads with the outcome (every site sees a genuine iPhone, never a bot/emulator) + use-cases (scraping/testing/automation) + the four access paths (desktop app, not "GUI").', () => {
    expect(body).toMatch(/Indistinguishable iPhone Safari\./);
    expect(body).toMatch(/Programmable from any language\./);
    expect(body).toMatch(/Run a real iPhone browser in the cloud that every website treats as/);
    expect(body).toMatch(/a genuine iPhone — never a bot, never an emulator\. Built for/);
    expect(body).toMatch(/scraping, testing, and automation that has to pass as a real mobile/);
    expect(body).toMatch(/user\. Drive it from TypeScript, Python, Go, or the desktop app\./);
    // Jargon-heavy + pre-rewrite framings must not return.
    expect(body).not.toMatch(/Canvas \+ WebGL\s*\n?\s*hashes match the millions/);
    expect(body).not.toMatch(/unique-per-session leak every Chromium-stealth API surfaces/);
    expect(body).not.toMatch(/Pixel-identical iPhone Safari\. Cloud-hosted\. API, SDK, or GUI\./);
    expect(body).not.toMatch(/Other API browsers patch JavaScript at runtime/);
  });

  it('W456 — plain-language "How it works in 3 steps" section (noob-friendly explainer placed early): "How it works" label + "Three steps to a real iPhone in the cloud." h2 + three step headings (Pick an iPhone profile / Start a session / Drive it your way). Pinned so the non-technical explainer stays.', () => {
    expect(body).toMatch(/Three steps to a real iPhone in the cloud\./);
    expect(body).toMatch(/Pick an iPhone profile/);
    expect(body).toMatch(/Start a session/);
    expect(body).toMatch(/Drive it your way/);
  });

  it('M.3 + M.6 — "One iPhone among millions." giant-headline framing (M.3 Plan Item 5 dedupe: "Indistinguishable" now appears once on the page in the hero h1 brand line; M.6 Path A: multi-archetype family — iPhone 15 Pro / 16 Pro / 17 lineup, iOS 18.7 / Safari 26.4-26.5 per founder verdict 2026-05-17) + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/One iPhone among millions\./);
    // M.6 Path A: multi-archetype family + Safari 26.5 span.
    expect(body).toMatch(/iPhone\s*\n?\s*15 Pro/);
    expect(body).toMatch(/iPhone 16 Pro/);
    expect(body).toMatch(/iPhone 17 lineup/);
    expect(body).toMatch(/iOS 18\.7\s*\n?\s*\/ Safari 26\.4/);
    expect(body).toMatch(/Safari 26\.5/);
    expect(body).toMatch(/launch-blocking bug/);
    // Prior wording must NOT return — covers both M.3 (Indistinguishable
    // duplicate) and M.6 (single-archetype reference) regressions.
    expect(body).not.toMatch(
      /<span class="bg-gradient-to-br[^>]+>\s*\n?\s*Indistinguishable from a real iPhone\./,
    );
    expect(body).not.toMatch(/Reference device: iPhone 16 Pro, iOS 18\.7, Safari 26\.4\./);
  });

  it('Stack framing inside the v2 proof section: "Apple\'s engine. Not a Chromium copy." + the "WebKit, Core Text, and the iOS rendering pipeline" capability sentence. The Chromium-fork/Playwright-patch competitor contrast now lives on /comparison (linked from this section).', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    // S20b 2026-07-06 plain-language pass: Core Text + the pipeline are now
    // glossed inline; the same capability sentence survives with glosses.
    expect(body).toMatch(
      /WebKit \(the browser engine\),\s*\n?\s*Core Text \(Apple's text-drawing system\)/,
    );
    expect(body).toMatch(
      /rendering pipeline produce your fingerprint the way Apple wrote\s*\n?\s*them, in the order Apple intended\./,
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
    expect(body).toMatch(/No per-call markup\. No\s*\n?\s*per-element fees\./);
    expect(body).toMatch(/Visit 200 pages on one session for the cost of\s*\n?\s*visiting one\./);
  });

  it('EU compliance pinned (v2 trust band): "EU-hosted by default." + plain-English body ("Your account data lives on EU servers. We don\'t log what your sessions visit or do — only the operational metadata we need to bill (session duration, archetype, cap usage)") + the live/roadmap egress framing cross-links /trust/security-overview. S30 2026-07-07 (founder decision: soften): supersedes "EU-only by default." / "Your data stays in the EU." — file objects live on Cloudflare R2 default jurisdiction (EU + US replication), so only DB-resident account data is EU-guaranteed.', () => {
    expect(body).toMatch(/EU-hosted by default\./);
    expect(body).toMatch(/Your account data lives on EU servers\./);
    expect(body).toMatch(/only the operational metadata we need to bill/);
    // S20b 2026-07-06: the billing-metadata triple reads in plain words
    // (duration / archetype glossed via the glossary link / cap usage).
    expect(body).toMatch(
      /how long a\s*\n?\s*session ran, which iPhone model \+ iOS \+ Safari combination it used/,
    );
    expect(body).toMatch(/how much of your concurrent cap it used/);
    expect(body).toMatch(
      /Customer-configurable egress — attaching your own internet exit \(a\s*\n?\s*SOCKS5 proxy, OpenVPN, or WireGuard\) to each profile — is live/,
    );
    expect(body).toMatch(/href="\/trust\/security-overview\/"/);
    // Prior framings must NOT return at this slot.
    expect(body).not.toMatch(/Customer data stays in the EU\./);
    expect(body).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s*\n?\s*single-region\./,
    );
    expect(body).not.toMatch(/We log session metadata only/);
    expect(body).not.toMatch(/Hetzner\s*\n?\s*Falkenstein, Neon EU, and Cloudflare R2/);
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
    expect(body).toMatch(/Two ladders\. A free tier to start\./);
    expect(body).toMatch(/Annual contracts save 20%\./);
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

  it('final-CTA pinned (v2 CtaBand component): "See it for yourself. Free." + "Read the docs" secondary CTA → docs.driftstack.dev', () => {
    expect(body).toMatch(/See it for yourself\. Free\./);
    expect(body).toMatch(/secondaryLabel="Read the docs"/);
    expect(body).toMatch(/secondaryHref="https:\/\/docs\.driftstack\.dev"/);
  });

  it("Hero fleet visual pinned: 'Command a fleet of real iPhones.' + identity/history/geo triad + 'just people on phones' close + the fan-of-open-iPhones telemetry footer (S4.5 2026-07-03: the hero is now a fan of open iPhone windows matching the current GUI — '4 iPhones in your fleet / each with its own identity / all healthy'; the pre-v2 fingerprint-coherence mono line stays gone). S24 2026-07-06: the caption strip is real copy in the AA-safe tk-ready-text tone (raw ready is a fill tone, ~3.3:1 as light-mode text), and the fan itself carries data-contrast-decorative (illustration-of-a-UI, WCAG 1.4.3 incidental — the caption strip stays OUTSIDE the exempt wrapper so it is still contrast-scanned)", () => {
    expect(body).toMatch(/Command a fleet of real iPhones\./);
    expect(body).toMatch(/its own identity,\s*\n?\s*its own history, its own corner of the world/);
    expect(body).toMatch(/they're just people on\s*\n?\s*phones\./);
    expect(body).toMatch(/<b class="text-tk-ready-text">4 iPhones<\/b> in your fleet/);
    expect(body).toMatch(/all <b class="text-tk-ready-text">healthy<\/b>/);
    expect(body).toMatch(
      /<div class="flex items-end justify-center pt-2" data-contrast-decorative>/,
    );
    // the pre-v2 technical telemetry line must not return above the fold
    expect(body).not.toMatch(/fingerprint coherence <b/);
    expect(body).not.toMatch(/CreepJS/);
  });

  it("Proof section costume metaphor + detection matrix (v2 merge of the former comparison teaser + why-works + how-its-built): 'One iPhone among millions.' + the costume-metaphor lead + the 7-signal 'What detection systems see' matrix + /comparison cross-link. The standalone 'Not another anti-detect browser.' teaser table was folded in here.", () => {
    expect(body).toMatch(/One iPhone among millions\./);
    expect(body).toMatch(/Most tools dress up a desktop browser to look like a phone/);
    expect(body).toMatch(/What detection systems see/);
    expect(body).toMatch(/Same signals as a physical iPhone\. Not "close enough"\./);
    expect(body).toMatch(/href="\/comparison\/"/);
    // the retired standalone teaser table headline must not return
    expect(body).not.toMatch(/Not another anti-detect browser\./);
  });

  it("Human-by-design behavioural section pinned (v2 headline 'It even moves like a person.'): the bots-move-in-straight-lines lead + touch/scroll + typing-cadence + per-profile-persona cards — all backed by packages/behavioural-simulation (prod-wired)", () => {
    expect(body).toMatch(/It even moves like a person\./);
    expect(body).toMatch(/Bots move in straight lines and constant time\./);
    expect(body).toMatch(
      /Curved touch paths, momentum flicks, natural variation in how long\s*\n?\s*each touch rests/,
    );
    expect(body).toMatch(/Per-character rhythm with natural pauses/);
    expect(body).toMatch(/consistent motion signature across\s*\n?\s*sessions/);
  });

  it("Console section pins only current product surfaces: live Identity Wardrobe and live 'Exit anywhere. Leak nowhere.' egress", () => {
    expect(body).toMatch(/Your fleet, kept in order\./);
    expect(body).toMatch(/title="The Identity Wardrobe" chip="live"/);
    expect(body).toMatch(/Exit anywhere\. Leak nowhere\./);
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
