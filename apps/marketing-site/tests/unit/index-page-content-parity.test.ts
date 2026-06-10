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
    expect(body).toMatch(/href="\/pricing#free"/);
    expect(body).toMatch(/Start free/);
    expect(body).toMatch(/One profile · 20-minute sessions · no card required\./);
  });

  it('Comparison CTA pinned (M.3 Plan Item 2 — "Compare the alternatives" generic framing replaced "Why not Browserless?" which read too defensive and gave free SEO to a specific competitor)', () => {
    expect(body).toMatch(/href="\/comparison"/);
    expect(body).toMatch(/Compare the alternatives/);
    // The prior "Why not Browserless?" CTA must NOT return.
    expect(body).not.toMatch(/Why not Browserless\?/);
  });

  it('M.3 + M.6 — "One iPhone among millions." why-works hero (M.3 Plan Item 5 dedupe; "Indistinguishable" now appears once on the page in the hero h1 brand line) + multi-archetype iPhone family + Safari 26.4-26.5 launch-window reference (M.6 Path A per founder verdict 2026-05-17) + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/One iPhone among millions\./);
    // M.6 Path A: multi-archetype launch family + Safari 26.5 span.
    expect(body).toMatch(/iPhone\s+15 Pro/);
    expect(body).toMatch(/iPhone 16 Pro/);
    expect(body).toMatch(/iPhone 17 lineup/);
    expect(body).toMatch(/iOS 18\.7\s*\n?\s*\/ Safari 26\.4/);
    expect(body).toMatch(/Safari 26\.5/);
    expect(body).toMatch(/launch-blocking bug/);
    // The pre-dedupe wording must NOT return at this slot — it was
    // the load-bearing repetition Item 5 fixes.
    expect(body).not.toMatch(
      /<span class="bg-gradient-to-br[^>]+>\s*\n?\s*Indistinguishable from a real iPhone\./,
    );
    // Pre-M.6 single-archetype framing must NOT return.
    expect(body).not.toMatch(/Reference device: iPhone 16 Pro, iOS 18\.7, Safari 26\.4\./);
  });

  it('SDK snippet pinned: archetype + sessions API shape (TypeScript)', () => {
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4'/);
    // Hero snippet stays focused on the create / navigate / capture /
    // destroy critical path. Egress / proxy is documented separately
    // (see /docs/egress + the @driftstack/sdk proxy attachment
    // surface) — keeping it out of the hero per Egress-card-503-stub
    // posture means we don't market a feature that's still stub-only.
    expect(body).toMatch(/ds\.sessions\.navigate/);
    expect(body).toMatch(/ds\.sessions\.capture/);
    expect(body).toMatch(/ds\.sessions\.destroy/);
  });

  it('R12 metering framing pinned: "One metric. Concurrent sessions. That\'s it." + no-per-call-markup + no-per-element-fees + 200-pages-on-one-session example — replaces the prior "Pay per concurrent session, not per call." copy', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No\s*\n?\s*per-call markup\. No per-element fees\./);
    expect(body).toMatch(/Visit\s+200 pages on one session for the cost of visiting one\./);
  });

  it('M.3 (Plan Item 8) EU compliance simplification: "EU-only by default." headline (replaces "Customer data stays in the EU." for inviting/scan-friendly tone) + plain-English body ("Your data stays in the EU. We don\'t log what your sessions visit or do — only the operational metadata we need to bill") + sub-processors cross-link. Infra-tier detail (Database / object storage / compute / single-region) was moved off the homepage to /trust/security-overview and /trust/sub-processors where infra-tier readers go.', () => {
    expect(body).toMatch(/EU-only by default\./);
    expect(body).toMatch(/Your data stays in the EU\./);
    expect(body).toMatch(/only the operational metadata we need to bill/);
    expect(body).toMatch(/session duration, archetype, cap usage/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
    // Prior framings must NOT return at this slot.
    expect(body).not.toMatch(/Customer data stays in the EU\./);
    expect(body).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s+single-region\./,
    );
    expect(body).not.toMatch(/Hetzner\s+Falkenstein, Neon EU, and Cloudflare R2/);
  });

  it('egress card body no longer claims "on the roadmap" prose (F-5 Issue 5); the small "# Roadmap — customer-configurable egress" inline comment in the EU-residency code-preview is the canonical honest disclosure, gated by W499.D against the server source state. Priority order SOCKS5 / OpenVPN / WireGuard per founder verdict 2026-05-16 (Phase 1 / Phase 2 / Phase 3 deferred); matches the server source string in session-proxy.ts.', () => {
    expect(body).toMatch(/Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)\s+— see/);
    expect(body).toMatch(/SOCKS5 \/ OpenVPN \/ WireGuard \(not shipped\)/);
    expect(body).not.toMatch(
      /Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)\s+is on the roadmap/,
    );
    // The pre-reorder form must not return.
    expect(body).not.toMatch(/SOCKS5 \/ WireGuard \/ OpenVPN \(not shipped\)/);
  });

  it('two-ladder pricing teaser pinned: Manual $79/$249/$699 + API $149/$499/$1,499', () => {
    expect(body).toMatch(/Personal \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
    expect(body).toMatch(/API Starter \$149\/mo · Builder \$499\/mo · Scale \$1,499\/mo/);
    expect(body).toMatch(/1 \/ 3 \/ 8 concurrent sessions per tier/);
    expect(body).toMatch(/2 \/ 8 \/ 24 concurrent sessions per tier; Enterprise custom/);
  });

  it('annual 20%-off claim pinned (aligned with /faq + /pricing)', () => {
    expect(body).toMatch(/Annual contracts save 20%/);
  });

  it('self-hosted teaser pinned: 3 use cases (privacy / volume / sovereignty) + /self-hosted link', () => {
    expect(body).toMatch(/Run Driftstack on your own infrastructure\./);
    expect(body).toMatch(/Privacy-sensitive workloads/);
    expect(body).toMatch(/High-concurrency use/);
    expect(body).toMatch(/Full data sovereignty/);
    expect(body).toMatch(/href="\/self-hosted"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro'))).toBe(
      true,
    );
  });

  it('R12 stack-statement pinned: "Apple\'s engine. Not a Chromium copy." headline + "Chromium fork with a fake user-agent" + "Playwright with a patch plugin layered on top" contrast + "WebKit, Core Text, and the iOS rendering pipeline" capability list — replaces the prior "Real WebKit. Real Core Text. Real iOS rendering." three-Reals headline', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    expect(body).toMatch(/Chromium fork with a\s+fake user-agent/);
    expect(body).toMatch(/Playwright with a patch plugin layered on/);
    expect(body).toMatch(
      /WebKit, Core Text, and\s+the iOS rendering pipeline produce your fingerprint the way\s+Apple wrote them, in the order Apple intended\./,
    );
  });

  it('bundled-or-BYOK AI claim pinned (Builder+ tier gate)', () => {
    expect(body).toMatch(
      /Optional bundled AI assistant — or bring your own Anthropic API key\s+\(Builder\+\)/,
    );
  });

  it('R12 polish: 3-card use-case section "Anywhere mobile Safari fidelity decides the outcome." headline + Mobile-Safari coverage / Mobile-first scraping / Multi-account operations cards + Final-CTA "See it for yourself. Free." headline + "Read the docs" secondary CTA', () => {
    expect(body).toMatch(/Anywhere mobile Safari fidelity decides the outcome\./);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
    expect(body).toMatch(/See it for yourself\. Free\./);
    expect(body).toMatch(/Read the docs/);
  });
});
