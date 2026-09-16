// W375.B — drift guard for marketing-site /pricing/comparison
// page content. V-668. The spreadsheet-style deep-dive companion
// to the glanceable /pricing page. This guard pins the load-
// bearing data-binding claims that anchor sales evaluations:
//
//   • API_TIERS imported from ../../data/pricing.ts (same source
//     as /pricing — the two pages can't drift).
//   • V-668 framing: "Numbers come from the same data file the
//     live billing system uses — what you see here is what your
//     invoice will say."
//   • DIMENSIONS array: 3 canonical heading groups (Pricing /
//     Quotas / Features) with their canonical row labels.
//   • Tier-switching 4-card explainer: Upgrade mid-month /
//     Downgrade at renewal / Cancel any time / Annual vs monthly.
//   • "Annual ~20% off the monthly rate" claim aligned with
//     /faq + /pricing + /index.
//   • Profile-count-above-cap "readable but uncreatable" framing
//     pinned — load-bearing downgrade-mechanic claim.
//   • 30-day grace-period-recovery post-cancel framing matches
//     /trust/security-overview's account-deletion grace.
//   • ★-highlight cohort-signal disclaimer ("Not a sales push").
//   • mailto:sales@driftstack.dev custom-quote escape hatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/comparison.astro');
const PRICING_DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W375.B marketing-site /pricing/comparison page content parity', () => {
  const body = read(PAGE);

  it('API_TIERS imported from same data file as /pricing (no two-source-of-truth drift)', () => {
    expect(existsSync(PRICING_DATA)).toBe(true);
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
    expect(body).toMatch(/import type \{ LlmBilling \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
  });

  it('V-668 "same data file the live billing system uses" framing pinned', () => {
    expect(body).toMatch(/V-668 — per-tier comparison page/);
    // 2026-09-15 plain words: the customer-facing promise stays (what you
    // see is what you're billed); the data-file / billing-system mechanics
    // moved out of the copy and live in the V-668 doc-comment above.
    expect(body).toMatch(/These are the exact prices you'll be billed\./);
  });

  it('DIMENSIONS 3 heading groups + canonical row labels pinned', () => {
    // Headings in order.
    const headingMatches = body.match(/heading: '([^']+)'/g);
    expect(headingMatches).toEqual([
      "heading: 'Pricing'",
      "heading: 'Limits'",
      "heading: 'Features'",
    ]);
    // Pricing rows (S20b 2026-07-06 plain-language labels; the overage row
    // now renders 'None' instead of a bare dash so the no-overage fact
    // reads as a fact, not missing data).
    // 2026-09-16 readability pass — this is the page a first-time buyer bounces
    // from, so every LABEL is now a phrase a non-technical buyer reads without
    // a glossary. Same rows, same getters, same values: 'Monthly' → 'Monthly
    // price', the two annual rows say which is per-month and which is the
    // up-front total, the concurrency row carries the phrase /pricing defines,
    // 'Session hours' → 'Hours included', 'API and SDK access' → 'Access from
    // code (API and SDK)', 'VPN exits' → 'Your own VPN connection', 'Audience'
    // → 'Who this is for'.
    // 2026-09-16 (2nd pass) TRUTH re-pin: 'Yearly plan, price per month' read as
    // a payment option — on the yearly plan you cannot pay $199/mo, it is billed
    // up front for 12 months (the same page: "Annual billing is ~20% off the
    // monthly rate, paid up-front"). The label keeps the equivalence the old
    // 'Annual (monthly equivalent)' carried; the getter is unchanged.
    expect(body).toMatch(/label: 'Monthly price'/);
    expect(body).toMatch(/label: 'Yearly plan \(works out per month\)'/);
    expect(body).not.toMatch(/label: 'Yearly plan, price per month'/);
    expect(body).toMatch(/label: 'Yearly plan, paid up front'/);
    expect(body).toMatch(/label: 'Extra hourly charges \(overage\)'/);
    expect(body).toMatch(
      /t\.overagePerHourUsd === null \? 'None' : fmtUsd\(t\.overagePerHourUsd\)/,
    );
    // Quotas rows.
    expect(body).toMatch(/label: 'Saved profiles'/);
    expect(body).toMatch(/label: 'Sessions at the same time'/);
    expect(body).toMatch(/label: 'Hours included'/);
    expect(body).toMatch(/label: 'Device types'/);
    // Features rows.
    expect(body).toMatch(/label: 'AI agent'/);
    expect(body).toMatch(/label: 'Who this is for'/);
    expect(body).toMatch(/label: 'Support'/);
    // The one term the whole table turns on is explained in the hero, in the
    // same words the row label uses — a buyer never meets it undefined.
    // 2026-09-16 (2nd pass) TRUTH re-pin: the hero no longer claims this is the
    // row most plans differ by — the table's own data says otherwise (Agency and
    // API Builder both show 8, so 6 distinct values across 7 columns, while
    // price and profiles differ on every column). It is the row to look at
    // first because it is what each plan is priced on, which is the point the
    // sentence was making. "Other tools call it …" also disowned a term the
    // homepage still uses as Driftstack's own metric.
    expect(body).toMatch(
      /<strong class="text-tk-ink">Sessions at the same time<\/strong> is the\s+row to look at first — it is what each plan is priced on\./,
    );
    expect(body).not.toMatch(/row most plans differ by/);
    expect(body).toMatch(/it is also called\s+"concurrent sessions"/);
  });

  it('fmtAiAgent maps 3 LlmBilling values + "Not on this tier" fallback', () => {
    expect(body).toMatch(/case 'byok_only':\s*return 'BYOK only';/);
    expect(body).toMatch(/case 'byok_or_bundled':\s*return 'BYOK or bundled';/);
    expect(body).toMatch(/case 'byok_or_bundled_custom':\s*return 'BYOK or bundled \(custom\)';/);
    expect(body).toMatch(/if \(!aiAgent\) return 'Not on this tier';/);
  });

  it('tier-switching 4-card explainer pinned (Upgrade / Downgrade / Cancel / Annual-vs-monthly)', () => {
    expect(body).toMatch(
      /<h3 class="text-base font-semibold text-tk-ink">\s*Upgrade mid-month\s*<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-semibold text-tk-ink">\s*Downgrade at renewal\s*<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-semibold text-tk-ink">\s*Cancel any time\s*<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-semibold text-tk-ink">\s*Annual vs monthly\s*<\/h3>/,
    );
  });

  it('"Annual is ~20% off the monthly rate, paid up-front" claim pinned (matches /faq + /pricing)', () => {
    expect(body).toMatch(/Annual billing is ~20% off the monthly rate, paid up-front\./);
  });

  it('"more profiles than the lower tier allows: keep and view all, can\'t create new ones" downgrade framing pinned (S20b plain words, same mechanic)', () => {
    expect(body).toMatch(
      /If you have more profiles than\s+the lower tier allows, you keep and can view them all — you\s+just can't create new ones until you're back under the limit\./,
    );
  });

  it('"30 days after cancellation in case you come back, then delete on the DPA schedule" pinned (S20b plain words, same retention facts)', () => {
    expect(body).toMatch(
      /we keep your data for\s+30 days after cancellation in case you come back, then delete\s+it on the schedule promised in our data-processing agreement\s+\(DPA\)/,
    );
  });

  it('★-highlight disclaimer pinned ("Not a sales push") + the S20b BYOK/archetype/SLA footnote gloss', () => {
    // 2026-09-15 plain words: the inside-baseball disclaimer is gone; the
    // snapshot qualifier ("right now") survives.
    expect(body).toMatch(/★ = our most popular tier right now\./);
    expect(body).toMatch(/BYOK = bring your own key/);
    expect(body).toMatch(/SLA = the\s+reply time we commit to for support\./);
  });

  it('mailto:sales@driftstack.dev custom-quote escape hatch pinned (1-business-day quote)', () => {
    expect(body).toMatch(/mailto:sales@driftstack\.dev/);
    expect(body).toMatch(
      /Volume above the published tiers, keeping data longer than 30\s+days, or a contractual reply-time commitment \(SLA\) — email us\s+a rough picture of your usage and we'll quote in one business\s+day\./,
    );
  });

  it('cross-link back to /pricing glanceable view pinned (companion-page framing)', () => {
    // S20 2026-07-06: AA accent-text tone (raw accent measured 2.71:1 here).
    expect(body).toMatch(
      /<a href="\/pricing\/" class="text-tk-accent-text underline">\/pricing<\/a>/,
    );
    // 2026-09-16: "glanceable" is our word, not a buyer's.
    expect(body).toMatch(/Looking for the short version\?/);
    expect(body).not.toMatch(/Looking for the glanceable view\?/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('free-tier card uses data import for figures (not hardcoded; S20b: "evaluation tier" → "try-before-you-buy tier")', () => {
    expect(body).toMatch(/const freeTier = API_TIERS\.find\(\(t\) => t\.id === 'free'\);/);
    expect(body).toMatch(/Free \(\{fmtUsd\(freeTier\.monthlyUsd\)\}, forever\)/);
    expect(body).toMatch(/\{freeTier\.hoursLabel\} — a try-before-you-buy tier/);
  });

  // 2026-09-15 truth pass — the free card previously claimed "every iPhone
  // model, iOS version and Safari version we currently offer"; the free
  // entitlement is iPhone 13 + 13 mini (ARCHETYPE_DEVICES_PER_TIER), no API,
  // no VPN, no AI agent (TIER_FEATURES). The two gates now render as rows
  // from pricing.ts, and the device-breadth gloss binds to DEVICE_SUPPORT.
  it('free card states the real free shape (data-bound devices; no API/SDK, no VPN, no AI agent) and the old every-device claim is gone', () => {
    expect(body).not.toMatch(
      /Includes every iPhone model, iOS version and Safari\s*version we currently offer/,
    );
    expect(body).toMatch(
      /\{freeTier\.profiles\} profile, \{freeTier\.concurrent\} session\s*at a time, driven by hand in the desktop app, on the\s*\{freeTier\.archetypeAccess\}\./,
    );
    // 2026-09-15 refuter: the free tier's one proxy may be SOCKS5 or HTTP —
    // routes/account-me.ts gates only the openvpn/wireguard schemes.
    expect(body).not.toMatch(/\(one\s*SOCKS5 proxy of your own\)/);
    expect(body).toMatch(
      /No API or SDK access, no VPN \(one\s*SOCKS5 or HTTP proxy of your own\), and no AI agent\./,
    );
    // 2026-09-16: the semicolon splice became its own sentence — same claim.
    expect(body).toMatch(/The AI agent starts at\s*Team and is on every API tier\./);
  });

  it('Features group carries data-bound "API and SDK access" + "VPN exits" rows (pricing.ts apiAccess / vpnEgress) and the footnote binds the device-breadth gloss to DEVICE_SUPPORT', () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/\.\.\/data\/capabilities';/);
    expect(body).toMatch(
      /label: 'Access from code \(API and SDK\)',\s*get: \(t: \(typeof API_TIERS\)\[number\]\): string =>\s*t\.apiAccess \? 'Included' : 'Not on this tier',/,
    );
    // 2026-09-16 (2nd pass) re-pin: the label is a CAPABILITY, not a
    // possession. Paired with the getter's 'Included', 'Your own VPN
    // connection' read as "a VPN is included in the plan" — Driftstack does not
    // supply the VPN, the customer brings the config (/pricing: "let you use
    // your own VPN (OpenVPN or WireGuard) instead of a proxy"; faq.ts: exits
    // you supply). Values and getter deliberately unchanged.
    expect(body).toMatch(
      /label: 'Connect through your own VPN \(OpenVPN, WireGuard\)',\s*get: \(t: \(typeof API_TIERS\)\[number\]\): string =>\s*t\.vpnEgress \? 'Included' : 'SOCKS5 or HTTP proxy only',/,
    );
    expect(body).not.toMatch(/label: 'Your own VPN connection/);
    expect(body).not.toMatch(/'SOCKS5 proxy only'/);
    // 2026-09-15 refuter: 19 named models, never "every iPhone" (no SE / 16e / Air).
    expect(body).toMatch(
      /means 19 iPhone models, from the 13 to the 17 Pro Max\s*\(\{DEVICE_SUPPORT\.selectableCount\} device types\) on iOS 18, Safari\s*\{DEVICE_SUPPORT\.safariVersions\}\./,
    );
    expect(body).not.toMatch(/every iPhone from the 13 to the 17 Pro Max/i);
  });

  it('sticky-left row-label column header pinned (table-shape decision), and it says what the column is in plain words', () => {
    // Load-bearing UX choice — the row-label column stays visible
    // when the table scrolls horizontally on narrow screens.
    // 2026-09-16: "Dimension" is internal vocabulary; the header now says what
    // the column holds. The sticky behaviour it guards is unchanged.
    expect(body).toMatch(/sticky left-0 z-10[\s\S]*?>\s*What you're comparing\s*<\/th>/);
    expect(body).not.toMatch(/>\s*Dimension\s*<\/th>/);
    // The table now tells a first-time reader how to read it.
    expect(body).toMatch(
      /The left-hand column names what you're comparing; each column after it\s+is one plan\./,
    );
    expect(body).toMatch(/scroll the table sideways/);
  });
});
