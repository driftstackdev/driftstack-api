// W371.A — drift guard for marketing-site /index (homepage)
// content. The most-trafficked surface; existing index-hero-
// baseline + index-sections-baseline + index-trial-pack-cross-
// alignment + fingerprint-claim-baseline tests cover shape. This
// guard pins the load-bearing claims that drive conversion:
//
//   • Hero positioning: "Most stealth browsers modify JavaScript
//     at runtime" + WebKit-C++-source-instead differentiator.
//   • $2.99 trial-pack CTA + 16h / 14-day / once-per-account
//     figures (consistent with /comparison, /about, /faq).
//   • GitHub GUI client release link (driftstackdev/driftstack-
//     gui/releases) — second CTA target.
//   • "Bit-identical" cumulative-rig framing + iPhone 16 Pro /
//     iOS 18.7 / Safari 26.4 reference.
//   • "Pay per concurrent session, not per call" metering
//     framing pinned — load-bearing pricing differentiator.
//   • EU-resident compliance section: control plane stores
//     metadata only / never response bodies.
//   • SOCKS5 / WireGuard / OpenVPN egress roadmap claim aligned
//     with /security (V-503).
//   • Two-ladder pricing teaser: Manual $79/$249/$699 + API
//     $149/$499/$1,499 with 1/3/8 + 2/8/24 concurrent caps.
//   • Annual 20% off claim.
//   • Self-hosted teaser: 3 use cases (privacy / volume /
//     sovereignty) + cross-link to /self-hosted.

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

  it('hero positioning pinned: "Most stealth browsers modify JavaScript at runtime"', () => {
    expect(body).toMatch(/Most stealth browsers modify JavaScript at runtime\./);
    expect(body).toMatch(/Detection vendors built their industry on catching exactly that/);
  });

  it('WebKit-C++-source-instead differentiator pinned (no JS-runtime patches)', () => {
    expect(body).toMatch(
      /We modify WebKit's C\+\+ source instead\. There's nothing at the\s+JavaScript layer for detection to find/,
    );
    expect(body).toMatch(
      /The fingerprint your code reads is the\s+fingerprint a real iPhone reads/,
    );
  });

  it('trial-pack CTA + figures pinned: $2.99 / 16h / 14-day / once-per-account', () => {
    expect(body).toMatch(/href="\/pricing#trial-pack"/);
    expect(body).toMatch(/Get started — \$2\.99/);
    expect(body).toMatch(/16 hours · 14-day window · used once per account\./);
  });

  it('GUI client GitHub release link pinned (driftstackdev/driftstack-gui/releases)', () => {
    expect(body).toContain('https://github.com/driftstackdev/driftstack-gui/releases');
    expect(body).toMatch(/Download GUI client/);
  });

  it('"Bit-identical" cumulative-rig framing pinned + iPhone 16 Pro / iOS 18.7 / Safari 26.4 reference', () => {
    expect(body).toMatch(/Bit-identical\./);
    expect(body).toMatch(/the reference iPhone 16 Pro on iOS 18\.7 \/ Safari\s+26\.4/);
    expect(body).toMatch(
      /A signal either matches the\s+reference, or we treat the gap as a launch-blocker bug/,
    );
  });

  it('SDK snippet pinned: archetype + proxy + sessions API shape (TypeScript)', () => {
    // The hero code-block illustrates the SDK contract — pin so a
    // future copy edit can't accidentally regress the public shape.
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4'/);
    expect(body).toMatch(/proxy: \{ type: 'wireguard', config: '\.\.\.' \}/);
  });

  it('"Pay per concurrent session, not per call" metering framing pinned', () => {
    expect(body).toMatch(/Pay per concurrent session, not per call\./);
    expect(body).toMatch(/no per-call markup, no\s+per-element fees/);
  });

  it('EU-resident compliance section: control-plane scope claim pinned', () => {
    expect(body).toMatch(/EU-resident infrastructure\./);
    expect(body).toMatch(
      /The control plane stores\s+session metadata only; we never store destination response\s+bodies/,
    );
    // Sub-processor cross-link.
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
  });

  it('egress roadmap claim aligned with /security (SOCKS5 / WireGuard / OpenVPN, not shipped)', () => {
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s+is on the roadmap/,
    );
    // Code-block surfaces the "not shipped" caveat.
    expect(body).toMatch(/SOCKS5 \/ WireGuard \/ OpenVPN \(not shipped\)/);
  });

  it('two-ladder pricing teaser pinned: Manual $79/$249/$699 + API $149/$499/$1,499', () => {
    expect(body).toMatch(/Solo Manual \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
    expect(body).toMatch(/API Starter \$149\/mo · Builder \$499\/mo · Scale \$1,499\/mo/);
    // Concurrent-cap ladders.
    expect(body).toMatch(/1 \/ 3 \/ 8 concurrent sessions per tier/);
    expect(body).toMatch(/2 \/ 8 \/ 24 concurrent sessions per tier; Enterprise custom/);
  });

  it('annual 20%-off claim pinned (aligned with /faq + /pricing)', () => {
    expect(body).toMatch(/Annual\s+contracts save 20%/);
  });

  it('self-hosted teaser pinned: 3 use cases (privacy / volume / sovereignty) + /self-hosted link', () => {
    expect(body).toMatch(/Run Driftstack on your own infrastructure\./);
    expect(body).toMatch(/Privacy-required workloads/);
    expect(body).toMatch(/Sustained high-concurrency operations/);
    expect(body).toMatch(/Full data sovereignty/);
    expect(body).toMatch(/href="\/self-hosted"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro'))).toBe(
      true,
    );
  });

  it('"Real WebKit. Real Core Text. Real iOS rendering." stack-statement pinned', () => {
    expect(body).toMatch(/Real WebKit\. Real Core Text\. Real iOS rendering\./);
    expect(body).toMatch(/Not a Chromium fork with a user-agent swap/);
    expect(body).toMatch(/Not Playwright with stealth\s+plugins layered on/);
  });

  it('Bundled-LLM-or-BYOK claim pinned (Builder+ tier gate)', () => {
    expect(body).toMatch(
      /Bundled LLM, or bring your own Anthropic API key, for AI-driven sessions \(Builder\+\)/,
    );
  });
});
