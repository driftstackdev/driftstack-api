// W500.C — drift guard for apps/marketing-site/src/pages/index.astro.
// Marketing homepage. Drift here either drops the WebKit C++ source
// modification framing (THE core technical differentiator) or breaks
// the canonical price points (which customers compare against the
// /pricing page and the customer-dashboard select-tier).
//
//   • Hero: 'iPhone Safari fingerprints. Without the runtime tells.'
//     + 'Most stealth browsers modify JavaScript at runtime.'
//   • WebKit C++ source modification framing.
//   • Bit-identical cumulative-rig 'never approximate' framing.
//   • Real WebKit / Real Core Text / Real iOS rendering framing.
//   • 2-button hero CTA: Get started — $2.99 + Download GUI client →
//     github.com/driftstackdev/driftstack-gui/releases.
//   • Trial pack '16 hours · 14-day window · used once per account.'
//   • Code example with archetype: 'iphone16pro_ios18_7_safari26_4'.
//   • Concurrent metering positioning ('only thing you pay for').
//   • EU-resident infra + customer-configurable egress roadmap
//     (SOCKS5/WireGuard/OpenVPN).
//   • Manual vs API 2-audience split: $79/$249/$699 Manual + 1/3/8
//     concurrent / $149/$499/$1,499 API + 2/8/24 concurrent.
//   • Self-hosted teaser 3-driver: privacy / volume / sovereignty.
//   • Pricing teaser: 'Two ladders. One trial pack to start.' +
//     20% annual savings.

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

  it("BaseLayout title='Driftstack' + SEO description: 'iPhone Safari fingerprints. Without the runtime tells. We modify WebKit's C++ source instead of patching JavaScript. $2.99 trial pack — 16 hours, used once per account.' — pinned so the SEO description covers the canonical positioning (iPhone Safari + runtime-tells claim + WebKit C++ + $2.99/16h/once-per-account) all in one description for search snippets", () => {
    expect(body).toMatch(
      /<BaseLayout\s*\n?\s*title="Driftstack"\s*\n?\s*description="iPhone Safari fingerprints\. Without the runtime tells\. We modify WebKit's C\+\+ source instead of patching JavaScript\. \$2\.99 trial pack — 16 hours, used once per account\."/,
    );
  });

  it("Hero tagline + H1: 'iPhone Safari fingerprints. Without the runtime tells.' (oxblood mono uppercase) + 'Most stealth browsers modify JavaScript at runtime.' (H1) + 'Detection vendors built their industry on catching exactly that.' (subheadline) — pinned so the canonical hero positioning (provocative-claim → why-detection-fails-our-competitors) survives (drift to dropping the runtime-tells tagline would lose THE core marketing hook)", () => {
    expect(body).toMatch(/iPhone Safari fingerprints\. Without the runtime tells\./);
    expect(body).toMatch(/Most stealth browsers modify JavaScript at runtime\./);
    expect(body).toMatch(/Detection vendors built their industry on catching exactly that\./);
  });

  it("WebKit C++ source modification framing pinned: 'We modify WebKit's C++ source instead. There's nothing at the JavaScript layer for detection to find — because nothing was changed there. The fingerprint your code reads is the fingerprint a real iPhone reads. Same engine, same primitives, same source of truth.' — pinned so THE core technical differentiator survives intact (drift to dropping any phrase would weaken the source-vs-runtime distinction the entire marketing strategy hangs on)", () => {
    expect(body).toMatch(
      /We modify WebKit's C\+\+ source instead\. There's nothing at the\s*\n?\s*JavaScript layer for detection to find — because nothing was\s*\n?\s*changed there\. The fingerprint your code reads is the\s*\n?\s*fingerprint a real iPhone reads\. Same engine, same primitives,\s*\n?\s*same source of truth\./,
    );
  });

  it("Cumulative-rig 'Bit-identical.' giant-headline framing pinned: 'Bit-identical.' + 'Validated against the reference iPhone 16 Pro on iOS 18.7 / Safari 26.4. Every measured signal returns the exact reference value — not approximate, not within tolerance. A signal either matches the reference, or we treat the gap as a launch-blocker bug.' — pinned so the 'binary parity, no percentages' commitment + the launch-blocker-bug stake-in-the-ground all survive (drift to soft language like 'high parity' would re-introduce the percentage-fudging marketing competitors do)", () => {
    expect(body).toMatch(/Bit-identical\./);
    expect(body).toMatch(
      /Validated against the reference iPhone 16 Pro on iOS 18\.7 \/ Safari\s*\n?\s*26\.4\. Every measured signal returns the exact reference value — not\s*\n?\s*approximate, not within tolerance\./,
    );
    expect(body).toMatch(
      /A signal either matches the\s*\n?\s*reference, or we treat the gap as a launch-blocker bug\./,
    );
  });

  it("Stack framing: 'Real WebKit. Real Core Text. Real iOS rendering.' + 'Not a Chromium fork with a user-agent swap. Not Playwright with stealth plugins layered on. Driftstack runs Apple's WebKit C++ source' — pinned so the differentiator-by-negation (NOT Chromium / NOT Playwright + stealth) + the 3-realness pillars (WebKit + Core Text + iOS rendering) both survive (drift to dropping the 'NOT' framing would weaken the comparative positioning)", () => {
    expect(body).toMatch(/Real WebKit\. Real Core Text\. Real iOS rendering\./);
    expect(body).toMatch(
      /Not a Chromium fork with a user-agent swap\. Not Playwright with stealth\s*\n?\s*plugins layered on\. Driftstack runs Apple's WebKit C\+\+ source/,
    );
  });

  it("Hero CTAs + trial-pack subline: 'Get started — $2.99' → /pricing#trial-pack (primary) + 'Download GUI client' → github.com/driftstackdev/driftstack-gui/releases (secondary) + '16 hours · 14-day window · used once per account.' subline — pinned so the 2-CTA conversion path + the trial-pack mechanic subline (16h / 14d / once) all survive (drift to dropping the GUI download would orphan the Manual ladder; drift to wrong github org would break the canonical reference)", () => {
    expect(body).toMatch(
      /<a href="\/pricing#trial-pack" class="btn-primary">Get started — \$2\.99<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev\/driftstack-gui\/releases" class="btn-secondary"\s*\n?\s*>Download GUI client<\/a/,
    );
    expect(body).toMatch(/16 hours · 14-day window · used once per account\./);
  });

  it("Code example contract: archetype: 'iphone16pro_ios18_7_safari26_4' + proxy: { type: 'wireguard', config: '...' } + session.navigate + session.waitForChallenge + session.interact({ tap: '#submit' }) + session.getState + session.destroy — pinned so the homepage code snippet stays consistent with the canonical SDK shape (drift to a different archetype slug would create marketing↔SDK divergence; drift to dropping wireguard would lose the proxy-config positioning)", () => {
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4',/);
    expect(body).toMatch(/proxy: \{ type: 'wireguard', config: '\.\.\.' \},/);
    expect(body).toMatch(/await session\.navigate\(\{ url: 'https:\/\/target\.example' \}\);/);
    expect(body).toMatch(/const challenge = await session\.waitForChallenge\(\);/);
    expect(body).toMatch(/await session\.interact\(\{ tap: '#submit' \}\);/);
    expect(body).toMatch(/await session\.destroy\(\);/);
  });

  it("Concurrent metering framing pinned: 'Pay per concurrent session, not per call.' + 'Concurrent = how many sessions run at the same time, like browser tabs you'd have open at once. That's the only thing we meter. Within your concurrent cap, run as many hours as you want — no per-call markup, no per-element fees, no hourly metering that turns idle browsers into surprise overage charges.' — pinned so the 3-anti-pattern framing (no per-call + no per-element + no hourly) stays explicit (drift to dropping would let prospects worry about hidden metering)", () => {
    expect(body).toMatch(/Pay per concurrent session, not per call\./);
    expect(body).toMatch(
      /no per-call markup, no\s*\n?\s*per-element fees, no hourly metering that turns idle browsers\s*\n?\s*into surprise overage charges\./,
    );
  });

  it("EU compliance framing pinned: 'Customer data hosted in the EU — compute, database, and object storage all in the EU jurisdiction. The control plane stores session metadata only; we never store destination response bodies. Session execution may run in supported regions outside the EU under SCCs and the EU-US Data Privacy Framework' + customer-configurable egress roadmap (SOCKS5 / WireGuard / OpenVPN) — pinned so the EU-by-default + SCCs/DPF + roadmap-BYO-egress all survive (drift would weaken the privacy posture pitch)", () => {
    expect(body).toMatch(
      /Customer data hosted in the EU — compute, database, and object\s*\n?\s*storage all in the EU jurisdiction\. The control plane stores\s*\n?\s*session metadata only; we never store destination response\s*\n?\s*bodies\./,
    );
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ WireGuard \/ OpenVPN\)\s*\n?\s*is on the roadmap/,
    );
  });

  it("Manual ladder framing: 'Solo Manual $79/mo · Team $249/mo · Agency $699/mo' + '1 / 3 / 8 concurrent sessions per tier' + 'Unlimited hours within your concurrent cap' — pinned so the Manual price-ladder + concurrent-cap-ladder stays consistent with /pricing + the customer-dashboard select-tier (drift would create cross-page price divergence)", () => {
    expect(body).toMatch(/Solo Manual \$79\/mo · Team \$249\/mo · Agency \$699\/mo/);
    expect(body).toMatch(/1 \/ 3 \/ 8 concurrent sessions per tier/);
    expect(body).toMatch(/Unlimited hours within your concurrent cap/);
  });

  it("API ladder framing: 'API Starter $149/mo · Builder $499/mo · Scale $1,499/mo' + '2 / 8 / 24 concurrent sessions per tier; Enterprise custom' + 'Bundled LLM, or bring your own Anthropic API key, for AI-driven sessions (Builder+)' — pinned so the API price-ladder + concurrent-cap + the Builder+ bundled-LLM-or-BYOK gating all survive (drift to claiming bundled-LLM on Starter would change the gating)", () => {
    expect(body).toMatch(/API Starter \$149\/mo · Builder \$499\/mo · Scale \$1,499\/mo/);
    expect(body).toMatch(/2 \/ 8 \/ 24 concurrent sessions per tier; Enterprise custom/);
    expect(body).toMatch(
      /Bundled LLM, or bring your own Anthropic API key, for AI-driven sessions\s+\(Builder\+\)/,
    );
  });

  it("Pricing teaser: 'Two ladders. One trial pack to start.' + 'Annual contracts save 20%' — pinned so the dual-ladder positioning + the 20% annual savings stay consistent with the FAQ (drift to a different savings percentage would create FAQ↔homepage divergence)", () => {
    expect(body).toMatch(/Two ladders\. One trial pack to start\./);
    expect(body).toMatch(/Annual\s*\n?\s*contracts save 20%\./);
  });

  it("Self-hosted teaser 3-driver list: 'Privacy-required workloads where session content must not leave your perimeter.' + 'Sustained high-concurrency operations where owned hardware costs less than equivalent cloud-tier subscriptions.' + 'Full data sovereignty over recordings, screenshots, and request artefacts.' — pinned so the 3-self-host-motivator list stays consistent with /self-hosted's 3-card 'When self-hosted makes sense' section (drift would create cross-page narrative divergence)", () => {
    expect(body).toMatch(
      /Privacy-required workloads where session content must not leave your perimeter\./,
    );
    expect(body).toMatch(
      /Sustained high-concurrency operations where owned hardware costs less than\s*\n?\s*equivalent cloud-tier subscriptions\./,
    );
    expect(body).toMatch(
      /Full data sovereignty over recordings, screenshots, and request artefacts\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
