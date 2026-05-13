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

  it('hero positioning pinned: stealth-browsers-modify-JS framing + detection-systems-built-to-catch hook', () => {
    expect(body).toMatch(/iPhone Safari sessions that look like a real iPhone\./);
    expect(body).toMatch(/Most stealth browsers modify JavaScript at runtime/);
    expect(body).toMatch(/detection systems are built to catch/);
  });

  it('WebKit-source-instead differentiator pinned (no JS-runtime patches)', () => {
    expect(body).toMatch(
      /We run Apple's WebKit source code, the\s+same engine inside every real iPhone/,
    );
    expect(body).toMatch(
      /Nothing is rewritten at\s+runtime, so there's nothing for detection to find/,
    );
    expect(body).toMatch(
      /The\s+fingerprint your code sees is the fingerprint a real iPhone\s+would send/,
    );
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

  it('"Bit-identical" framing pinned + iPhone 16 Pro / iOS 18.7 / Safari 26.4 reference', () => {
    expect(body).toMatch(/Bit-identical\./);
    expect(body).toMatch(/iPhone 16 Pro running iOS 18\.7 \/ Safari 26\.4/);
    expect(body).toMatch(
      /If a signal differs from what\s+a real iPhone sends, we treat it as a launch-blocking bug/,
    );
  });

  it('SDK snippet pinned: archetype + proxy + sessions API shape (TypeScript)', () => {
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
    expect(body).toMatch(/All customer data — the database, the object storage, and the\s+compute/);
    expect(body).toMatch(/We store only the\s+metadata about your sessions/);
    expect(body).toMatch(/href="\/trust\/sub-processors"/);
  });

  it('egress roadmap claim aligned with /security (SOCKS5 / WireGuard / OpenVPN, not shipped)', () => {
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s+is on the roadmap/,
    );
    expect(body).toMatch(/SOCKS5 \/ WireGuard \/ OpenVPN \(not shipped\)/);
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

  it('"Real WebKit. Real Core Text. Real iOS rendering." stack-statement pinned', () => {
    expect(body).toMatch(/Real WebKit\. Real Core Text\. Real iOS rendering\./);
    expect(body).toMatch(/Not a Chromium fork with a fake user-agent/);
    expect(body).toMatch(/Not Playwright with a\s+stealth plugin patched over it/);
  });

  it('bundled-or-BYOK AI claim pinned (Builder+ tier gate)', () => {
    expect(body).toMatch(
      /Optional bundled AI assistant — or bring your own Anthropic API key\s+\(Builder\+\)/,
    );
  });

  it('R5 polish: 3-card use-case section + final-CTA bottom section pinned', () => {
    // New "What people build with it" section adds social-proof context.
    expect(body).toMatch(/Anywhere a real iPhone Safari fingerprint matters/);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
    // Final-CTA section adds a second conversion point at the bottom.
    expect(body).toMatch(/Try Driftstack for \$2\.99\./);
    expect(body).toMatch(/Read the docs/);
  });
});
