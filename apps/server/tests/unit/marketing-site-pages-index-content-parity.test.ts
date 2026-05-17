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

  it("F-2 (Issue 4) BaseLayout title='Driftstack' + revised SEO description leads with 'Pixel-identical' outcome (drops 'Real iPhone Safari' implementation-leak claim) and lists API/SDK/GUI access paths", () => {
    expect(body).toMatch(
      /<BaseLayout\s*\n?\s*title="Driftstack"\s*\n?\s*description="Pixel-identical iPhone Safari sessions in the cloud\. Bit-identical canvas, WebGL, audio, and user-agent — no runtime patching, no stealth plugins, nothing for detection to find\. API, SDK, or GUI\. Try it for \$2\.99\."/,
    );
  });

  it('Hero copy 2026-05-16 founder rewrite — strong + fancy, two paragraphs collapsed to one, "pixel-identical" dropped. Two-line H1: "Indistinguishable iPhone Safari." (gradient-coloured span) + "Programmable from any language." Single sub-paragraph names Real WebKit, the canvas+WebGL hash match against millions of real iPhones, and the four access paths.', () => {
    expect(body).toMatch(/Indistinguishable iPhone Safari\./);
    expect(body).toMatch(/Programmable from any language\./);
    expect(body).toMatch(
      /Real WebKit — the engine every iPhone ships\. Canvas \+ WebGL\s*\n?\s*hashes match the millions of iPhones in the wild, not the\s*\n?\s*unique-per-session leak every Chromium-stealth API surfaces\./,
    );
    expect(body).toMatch(/Drive sessions from TypeScript, Python, Go, or the GUI\./);
    // Pre-rewrite framings must not return.
    expect(body).not.toMatch(/Pixel-identical iPhone Safari\. Cloud-hosted\. API, SDK, or GUI\./);
    expect(body).not.toMatch(/Spin up a session in seconds\. Drive it from TypeScript, Python,/);
    expect(body).not.toMatch(/Other API browsers patch JavaScript at runtime/);
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

  it("Hero CTAs + trial-pack subline (R5: 'Start for $2.99' + 'Why not Browserless?'). Tailwind classes match mobile-responsive full-width-on-mobile pattern (M.1: w-full sm:w-auto with centred text), so the buttons stack cleanly under 640px and the tap target spans the column.", () => {
    expect(body).toMatch(
      /<a href="\/pricing#trial-pack" class="btn-primary w-full text-center sm:w-auto">Start for \$2\.99<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/comparison" class="btn-secondary w-full text-center sm:w-auto">Why not Browserless\?<\/a>/,
    );
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

  it('F-5 (Issue 5 + 6) EU compliance framing: "Customer data stays in the EU." headline + single-region framing (vendor names moved to /trust/sub-processors per Issue 6) + "We log session metadata only" commitment + customer-configurable egress card no longer claims "on the roadmap" (Issue 5; the security.astro card retains its honest "not shipped today" disclaimer where the W499.D parity test gates on actual server source).', () => {
    expect(body).toMatch(/Customer data stays in the EU\./);
    expect(body).toMatch(
      /Database, object storage, and compute all run in the EU,\s*\n?\s*single-region\./,
    );
    expect(body).toMatch(/We log session metadata only/);
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)\s*\n?\s*— see/,
    );
    expect(body).not.toMatch(/Hetzner\s*\n?\s*Falkenstein, Neon EU, and Cloudflare R2/);
    expect(body).not.toMatch(/is on the roadmap/);
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
