// W370.A — drift guard for marketing-site /changelog page
// content. Existing changelog-category-baseline + changelog-
// freshness-baseline + changelog-ordering-parity tests cover
// shape and ordering. This guard pins the load-bearing
// customer-facing claims that anchor specific entries:
//
//   • 6 canonical categories present in CATEGORY_COLOR map
//     (launch / sdk / docs / security / pricing / self-hosted).
//     A schema add without an entry produces a runtime undefined.
//   • Each entry uses one of those 6 categories (no orphan
//     category strings).
//   • Two-ladder pricing entry pinned with verbatim prices
//     (Manual $79 / $249 / $699; API $149 / $499 / $1,499 +
//     Enterprise + free entry tier below both ladders).
//   • Free-tier launch entry pinned (perpetual free tier
//     replaces the one-time trial pack).
//   • Live crypto-checkout entry pinned with the supported currencies,
//     payment processor, webhook events, and default Stripe rail.
//   • TOTP-MFA entry pinned: 10 single-use recovery codes,
//     15-minute step-up window for disable, challenge-token
//     architecture.
//   • Webhook signing-secret-rotation 24h grace window pinned
//     ↔ matches /security V-359 rotation contract.
//   • "Engineering-internal lives in the verification log"
//     scoping framing — explains what changelog IS NOT.
//   • Subscribe affordance: hello@driftstack.dev with rough
//     "every 2-4 weeks; only material changes" cadence.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W370.A marketing-site /changelog page content parity', () => {
  const body = read(PAGE);

  it('6 canonical CATEGORY_COLOR keys (launch / sdk / docs / security / pricing / self-hosted)', () => {
    const block = body.match(/CATEGORY_COLOR: Record<[^>]+> = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const keys = Array.from(block![1]!.matchAll(/(?:'([a-z\-]+)'|([a-z]+)):/g)).map(
      (m) => (m[1] ?? m[2]) as string,
    );
    expect(keys.sort()).toEqual(['docs', 'launch', 'pricing', 'sdk', 'security', 'self-hosted']);
  });

  it('every ChangelogEntry uses one of the 6 canonical categories (no orphan strings)', () => {
    const allowed = new Set(['launch', 'sdk', 'docs', 'security', 'pricing', 'self-hosted']);
    const found = Array.from(body.matchAll(/category: '([a-z\-]+)'/g)).map((m) => m[1] as string);
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      expect(allowed.has(c), `unexpected category: ${c}`).toBe(true);
    }
  });

  it('two-ladder pricing entry pinned exactly (Manual $79/$249/$699 + API $149/$499/$1,499 + Enterprise + free entry tier)', () => {
    expect(body).toMatch(
      /Manual \(\$79\/mo Solo \/ \$249\/mo Team \/ \$699\/mo Agency\) and API \(\$149\/mo Starter \/ \$499\/mo Builder \/ \$1,499\/mo Scale \+ custom Enterprise\)\. A free entry tier sits below both plan families\./,
    );
  });

  it('free-tier launch entry pinned (perpetual free tier replaces the one-time trial pack)', () => {
    expect(body).toMatch(/Perpetual free tier replaces the one-time trial pack/);
    expect(body).toMatch(/The entry tier is now a perpetual free tier: \$0 forever/);
    expect(body).toMatch(/This replaces the previous one-time \$2\.99 trial pack entirely\./);
  });

  it('live crypto checkout entry pins processor, currencies, events, and default rail', () => {
    expect(body).toContain('Crypto checkout is live for paid plans'); // 2026-09-15: "self-serve paid tiers" → "paid plans"
    expect(body).toContain('BTC, LTC, USDT, USDC, ETH, or XMR through NowPayments');
    expect(body).toContain('crypto.order.paid and crypto.order.failed');
    expect(body).toContain('Stripe remains the default way to pay');
  });

  it('TOTP-MFA entry pinned: 10 single-use recovery codes + 15-min step-up + challenge-token arch', () => {
    expect(body).toMatch(/10 single-use recovery codes/);
    expect(body).toMatch(/15-minute step-up window/);
    expect(body).toMatch(/Sign-in then issues a challenge token instead of a session/);
  });

  it('webhook signing-secret 24h-grace rotation entry pinned (matches V-359 contract)', () => {
    expect(body).toMatch(/old secret stays valid for 24 hours/);
    expect(body).toMatch(
      /Driftstack dual-signs every outbound delivery during the grace inside the single x-driftstack-signature header \(t=…,v1=<new>,v1=<old>\)/,
    );
  });

  it('"Engineering-internal lives in verification log" scope framing pinned', () => {
    expect(body).toMatch(
      /Internal engineering changes\s+\(code restructuring, test tooling, monitoring work\) are\s+tracked in our internal logs, not here/, // S20c 2026-07-06: same customer-facing-only scope, plain words,
    );
  });

  it('subscribe affordance pinned: hello@driftstack.dev + "roughly every 2-4 weeks" cadence', () => {
    expect(body).toContain('mailto:hello@driftstack.dev?subject=Changelog%20subscribe');
    expect(body).toMatch(
      /Roughly one email\s+every 2-4 weeks; only material changes \(no internal-noise\s+spam\)/,
    );
  });

  it("public status-page entry pinned (independent surface: control-plane outage doesn't take it down)", () => {
    expect(body).toMatch(/Public status page at status\.driftstack\.io/);
    // 2026-09-15: "control-plane" is banned on customer surfaces.
    expect(body).toMatch(
      /runs separately from api\.driftstack\.dev, so it stays up even if the API is down/,
    );
  });

  it('GDPR Article 20 audit-log export entry pinned (CSV / JSON + 10K-row ceiling + cursor)', () => {
    expect(body).toMatch(/GDPR Article 20 portability/);
    expect(body).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(body).toMatch(
      /Up to 10,000 rows per export; beyond that, page through the rest with a cursor/,
    );
  });

  it('entries in reverse-chronological order (newest first)', () => {
    const dates = Array.from(body.matchAll(/date: '(\d{4}-\d{2}-\d{2})'/g)).map(
      (m) => m[1] as string,
    );
    expect(dates.length).toBeGreaterThan(5);
    for (let i = 1; i < dates.length; i++) {
      expect(
        dates[i]!.localeCompare(dates[i - 1]!),
        `out of order: ${dates[i - 1]} → ${dates[i]}`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('time tag uses ISO date in datetime attribute (machine-readable changelog)', () => {
    expect(body).toMatch(/<time class="font-mono text-xs text-tk-ink-3" datetime=\{entry\.date\}/);
  });

  it('2026-09-15 summer round-up pinned: only July-or-later work under the window, the June work (VPN + HTTP proxy editors, Trim) in the never-announced list, HTTP/3 indicator green only when measured, dated readings, and the scoped Approve / Deny, OAuth and sign-in sentences', () => {
    expect(body).toMatch(/title: 'What shipped this summer',/);
    const entry = body.match(/date: '2026-09-15',[\s\S]*?body: '([\s\S]*?)',\n/)?.[1] ?? '';
    expect(entry.length).toBeGreaterThan(0);
    // Refuter 2026-09-15: the VPN / HTTP proxy editors (2026-06-16/17
    // 2fc819b2c, 14e4a83bb) and Trim (2026-06-25 f4c493465) predate the
    // July window, so they sit after the never-announced marker; the .ovpn
    // screening (2026-09-07 c8b03c2a8), Activity panel (2026-09-05
    // 612a88034), measured-HTTP/3 chip (2026-09-03 3d96c72d0) and dated
    // readings (2026-09-15 e2def2e1e) stay under the window.
    expect(entry).toMatch(
      /^A round-up of what landed between July and mid-September, followed by a list of what has been in the product for a while and was never announced here\./,
    );
    const marker = entry.indexOf('Also in the product for a while, though never announced here:');
    expect(marker).toBeGreaterThan(0);
    const summer = entry.slice(0, marker);
    const older = entry.slice(marker);
    expect(summer).toContain('an OpenVPN file is now screened before it is saved');
    expect(summer).toContain('the new Activity panel on a profile');
    expect(summer).toContain(
      'the HTTP/3 indicator turns green only when HTTP/3 was actually measured through that exit',
    );
    expect(summer).toContain('a reading we cannot date is no longer shown as if it were current');
    // Second refuter pass 2026-09-15: the exit's country and city were on
    // the Test readout from 2026-06-21 (c593b6da9 — ProxiesView renders
    // exit.city / .country), so only latency (2026-08-24 690b19461) is new
    // under the window; the exit is framed as what the readout already
    // showed, never as summer work.
    expect(summer).toContain(
      'The Test button on a proxy now also reports its latency, next to what it already showed — whether it is reachable and authenticated, whether it can carry UDP (which is what WebRTC needs) and the country and city it exits from',
    );
    expect(summer).not.toMatch(
      /now also reports its latency and the exit|reports .{0,40}the exit\\'s location/,
    );
    expect(summer).not.toMatch(
      /OpenVPN \(\.ovpn file\) or WireGuard \(\.conf file\) tunnel|Trim reclaims/,
    );
    expect(older).toContain(
      'OpenVPN (.ovpn file) or WireGuard (.conf file) tunnel as well as a SOCKS5 or HTTP proxy',
    );
    expect(older).toContain(
      'on a proxy that cannot carry HTTP/3, it is switched off rather than leaked',
    );
    expect(older).toContain('Trim reclaims space by clearing a profile');
    // apps/server/src/services/agent-consequential-action.ts: a keyword
    // heuristic on buy / pay / delete-account button text, not "any action
    // with real-world consequences".
    expect(older).toContain(
      'an Approve or Deny pause before the AI agent taps a buy, pay or delete-account button',
    );
    // docs/oauth-apps: client registration is admin-gated (email request).
    expect(older).toContain(
      "OAuth 2.0 for an app that acts on a customer\\'s behalf (client registration on request)",
    );
    // apps/docs license-activation.md + FirstRunWizard: pasting a key stays
    // the documented fallback, so "never needs a pasted API key" was false.
    expect(older).toContain('a browser sign-in that creates and stores the desktop app');
    expect(older).toContain(
      'so you no longer need to paste an API key (pasting one remains available as a fallback)',
    );
    // Overclaims the 2026-09-15 truth sheets and the refuter rule out must
    // not appear on the page.
    expect(body).not.toMatch(
      /so nothing leaks|every interaction|identical for every|the same browser Apple ships|replay a recipe/i,
    );
    expect(body).not.toMatch(
      /never needs a pasted API key|real-world consequences|every iPhone from/i,
    );
  });

  it('2026-09-14 device-catalog entry pins the two published numbers (96 selectable / 81 verified) and the launch default', () => {
    expect(body).toMatch(/title: '96 device profiles, and two numbers we publish separately',/);
    // 2026-09-15 refuter: 19 models, not "every iPhone" (no SE / 16e / Air).
    expect(body).toContain(
      'The device catalog now spans 19 iPhone models, from the iPhone 13 to the 17 Pro Max',
    );
    expect(body).toContain('96 selectable device profiles');
    expect(body).toContain('renders the same way (81)');
    expect(body).toContain('The default for a new profile is iPhone 17 / iOS 18.7 / Safari 26.4');
  });

  it('2026-08-26 free-plan device entry pinned (iPhone 13 + 13 mini, enforced where you pick, catalog not hidden)', () => {
    expect(body).toMatch(/title: 'Free plan: iPhone 13 and iPhone 13 mini',/);
    expect(body).toContain('not by hiding the catalog');
    expect(body).toContain(
      'one profile, one session at a time, 20-minute sessions, no card required',
    );
  });

  it('cross-link to /docs resolves', () => {
    expect(body).toMatch(/href="\/docs\/"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs.astro'))).toBe(true);
  });
});
