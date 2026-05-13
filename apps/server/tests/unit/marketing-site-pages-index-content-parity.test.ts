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

  it("R12 BaseLayout title='Driftstack' + new SEO description: 'Real iPhone Safari sessions, on demand. The same WebKit engine every iPhone ships — no patches at runtime, no stealth plugins, nothing for detection to find. Try it for $2.99.' — replaces the prior 'Pixel-perfect device fingerprints with no detectable software fingerprint' copy", () => {
    expect(body).toMatch(
      /<BaseLayout\s*\n?\s*title="Driftstack"\s*\n?\s*description="Real iPhone Safari sessions, on demand\. The same WebKit engine every iPhone ships — no patches at runtime, no stealth plugins, nothing for detection to find\. Try it for \$2\.99\."/,
    );
  });

  it('R12 Hero copy: section label + new "Real iPhone Safari. Cloud-hosted. API-first." headline + sub-paragraph listing every-signal fidelity + "stealth tools rewrite JavaScript at runtime and leak the underlying engine in the next hash" framing — replaces the prior "iPhone Safari sessions that look like a real iPhone." + "Most stealth browsers modify JavaScript at runtime" copy', () => {
    expect(body).toMatch(/Real iPhone Safari\. Cloud-hosted\. API-first\./);
    expect(body).toMatch(/Spin up a session in seconds\. Drive it from TypeScript, Python,/);
    expect(body).toMatch(/Most stealth tools rewrite JavaScript at runtime/);
    expect(body).toMatch(
      /Driftstack runs Apple's\s*\n?\s*WebKit source code directly\. Nothing is rewritten, so there's\s*\n?\s*nothing for detection systems to spot\./,
    );
  });

  it('R12 "Indistinguishable from a real iPhone." giant-headline framing (plain-English replacement for the prior "Bit-identical" jargon) + iPhone 16 Pro / iOS 18.7 / Safari 26.4 reference + launch-blocking-bug fidelity commitment', () => {
    expect(body).toMatch(/Indistinguishable from a real iPhone\./);
    expect(body).toMatch(/iPhone 16 Pro, iOS 18\.7, Safari 26\.4/);
    expect(body).toMatch(
      /If any\s*\n?\s*measurable signal differs from what that phone sends, we treat\s*\n?\s*it as a launch-blocking bug/,
    );
  });

  it('R12 Stack framing: "Apple\'s engine. Not a Chromium copy." headline replaces the prior "Real WebKit. Real Core Text. Real iOS rendering." copy. Still preserves the Not-Chromium / Not-Playwright contrast + names WebKit / Core Text / iOS rendering pipeline downstream', () => {
    expect(body).toMatch(/Apple's engine\. Not a Chromium copy\./);
    expect(body).toMatch(/Chromium fork with a\s*\n?\s*fake user-agent/);
    expect(body).toMatch(/Playwright with a patch plugin layered on/);
    expect(body).toMatch(
      /WebKit, Core Text, and\s*\n?\s*the iOS rendering pipeline produce your fingerprint the way\s*\n?\s*Apple wrote them, in the order Apple intended\./,
    );
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

  it('R12 Concurrent metering framing pinned: "One metric. Concurrent sessions. That\'s it." headline + per-line anti-pattern callouts (No per-call markup. No per-element fees. No hourly metering...) + 200-pages-on-one-session concrete example — replaces the prior "Pay per concurrent session, not per call." copy', () => {
    expect(body).toMatch(/One metric\. Concurrent sessions\. That's it\./);
    expect(body).toMatch(/No\s*\n?\s*per-call markup\. No per-element fees\./);
    expect(body).toMatch(
      /No hourly metering that\s*\n?\s*turns idle sessions into surprise overage charges\./,
    );
    expect(body).toMatch(/Visit\s*\n?\s*200 pages on one session for the cost of visiting one\./);
  });

  it('R12 EU compliance framing pinned: "Customer data stays in the EU." headline + named "Hetzner Falkenstein, Neon EU, and Cloudflare R2" stack + "We log session metadata only" commitment + customer-configurable egress roadmap — replaces the prior "EU-resident infrastructure." + "All customer data … sits in the EU" copy', () => {
    expect(body).toMatch(/Customer data stays in the EU\./);
    expect(body).toMatch(/Hetzner\s*\n?\s*Falkenstein, Neon EU, and Cloudflare R2/);
    expect(body).toMatch(/We log\s*\n?\s*session metadata only/);
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

  it('R12 use-case section pinned: "Anywhere mobile Safari fidelity decides the outcome." headline + 3-card Mobile-Safari coverage / Mobile-first scraping / Multi-account operations — replaces the prior "Anywhere a real iPhone Safari fingerprint matters." headline', () => {
    expect(body).toMatch(/Anywhere mobile Safari fidelity decides the outcome\./);
    expect(body).toMatch(/Mobile-Safari coverage/);
    expect(body).toMatch(/Mobile-first scraping/);
    expect(body).toMatch(/Multi-account operations/);
  });

  it('R12 final-CTA pinned: "See it for yourself. $2.99." headline + Read the docs secondary CTA — replaces the prior "Try Driftstack for $2.99." copy', () => {
    expect(body).toMatch(/See it for yourself\. \$2\.99\./);
    expect(body).toMatch(/Read the docs/);
    expect(body).toMatch(/<a href="https:\/\/docs\.driftstack\.dev" class="btn-secondary">/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
