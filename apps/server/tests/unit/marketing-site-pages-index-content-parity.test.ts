// W500.C (R5-refreshed) — drift guard for apps/marketing-site/src/pages/index.astro.
// R5 reworked the homepage copy for non-technical readers, added a
// 3-card use-case section, and a final-CTA bottom section. This guard
// pins the load-bearing claims on the rewritten page.

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

  it('R12 Stack framing: "Apple\'s engine. Not a Chromium copy." headline replaces the prior "Real WebKit. Real Core Text. Real iOS rendering." copy. Still preserves the Not-Chromium / Not-Playwright contrast + names WebKit / Core Text / iOS rendering pipeline downstream', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    expect(body).toMatch(/Chromium fork with a\s*\n?\s*fake user-agent/);
    expect(body).toMatch(/Playwright with a patch plugin layered on/);
    expect(body).toMatch(
      /WebKit, Core Text, and\s*\n?\s*the iOS rendering pipeline produce your fingerprint the way\s*\n?\s*Apple wrote them, in the order Apple intended\./,
    );
  });

  it("Hero CTAs + free-tier subline (R5: 'Start free' → /pricing#free + M.3 Plan Item 2 'Compare the alternatives' generic CTA — replaces 'Why not Browserless?' which gave free SEO to a competitor and read defensive). The 2026-05-19 polish stripped the mobile-responsive w-full sm:w-auto wrappers since the hero already uses flex-wrap; the buttons relax to their natural width on small screens via the parent container.", () => {
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary">Start free<\/a>/);
    expect(body).toMatch(
      /<a href="\/comparison" class="btn-secondary">Compare the alternatives<\/a>/,
    );
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

  it('R12 Concurrent metering framing pinned: "One metric. Concurrent sessions. That\'s it." headline + per-line anti-pattern callouts (No per-call markup. No per-element fees. No hourly metering...) + 200-pages-on-one-session concrete example — replaces the prior "Pay per concurrent session, not per call." copy', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No\s*\n?\s*per-call markup\. No per-element fees\./);
    expect(body).toMatch(
      /No hourly metering that\s*\n?\s*turns idle sessions into surprise overage charges\./,
    );
    expect(body).toMatch(/Visit\s*\n?\s*200 pages on one session for the cost of visiting one\./);
  });

  it('M.3 (Plan Item 8) EU compliance simplification: "EU-only by default." headline (replaces "Customer data stays in the EU." for inviting/scan-friendly tone) + plain-English body ("Your data stays in the EU. We don\'t log what your sessions visit or do — only the operational metadata we need to bill") + customer-configurable egress card still cross-links to /trust/security-overview per W247.A drift-sweep gate (egress disclaimer status quo respected; W247.A gate auto-flips when EG-API-1.6 customer-egress propagation slice lands at the API layer).', () => {
    expect(body).toMatch(/EU-only by default\./);
    expect(body).toMatch(/Your data stays in the EU\./);
    expect(body).toMatch(/only the operational metadata we need to bill/);
    expect(body).toMatch(/session duration, archetype, cap usage/);
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)\s*\n?\s*— see/,
    );
    // Prior framings must NOT return at this slot.
    expect(body).not.toMatch(/Customer data stays in the EU\./);
    expect(body).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s*\n?\s*single-region\./,
    );
    expect(body).not.toMatch(/We log session metadata only/);
    expect(body).not.toMatch(/Hetzner\s*\n?\s*Falkenstein, Neon EU, and Cloudflare R2/);
  });

  it('Manual ladder framing: $79/$249/$699 + 1/3/8 concurrent + unlimited hours within cap', () => {
    expect(body).toMatch(/Personal \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
    expect(body).toMatch(/1 \/ 3 \/ 8 concurrent sessions per tier/);
    expect(body).toMatch(/Unlimited hours within your concurrent cap/);
  });

  it('API ladder framing: $149/$499/$1,499 + 2/8/24 concurrent + bundled-or-BYOK AI on Builder+', () => {
    expect(body).toMatch(/API Starter \$149\/mo · Builder \$499\/mo · Scale \$1,499\/mo/);
    expect(body).toMatch(/2 \/ 8 \/ 24 concurrent sessions per tier; Enterprise custom/);
    expect(body).toMatch(
      /Optional bundled AI assistant — or bring your own Anthropic API key\s+\(Builder\+\)/,
    );
  });

  it("Pricing teaser: 'Two ladders. A free tier to start.' + 20% annual savings", () => {
    expect(body).toMatch(/Two ladders\. A free tier to start\./);
    expect(body).toMatch(/Annual contracts save 20%\./);
  });

  it('Self-hosted teaser 3-driver list (R5 plain language: privacy-sensitive / high-concurrency / sovereignty)', () => {
    expect(body).toMatch(
      /Privacy-sensitive workloads where session contents must\s*\n?\s*not leave your network/,
    );
    expect(body).toMatch(
      /High-concurrency use where owned hardware costs less than\s*\n?\s*an equivalent cloud subscription/,
    );
    expect(body).toMatch(
      /Full data sovereignty over recordings, screenshots, and\s*\n?\s*everything sessions produce/,
    );
  });

  it('R12 use-case section pinned: "Anywhere mobile Safari fidelity decides the outcome." headline + 3-card Mobile-Safari coverage / Mobile-first scraping / Multi-account operations — replaces the prior "Anywhere a real iPhone Safari fingerprint matters." headline', () => {
    expect(body).toMatch(/Anywhere mobile Safari fidelity decides the outcome\./);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
  });

  it('R12 final-CTA pinned: "See it for yourself. Free." headline + Read the docs secondary CTA', () => {
    expect(body).toMatch(/See it for yourself\. Free\./);
    expect(body).toMatch(/Read the docs/);
    expect(body).toMatch(/<a href="https:\/\/docs\.driftstack\.dev" class="btn-secondary">/);
  });

  it("Fleet merge (founder 2026-06-12 'best of both'): 'Command a fleet of real iPhones.' fleet-wall hero pinned — identity/history/geo triad + 'just people on phones' close + live-status framing + GENERIC telemetry wording (fingerprint coherence verified / detection flags 0 — founder: no tool names, keep it professional)", () => {
    expect(body).toMatch(/Command a fleet of real iPhones\./);
    expect(body).toMatch(/its own identity,\s*\n?\s*its own history, its own corner of the world/);
    expect(body).toMatch(/they're just people on\s*\n?\s*phones\./);
    expect(body).toMatch(/fingerprint coherence <b class="text-tk-ready">verified<\/b>/);
    expect(body).toMatch(/detection flags <b class="text-tk-ready">0<\/b>/);
    expect(body).not.toMatch(/CreepJS/);
  });

  it("Fleet merge: homepage 'Not another anti-detect browser.' comparison table pinned — 4 capability rows (fingerprint / where-it-runs / detection surface / automation) + the /comparison cross-link for full detail", () => {
    expect(body).toMatch(/Not another anti-detect browser\./);
    expect(body).toMatch(/Anti-detects patch a desktop browser to lie about itself\./);
    expect(body).toMatch(/real WebKit, real iOS/);
    expect(body).toMatch(/no runtime JS patching at all/);
    expect(body).toMatch(
      /<a href="\/comparison" class="text-tk-accent underline">comparison page<\/a>/,
    );
  });

  it("Human-by-design behavioural section pinned (2026-06-12, founder: feature the automation framework): 'Every tap drawn from human motion.' + the bots-move-in-straight-lines lead + touch/scroll + typing-cadence + per-profile-persona cards — all claims backed by packages/behavioural-simulation (touch/scroll/keyboard/dwell/profiles, prod-wired)", () => {
    expect(body).toMatch(/Every tap drawn from human motion\./);
    expect(body).toMatch(/Bots move in straight lines and constant time\./);
    expect(body).toMatch(/Curved touch paths, momentum flicks, variable dwell/);
    expect(body).toMatch(/Per-character rhythm with natural pauses/);
    expect(body).toMatch(/consistent motion signature across\s*\n?\s*sessions/);
  });

  it("Console section pinned (founder 2026-06-12: 'mainly the reason I chose this template'): 'Run identities like infrastructure.' + the 5 rows — Identity Wardrobe (Rolling out chip) / Session Replay + Warm-up Scheduler (ROADMAP chips: the honesty device — unbuilt features MUST carry the badge) / egress / Sealed by architecture", () => {
    expect(body).toMatch(/Run identities like infrastructure\./);
    expect(body).toMatch(/The Identity Wardrobe/);
    // the honesty chips are load-bearing: Replay + Warm-up are unbuilt and
    // MUST be visibly badged Roadmap until they exist.
    expect(body).toMatch(/Session Replay\s*\n?\s*<span[^>]*>Roadmap<\/span>/);
    expect(body).toMatch(/Warm-up Scheduler\s*\n?\s*<span[^>]*>Roadmap<\/span>/);
    expect(body).toMatch(/Exit anywhere\. Leak nowhere\./);
    expect(body).toMatch(/Sealed by architecture\./);
    expect(body).toMatch(/Nobody at\s*\n?\s*Driftstack can watch your sessions\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
