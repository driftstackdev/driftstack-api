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
      /Manual \(\$79\/mo Solo \/ \$249\/mo Team \/ \$699\/mo Agency\) and API \(\$149\/mo Starter \/ \$499\/mo Builder \/ \$1,499\/mo Scale \+ custom Enterprise\)\. A free entry tier sits below both ladders\./,
    );
  });

  it('free-tier launch entry pinned (perpetual free tier replaces the one-time trial pack)', () => {
    expect(body).toMatch(/Perpetual free tier replaces the one-time trial pack/);
    expect(body).toMatch(/The entry tier is now a perpetual free tier: \$0 forever/);
    expect(body).toMatch(/This replaces the previous one-time \$2\.99 trial pack entirely\./);
  });

  it('live crypto checkout entry pins processor, currencies, events, and default rail', () => {
    expect(body).toContain('Crypto checkout is live for self-serve paid tiers');
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
    expect(body).toMatch(
      /independent of api\.driftstack\.dev so a control-plane outage does not take the status page down/,
    );
  });

  it('GDPR Article 20 audit-log export entry pinned (CSV / JSON + 10K-row ceiling + cursor)', () => {
    expect(body).toMatch(/GDPR Article 20 portability/);
    expect(body).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(body).toMatch(/10K-row ceiling per export with cursor pagination beyond/);
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

  it('cross-link to /docs resolves', () => {
    expect(body).toMatch(/href="\/docs\/"/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs.astro'))).toBe(true);
  });
});
