// W371.A — drift guard for marketing-site /index (homepage)
// content. Pins the load-bearing claims that drive conversion:
//
//   • Hero positioning: stealth-browsers-modify-JS-at-runtime
//     framing + WebKit-source differentiator.
//   • $2.99 trial-pack CTA + 16h / 14-day / once-per-account
//     figures (consistent with /comparison, /about, /faq).
//   • "Bit-identical" framing + iPhone 16 Pro / iOS 18.7 /
//     Safari 26.4 reference.
//   • "Pay per concurrent session, not per call" metering
//     framing pinned — load-bearing pricing differentiator.
//   • EU-resident compliance section.
//   • SOCKS5 / WireGuard / OpenVPN egress roadmap claim.
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

  it('Hero positioning (2026-05-16 founder rewrite — strong + fancy, two paragraphs collapsed to one, "pixel-identical" dropped): two-line H1 "Indistinguishable iPhone Safari." (gradient span) + "Programmable from any language." Sub-paragraph names Real WebKit, the canvas+WebGL hash match against millions of real iPhones (vs the unique-per-session leak every Chromium-stealth API surfaces), and the four access paths.', () => {
    expect(body).toMatch(/Indistinguishable iPhone Safari\./);
    expect(body).toMatch(/Programmable from any language\./);
    expect(body).toMatch(/Real WebKit — the engine every iPhone ships/);
    expect(body).toMatch(
      /Canvas \+ WebGL\s+hashes match the millions of iPhones in the wild, not the\s+unique-per-session leak every Chromium-stealth API surfaces/,
    );
    expect(body).toMatch(/Drive sessions from TypeScript, Python, Go, or the GUI\./);
    // The pre-rewrite framings must not return.
    expect(body).not.toMatch(/Pixel-identical iPhone Safari\. Cloud-hosted\. API, SDK, or GUI\./);
    expect(body).not.toMatch(/Spin up a session in seconds\. Drive it from TypeScript, Python,/);
    expect(body).not.toMatch(/Other API browsers patch JavaScript at runtime/);
  });

  it('trial-pack CTA + figures pinned: $2.99 / 16h / 14-day / once-per-account', () => {
    expect(body).toMatch(/href="\/pricing#trial-pack"/);
    expect(body).toMatch(/Start for \$2\.99/);
    expect(body).toMatch(/16 hours of session time · 14-day window · one trial per account\./);
  });

  it('Comparison CTA pinned (replaced the old GitHub-release secondary link)', () => {
    expect(body).toMatch(/href="\/comparison"/);
    expect(body).toMatch(/Why not Browserless\?/);
  });

  it('R12 "Indistinguishable from a real iPhone." framing (plain-English replacement for the prior "Bit-identical" jargon) + iPhone 16 Pro / iOS 18.7 / Safari 26.4 reference + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/Indistinguishable from a real iPhone\./);
    expect(body).toMatch(/iPhone 16 Pro, iOS 18\.7, Safari 26\.4/);
    expect(body).toMatch(
      /If any\s+measurable signal differs from what that phone sends, we treat\s+it as a launch-blocking bug/,
    );
  });

  it('SDK snippet pinned: archetype + proxy + sessions API shape (TypeScript)', () => {
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4'/);
    expect(body).toMatch(/proxy: \{ type: 'wireguard', config: '\.\.\.' \}/);
  });

  it('R12 metering framing pinned: "One metric. Concurrent sessions. That\'s it." + no-per-call-markup + no-per-element-fees + 200-pages-on-one-session example — replaces the prior "Pay per concurrent session, not per call." copy', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No\s*\n?\s*per-call markup\. No per-element fees\./);
    expect(body).toMatch(/Visit\s+200 pages on one session for the cost of visiting one\./);
  });

  it('F-5 (Issue 5 + 6) EU-resident compliance section: "Customer data stays in the EU." headline + single-region framing (vendor names moved to /trust/sub-processors per Issue 6) + session-metadata-only commitment + sub-processors cross-link', () => {
    expect(body).toMatch(/Customer data stays in the EU\./);
    expect(body).toMatch(
      /Database, object storage, and compute all run in the EU,\s+single-region\./,
    );
    expect(body).toMatch(/We log session metadata only/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
    expect(body).not.toMatch(/Hetzner\s+Falkenstein, Neon EU, and Cloudflare R2/);
  });

  it('egress card body no longer claims "on the roadmap" prose (F-5 Issue 5); the small "# Roadmap — customer-configurable egress" inline comment in the EU-residency code-preview is the canonical honest disclosure, gated by W499.D against the server source state', () => {
    expect(body).toMatch(/Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s+— see/);
    expect(body).toMatch(/SOCKS5 \/ WireGuard \/ OpenVPN \(not shipped\)/);
    expect(body).not.toMatch(
      /Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s+is on the roadmap/,
    );
  });

  it('two-ladder pricing teaser pinned: Manual $79/$249/$699 + API $149/$499/$1,499', () => {
    expect(body).toMatch(/Solo Manual \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
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

  it('R12 polish: 3-card use-case section "Anywhere mobile Safari fidelity decides the outcome." headline + Mobile-Safari coverage / Mobile-first scraping / Multi-account operations cards + Final-CTA "See it for yourself. $2.99." headline + "Read the docs" secondary CTA', () => {
    expect(body).toMatch(/Anywhere mobile Safari fidelity decides the outcome\./);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
    expect(body).toMatch(/See it for yourself\. \$2\.99\./);
    expect(body).toMatch(/Read the docs/);
  });
});
