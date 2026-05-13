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

  it("BaseLayout title='Driftstack' + R5 plain-English SEO description (real iPhone Safari sessions / pixel-perfect / $2.99 trial)", () => {
    expect(body).toMatch(
      /<BaseLayout\s*\n?\s*title="Driftstack"\s*\n?\s*description="Real iPhone Safari sessions, on demand\. Pixel-perfect device fingerprints with no detectable software fingerprint\. Try it for \$2\.99 — 16 hours of sessions, one purchase per account\."/,
    );
  });

  it('Hero copy (R5): section label + iPhone-Safari headline + detection-built-to-catch hook + WebKit-source-code differentiator', () => {
    expect(body).toMatch(/iPhone Safari sessions that look like a real iPhone\./);
    expect(body).toMatch(/Most stealth browsers modify JavaScript at runtime/);
    expect(body).toMatch(/detection systems are built to catch/);
    expect(body).toMatch(
      /We run Apple's WebKit source code, the\s*\n?\s*same engine inside every real iPhone/,
    );
  });

  it("Cumulative-rig 'Bit-identical.' giant-headline framing pinned + iPhone 16 Pro / iOS 18.7 / Safari 26.4 reference", () => {
    expect(body).toMatch(/Bit-identical\./);
    expect(body).toMatch(/iPhone 16 Pro running iOS 18\.7 \/ Safari 26\.4/);
    expect(body).toMatch(
      /If a signal differs from what\s*\n?\s*a real iPhone sends, we treat it as a launch-blocking bug/,
    );
  });

  it("Stack framing: 'Real WebKit. Real Core Text. Real iOS rendering.' + Not-Chromium / Not-Playwright differentiator", () => {
    expect(body).toMatch(/Real WebKit\. Real Core Text\. Real iOS rendering\./);
    expect(body).toMatch(/Not a Chromium fork with a fake user-agent/);
    expect(body).toMatch(/Not Playwright with a\s*\n?\s*stealth plugin patched over it/);
  });

  it("Hero CTAs + trial-pack subline (R5: 'Start for $2.99' + 'Why not Browserless?')", () => {
    expect(body).toMatch(
      /<a href="\/pricing#trial-pack" class="btn-primary">Start for \$2\.99<\/a>/,
    );
    expect(body).toMatch(/<a href="\/comparison" class="btn-secondary">Why not Browserless\?<\/a>/);
    expect(body).toMatch(/16 hours of session time · 14-day window · one trial per account\./);
  });

  it('Code example contract: archetype + wireguard proxy + navigate/waitForChallenge/interact/destroy', () => {
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4',/);
    expect(body).toMatch(/proxy: \{ type: 'wireguard', config: '\.\.\.' \},/);
    expect(body).toMatch(/await session\.navigate\(\{ url: 'https:\/\/target\.example' \}\);/);
    expect(body).toMatch(/const challenge = await session\.waitForChallenge\(\);/);
    expect(body).toMatch(/await session\.interact\(\{ tap: '#submit' \}\);/);
    expect(body).toMatch(/await session\.destroy\(\);/);
  });

  it("Concurrent metering framing pinned: 'Pay per concurrent session, not per call.' + 3 anti-pattern bullets", () => {
    expect(body).toMatch(/Pay per concurrent session, not per call\./);
    expect(body).toMatch(
      /no per-call markup, no\s*\n?\s*per-element fees, no hourly metering that turns idle browsers\s*\n?\s*into surprise overage charges\./,
    );
  });

  it("EU compliance framing (R5 plain language): 'All customer data … sits in the EU' + customer-configurable egress roadmap", () => {
    expect(body).toMatch(
      /All customer data — the database, the object storage, and the\s*\n?\s*compute that runs sessions — sits in the EU/,
    );
    expect(body).toMatch(/We store only the\s*\n?\s*metadata about your sessions/);
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s*\n?\s*is on the roadmap/,
    );
  });

  it('Manual ladder framing: $79/$249/$699 + 1/3/8 concurrent + unlimited hours within cap', () => {
    expect(body).toMatch(/Solo Manual \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
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

  it("Pricing teaser: 'Two ladders. One trial pack to start.' + 20% annual savings", () => {
    expect(body).toMatch(/Two ladders\. One trial pack to start\./);
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

  it('R5 NEW section: 3 use-case cards (mobile-Safari coverage / mobile-first scraping / multi-account)', () => {
    expect(body).toMatch(/Anywhere a real iPhone Safari fingerprint matters\./);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
  });

  it('R5 NEW section: final-CTA bottom section ("Try Driftstack for $2.99." + Read the docs)', () => {
    expect(body).toMatch(/Try Driftstack for \$2\.99\./);
    expect(body).toMatch(/Read the docs/);
    expect(body).toMatch(/<a href="https:\/\/docs\.driftstack\.dev" class="btn-secondary">/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
