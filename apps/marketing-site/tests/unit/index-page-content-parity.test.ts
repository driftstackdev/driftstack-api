// W371.A — drift guard for marketing-site /index (homepage)
// content. Pins the load-bearing claims that drive conversion:
//
//   • Hero positioning: stealth-browsers-modify-JS-at-runtime
//     framing + WebKit-source differentiator.
//   • Free-tier CTA + one-profile / 20-minute-manual / no-card subline
//     figures (consistent with /comparison, /about, /faq).
//   • "Bit-identical" framing + iPhone 16 Pro / iOS 18.7 /
//     Safari 26.4 reference.
//   • "Pay per concurrent session, not per call" metering
//     framing pinned — load-bearing pricing differentiator.
//   • EU-resident compliance section.
//   • SOCKS5 / OpenVPN / WireGuard egress roadmap claim
//     (priority order per founder verdict 2026-05-16).
//   • Two-ladder pricing teaser: Manual $79/$249/$699 + API
//     $149/$499/$1,499 with 1/3/8 + 2/8/24 concurrent caps.
//   • Annual 20% off claim.
//   • Self-hosted teaser cross-link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W371.A marketing-site /index (homepage) content parity', () => {
  const body = read(PAGE);

  it('Hero positioning W452 noob-friendly rewrite — plain-language, jargon stripped (Canvas/WebGL-hash + Chromium-stealth-API removed). Two-line H1 kept ("Indistinguishable iPhone Safari." gradient span + "Programmable from any language."). Sub-paragraph leads with the outcome (every site sees a genuine iPhone, never a bot/emulator) + use-cases + the four access paths ("desktop app", not "GUI").', () => {
    expect(body).toMatch(/Indistinguishable iPhone Safari\./);
    expect(body).toMatch(/Programmable from any language\./);
    expect(body).toMatch(/Run a real iPhone browser in the cloud that every website treats as/);
    expect(body).toMatch(/a genuine iPhone — never a bot, never an emulator\. Built for/);
    expect(body).toMatch(/scraping, testing, and automation that has to pass as a real mobile/);
    expect(body).toMatch(/user\. Drive it from TypeScript, Python, Go, or the desktop app\./);
    // Jargon-heavy + pre-rewrite framings must not return.
    expect(body).not.toMatch(/Canvas \+ WebGL\s+hashes match the millions/);
    expect(body).not.toMatch(/unique-per-session leak every Chromium-stealth API surfaces/);
    expect(body).not.toMatch(/Pixel-identical iPhone Safari\. Cloud-hosted\. API, SDK, or GUI\./);
    expect(body).not.toMatch(/Spin up a session in seconds\. Drive it from TypeScript, Python,/);
    expect(body).not.toMatch(/Other API browsers patch JavaScript at runtime/);
  });

  it('W456 — plain-language "How it works in 3 steps" section (noob-friendly explainer placed early): "How it works" label + "Three steps to a real iPhone in the cloud." h2 + three step headings (Pick an iPhone profile / Start a session / Drive it your way). Pinned so the non-technical explainer stays.', () => {
    expect(body).toMatch(/Three steps to a real iPhone in the cloud\./);
    expect(body).toMatch(/Pick an iPhone profile/);
    expect(body).toMatch(/Start a session/);
    expect(body).toMatch(/Drive it your way/);
  });

  it('free-tier CTA + figures pinned: Start free / #free anchor / one-profile subline', () => {
    expect(body).toMatch(/href="\/pricing\/#free"/);
    expect(body).toMatch(/Start free/);
    expect(body).toMatch(/One profile · 20-minute sessions · no card required\./);
  });

  it('Comparison cross-link pinned (v2 2026-07-03: the hero secondary CTA is now "See how it works" → the in-page how-it-works section; the /comparison deep link moved into the proof section as the tool-by-tool "comparison page" link)', () => {
    expect(body).toMatch(/href="\/comparison\/"/);
    expect(body).toMatch(/comparison page/);
    expect(body).toMatch(/See how it works/);
    // The prior "Why not Browserless?" CTA must NOT return.
    expect(body).not.toMatch(/Why not Browserless\?/);
  });

  it('M.3 + M.6 — "One iPhone among millions." why-works hero (M.3 Plan Item 5 dedupe; "Indistinguishable" now appears once on the page in the hero h1 brand line) + multi-archetype iPhone family + Safari 26.4-26.5 launch-window reference (M.6 Path A per founder verdict 2026-05-17) + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/One iPhone among millions\./);
    // M.6 Path A: multi-archetype launch family + Safari 26.5 span.
    expect(body).toMatch(/iPhone\s+15 Pro/);
    expect(body).toMatch(/iPhone 16 Pro/);
    expect(body).toMatch(/iPhone 17 lineup/);
    expect(body).toMatch(/iOS 18\.7\s*\/ Safari 26\.4/);
    expect(body).toMatch(/Safari 26\.5/);
    expect(body).toMatch(/launch-blocking bug/);
    // The pre-dedupe wording must NOT return at this slot — it was
    // the load-bearing repetition Item 5 fixes.
    expect(body).not.toMatch(
      /<span class="bg-gradient-to-br[^>]+>\s*Indistinguishable from a real iPhone\./,
    );
    // Pre-M.6 single-archetype framing must NOT return.
    expect(body).not.toMatch(/Reference device: iPhone 16 Pro, iOS 18\.7, Safari 26\.4\./);
  });

  it('SDK snippet pinned: archetype + sessions API shape (TypeScript)', () => {
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/archetype: 'iphone17_ios18_7_safari26_4'/);
    // Hero snippet stays focused on the create / navigate / capture /
    // destroy critical path. Egress / proxy is documented separately
    // (see /docs/egress + the @driftstack/sdk proxy attachment
    // surface) — keeping it out of the hero per Egress-card-503-stub
    // posture means we don't market a feature that's still stub-only.
    expect(body).toMatch(/ds\.sessions\.navigate/);
    expect(body).toMatch(/ds\.sessions\.capture/);
    expect(body).toMatch(/ds\.sessions\.destroy/);
  });

  it('metering framing pinned (v2 trust band): "One metric. Concurrent sessions. That\'s it." + no-per-call-markup + no-per-element-fees + 200-pages-on-one-session example', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No per-call markup\. No\s*per-element fees\./);
    expect(body).toMatch(/Visit 200 pages on one session for the cost of\s*visiting one\./);
  });

  it('S30 2026-07-07 (founder decision: soften) EU residency softened: "EU-hosted by default." headline (supersedes M.3\'s "EU-only by default." — DB-resident data is EU-Hetzner-true, but file objects live on Cloudflare R2 default jurisdiction with EU + US replication, so the absolutist claim over-promised) + plain-English body ("Your account data lives on EU servers. We don\'t log what your sessions visit or do — only the operational metadata we need to bill") + sub-processors cross-link.', () => {
    expect(body).toMatch(/EU-hosted by default\./);
    expect(body).toMatch(/Your account data lives on EU servers\./);
    expect(body).toMatch(/only the operational metadata we need to bill/);
    // S20b 2026-07-06: the billing-metadata triple reads in plain words
    // (duration / archetype glossed via the glossary link / cap usage).
    expect(body).toMatch(
      /how long a\s*session ran, which iPhone model \+ iOS \+ Safari combination it used/,
    );
    expect(body).toMatch(/how much of your concurrent cap it used/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    // Prior framings must NOT return at this slot.
    expect(body).not.toMatch(/Customer data stays in the EU\./);
    expect(body).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s+single-region\./,
    );
    expect(body).not.toMatch(/Hetzner\s+Falkenstein, Neon EU, and Cloudflare R2/);
    // S30 negative pins — the absolutist residency claims must not
    // silently return (founder decision 2026-07-07: soften).
    expect(body).not.toMatch(/EU-only by default/);
    expect(body).not.toMatch(/Your data stays in the EU/);
  });

  it('egress state is current: per-profile SOCKS5 / OpenVPN / WireGuard is live, with the security cross-link and no aspirational proxy-swap copy', () => {
    expect(body).toMatch(
      /Customer-configurable egress — attaching your own internet exit \(a\s*SOCKS5 proxy, OpenVPN, or WireGuard\) to each profile — is live/,
    );
    expect(body).not.toMatch(/swapping the proxy on a session that's already running/);
    expect(body).toMatch(/href="\/trust\/security-overview\/"/);
    // The stale "egress itself is not shipped" outlier must NOT return —
    // it self-contradicted every other egress surface on the site.
    expect(body).not.toMatch(/SOCKS5 \/ OpenVPN \/ WireGuard \(not shipped\)/);
    expect(body).not.toMatch(/SOCKS5 \/ WireGuard \/ OpenVPN \(not shipped\)/);
    expect(body).not.toMatch(/Session Replay|Warm-up Scheduler|chip="roadmap"/);
  });

  it('two-ladder pricing teaser is BOUND from src/data/pricing.ts (W292.B — no hand-typed dollars in the markup; figures derive from API_TIERS and the exact $79/$249/$699 + $149/$499/$1,499 values are guarded by the pricing-*-tier-figures baselines)', () => {
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/data\/pricing'/);
    expect(body).toMatch(/const manualLineup = manualLadder/);
    expect(body).toMatch(/const apiLineup = apiLadder/);
    // the ladders + caps render via interpolation, not literals
    expect(body).toMatch(/\{manualLineup\}/);
    expect(body).toMatch(/\{apiLineup\}/);
    expect(body).toMatch(/\{manualCaps\} concurrent sessions per tier/);
    expect(body).toMatch(/\{apiCaps\} concurrent sessions per tier; Enterprise custom/);
    // no hand-typed tier dollar figure survives in the markup
    expect(body).not.toMatch(/Personal \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
  });

  it('annual 20%-off claim pinned (aligned with /faq + /pricing)', () => {
    expect(body).toMatch(/Annual contracts save 20%/);
  });

  it('self-hosted teaser pinned (v2 compact band): "Run Driftstack on your own infrastructure." + /self-hosted link + the page exists', () => {
    expect(body).toMatch(/Run Driftstack on your own infrastructure\./);
    expect(body).toMatch(/href="\/self-hosted\/"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro'))).toBe(
      true,
    );
  });

  it('stack-statement pinned inside the v2 proof section: "Apple\'s engine. Not a Chromium copy." + the "WebKit, Core Text, and the iOS rendering pipeline" capability sentence (the Chromium-fork/Playwright-patch competitor contrast now lives on /comparison)', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    // S20b 2026-07-06 plain-language pass: Core Text + the pipeline are now
    // glossed inline; the same capability sentence survives with glosses.
    expect(body).toMatch(
      /WebKit \(the browser engine\),\s*Core Text \(Apple's text-drawing system\)/,
    );
    expect(body).toMatch(
      /rendering pipeline produce your fingerprint the way Apple wrote\s*them, in the order Apple intended\./,
    );
  });

  // S26 2026-07-06 (#132) — re-pinned: the old wording's trailing
  // "(API Builder and up)" misread as BYOK-gated-to-Builder, but per
  // packages/api-types/src/common.ts TIER_FEATURES every API tier has
  // the AI agent with BYOK (api_starter: llmBilling 'byok_only');
  // only the bundled option starts at api_builder.
  it('bundled-or-BYOK AI claim pinned (BYOK on every API tier; bundled = Builder+ gate)', () => {
    expect(body).toMatch(
      /AI assistant on every API tier — connect your own Anthropic key and pay Anthropic directly, no Driftstack markup; an optional bundled assistant \(no key needed\) comes with API Builder and up/,
    );
  });

  it('v2 use-case section (Band A personas, operators first): "Built for the work you actually do." headline + the 3 persona cards (Run many accounts, safely apart / Test on the real thing / See what iPhone users see) + Final-CTA "See it for yourself. Free." + "Read the docs" secondary CTA', () => {
    expect(body).toMatch(/Built for the work you actually do\./);
    expect(body).toMatch(/Run many accounts, safely apart/);
    expect(body).toMatch(/Test on the real thing/);
    expect(body).toMatch(/See what iPhone users see/);
    expect(body).toMatch(/See it for yourself\. Free\./);
    expect(body).toMatch(/Read the docs/);
  });
});
