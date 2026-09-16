// W503.A — drift guard for apps/marketing-site/src/pages/pricing/comparison.astro.
// V-668 per-tier comparison page — the spreadsheet-style deep-dive that
// sales evaluations need. Drift here either drops a dimension (would
// shrink the side-by-side surface) or breaks the 'same data file as
// the live billing system' commitment that's THE reason this page
// exists separately from /pricing.
//
//   • V-668 doc-comment framing.
//   • API_TIERS import + trialPack/paidTiers split.
//   • fmtAiAgent 4-state: not-on-tier / byok_only / byok_or_bundled /
//     byok_or_bundled_custom.
//   • DIMENSIONS 3-group taxonomy: Pricing (Monthly + Annual-mo-eq +
//     Annual-total + Overage/hour), Quotas (Profiles + Concurrent +
//     Hours + Archetype access), Features (AI agent + Audience +
//     Support).
//   • Trial pack standalone card.
//   • ★ highlight badge: 'team's most popular tier in active
//     evaluations. Not a sales push'.
//   • 4-card tier-switching mechanics: Upgrade mid-month + Downgrade
//     at renewal + Cancel any time + Annual vs monthly.
//   • Custom-quote CTA: mailto:sales@driftstack.dev + 'one business
//     day' commitment.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/comparison.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W503.A apps/marketing-site/src/pages/pricing/comparison.astro content parity', () => {
  const body = read(LIB);

  it("V-668 framing pinned: 'per-tier comparison page. The main /pricing page is a glanceable overview; /pricing/comparison is the spreadsheet-style deep dive sales evaluations actually need. Pulls every dimension directly from the same data file so the two pages can't drift.' — pinned so the V-668 doc-comment + the /pricing-vs-/pricing/comparison division-of-labor + the 'two pages can't drift' commitment all survive (drift to hardcoding would re-introduce divergence that V-668 was created to fix)", () => {
    expect(body).toMatch(
      /\/\/ V-668 — per-tier comparison page\. The main \/pricing page is a\s*\/\/ glanceable overview; \/pricing\/comparison is the spreadsheet-style\s*\/\/ deep dive sales evaluations actually need\. Pulls every dimension\s*\/\/ directly from the same data file so the two pages can't drift\./,
    );
  });

  it("API_TIERS import + freeTier/paidTiers split pinned — pinned so the 'derived from API_TIERS' single-source-of-truth + the free-tier-separate-from-paid-tiers data split survive (drift to hardcoding here would diverge from /pricing when the tier table changes; drift to dropping the free-tier split would mix the $0 evaluation tier into the recurring-pricing table)", () => {
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
    expect(body).toMatch(/const freeTier = API_TIERS\.find\(\(t\) => t\.id === 'free'\);/);
    expect(body).toMatch(/const paidTiers = API_TIERS\.filter\(\(t\) => t\.id !== 'free'\);/);
  });

  it("fmtAiAgent 4-state map: !aiAgent → 'Not on this tier' / byok_only → 'BYOK only' / byok_or_bundled → 'BYOK or bundled' / byok_or_bundled_custom → 'BYOK or bundled (custom)' — pinned so the per-tier AI-agent availability display strings stay consistent (drift to dropping 'Not on this tier' would lose the explicit-absence signal customers scan for; drift to dropping 'custom' on Enterprise would lose the dedicated-rate signal)", () => {
    expect(body).toMatch(/if \(!aiAgent\) return 'Not on this tier';/);
    expect(body).toMatch(/case 'byok_only':\s*return 'BYOK only';/);
    expect(body).toMatch(/case 'byok_or_bundled':\s*return 'BYOK or bundled';/);
    expect(body).toMatch(/case 'byok_or_bundled_custom':\s*return 'BYOK or bundled \(custom\)';/);
  });

  it("DIMENSIONS 3-group taxonomy: 'Pricing' + 'Quotas' + 'Features' — pinned so the 3-group comparison-table structure stays consistent (drift to merging groups would lose the buyer-mental-model split between $-questions / capacity-questions / feature-questions)", () => {
    expect(body).toMatch(/heading: 'Pricing',/);
    expect(body).toMatch(/heading: 'Limits',/);
    expect(body).toMatch(/heading: 'Features',/);
  });

  it("Pricing-group 4 rows: Monthly + Annual (monthly equivalent) + Annual total + Extra hourly charges (overage) — S20b 2026-07-06 plain-language label + the overage row now renders 'None' instead of a bare dash; pinned so the 4 pricing-dimensions stay complete (drift to dropping 'Annual (monthly equivalent)' would force buyers to do their own math; drift to dropping the overage row would hide overage exposure on hour-metered tiers)", () => {
    // 2026-09-16 readability pass — same four rows, same getters, labels a
    // non-technical buyer reads without a glossary: 'Monthly' → 'Monthly
    // price', and the two annual rows now say which one is the per-month
    // figure and which is the up-front total.
    // 2026-09-16 (2nd pass) TRUTH re-pin: 'Yearly plan, price per month' read as
    // a payment option, i.e. that the yearly plan is paid monthly. It is billed
    // up front for 12 months ("Annual billing is ~20% off the monthly rate,
    // paid up-front" on this page; faq.ts says the same). The label keeps the
    // equivalence 'Annual (monthly equivalent)' carried; getter unchanged.
    expect(body).toMatch(/label: 'Monthly price',/);
    expect(body).toMatch(/label: 'Yearly plan \(works out per month\)',/);
    expect(body).not.toMatch(/label: 'Yearly plan, price per month',/);
    expect(body).toMatch(/label: 'Yearly plan, paid up front',/);
    expect(body).toMatch(/label: 'Extra hourly charges \(overage\)',/);
    expect(body).toMatch(
      /t\.overagePerHourUsd === null \? 'None' : fmtUsd\(t\.overagePerHourUsd\)/,
    );
  });

  it("Quotas-group 4 rows: Saved profiles + Concurrent sessions + Session hours + Device types (archetypes) — S20b plain-language labels; pinned so the 4 quota-dimensions stay complete (drift to dropping the archetypes row would lose the per-tier device-mix differentiation; drift to dropping 'Session hours' would obscure the hour-metering boundary for the free column)", () => {
    // 2026-09-16: the concurrency row carries the same phrase /pricing defines
    // and the hero above this table explains; 'Session hours' says what the
    // 'Unlimited' in it means.
    expect(body).toMatch(/label: 'Saved profiles',/);
    expect(body).toMatch(/label: 'Sessions at the same time',/);
    expect(body).toMatch(/label: 'Hours included',/);
    expect(body).toMatch(/label: 'Device types',/);
    // 2026-09-16 (2nd pass) TRUTH re-pin: the superlative is gone. Agency and
    // API Builder both show 8 in this row (6 distinct values across 7 plan
    // columns), while price and profiles differ on every column — so it is not
    // the row most plans differ by. It IS the row each plan is priced on, which
    // is why a buyer should read it first.
    expect(body).toMatch(
      /<strong class="text-tk-ink">Sessions at the same time<\/strong> is the\s+row to look at first — it is what each plan is priced on\./,
    );
  });

  it("Features-group 3 rows: AI agent + Audience + Support — S20b: the '(bundled LLM)' label suffix moved into the footnote that now defines BYOK/bundled in plain words; pinned so the 3 feature-dimensions stay complete (drift to dropping 'Audience' would lose the use-case anchoring; drift to dropping 'Support' would hide the per-tier SLA escalation)", () => {
    expect(body).toMatch(/label: 'AI agent',/);
    // 2026-09-16: 'Audience' is a marketer's word for "who this is for".
    expect(body).toMatch(/label: 'Who this is for',/);
    expect(body).toMatch(/label: 'Support',/);
    expect(body).toMatch(/BYOK = bring your own key/);
  });

  it("Free-tier standalone card pinned: 'Free ({fmtUsd(freeTier.monthlyUsd)}, forever)' + 'a try-before-you-buy tier, no card required' (S20b plain words, same evaluate-before-committing positioning)", () => {
    expect(body).toMatch(/Free \(\{fmtUsd\(freeTier\.monthlyUsd\)\}, forever\)/);
    expect(body).toMatch(/a try-before-you-buy tier, no card\s*required/);
  });

  it("★ popular-tier framing pinned: '★ = team's most popular tier in active evaluations. Not a sales push — just what prospective customers are picking right now.' (S20b: 'cohort signal' reworded plain) — pinned so the honest 'data signal, not sales pressure' framing survives (drift to dropping 'Not a sales push' would let the highlight read as upsell rather than data signal)", () => {
    // 2026-09-15 plain words — disclaimer dropped, snapshot qualifier kept.
    expect(body).toMatch(/★ = our most popular tier right now\./);
  });

  it("4-card tier-switching mechanics: 'Upgrade mid-month' (immediate + prorate) + 'Downgrade at renewal' (end-of-period + readable-but-uncreatable) + 'Cancel any time' (end-of-period + 30-day-data-retention) + 'Annual vs monthly' (~20% off + monthly→annual instant / annual→monthly at term end) — pinned so the 4 tier-switching policies stay consistent (drift to dropping 'readable but uncreatable' on downgrade would surprise customers when profile-creation hits the tier cap; drift to changing the 30-day-data-retention would create marketing↔DPA divergence)", () => {
    // S20b 2026-07-06 plain words — all 4 policies still asserted with the
    // same facts (proration, keep-but-can't-create on downgrade, 30-day
    // retention then DPA-schedule deletion, ~20% annual).
    expect(body).toMatch(/Upgrade mid-month/);
    expect(body).toMatch(
      /Switching to a higher tier is immediate\. You pay only the\s*difference for the rest of the billing period; the next\s*invoice reflects the upgrade\./,
    );
    expect(body).toMatch(/Downgrade at renewal/);
    expect(body).toMatch(
      /If you have more profiles than\s*the lower tier allows, you keep and can view them all — you\s*just can't create new ones until you're back under the limit\./,
    );
    expect(body).toMatch(/Cancel any time/);
    expect(body).toMatch(
      /we keep your data for\s*30 days after cancellation in case you come back, then delete\s*it on the schedule promised in our data-processing agreement\s*\(DPA\)\./,
    );
    expect(body).toMatch(/Annual vs monthly/);
    expect(body).toMatch(/Annual billing is ~20% off the monthly rate, paid up-front\./);
  });

  it("Custom-quote CTA pinned: 'Need a custom quote?' + 'we'll quote in one business day.' + mailto:sales@driftstack.dev — pinned so the enterprise-quote escalation + the one-business-day commitment + the sales-team routing survive (drift to dropping the 'one business day' SLA would let prospects expect indefinite waits; drift to dropping the sales@ address would orphan the inbound)", () => {
    expect(body).toMatch(/Need a custom quote\?/);
    expect(body).toMatch(/we'll quote in one business\s*day\./);
    expect(body).toMatch(
      /<a href="mailto:sales@driftstack\.dev" class="btn-primary">Email sales<\/a>/,
    );
  });

  it("Cross-link to glanceable /pricing pinned: 'Looking for the glanceable view? /pricing has the headline cards.' — pinned so the back-link to the glanceable page survives (drift to dropping would orphan buyers who land on /pricing/comparison first and want the simpler overview)", () => {
    // 2026-09-16: "glanceable" is our word, not a buyer's — same link, same
    // companion-page framing, in words a first-time visitor reads.
    expect(body).toMatch(
      /Looking for the short version\?\s*<a href="\/pricing\/" class="text-tk-accent-text underline">\/pricing<\/a>\s*has the headline cards\./,
    );
    expect(body).not.toMatch(/href="\/pricing"/);
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
    // 2026-09-16 (2nd pass) re-pin: label as capability, not possession. With
    // the getter's 'Included', 'Your own VPN connection' rendered as "Your own
    // VPN connection — Included", which a first-time buyer reads as "a VPN is
    // included in the plan". Driftstack does not supply the VPN; the customer
    // brings the config. Values and getter deliberately unchanged.
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

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
