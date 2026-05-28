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
      /\/\/ V-668 — per-tier comparison page\. The main \/pricing page is a\s*\n?\s*\/\/ glanceable overview; \/pricing\/comparison is the spreadsheet-style\s*\n?\s*\/\/ deep dive sales evaluations actually need\. Pulls every dimension\s*\n?\s*\/\/ directly from the same data file so the two pages can't drift\./,
    );
  });

  it("API_TIERS import + freeTier/paidTiers split pinned — pinned so the 'derived from API_TIERS' single-source-of-truth + the free-tier-separate-from-paid-tiers data split survive (drift to hardcoding here would diverge from /pricing when the tier table changes; drift to dropping the free-tier split would mix the $0 evaluation tier into the recurring-pricing table)", () => {
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
    expect(body).toMatch(/const freeTier = API_TIERS\.find\(\(t\) => t\.id === 'free'\);/);
    expect(body).toMatch(/const paidTiers = API_TIERS\.filter\(\(t\) => t\.id !== 'free'\);/);
  });

  it("fmtAiAgent 4-state map: !aiAgent → 'Not on this tier' / byok_only → 'BYOK only' / byok_or_bundled → 'BYOK or bundled' / byok_or_bundled_custom → 'BYOK or bundled (custom)' — pinned so the per-tier AI-agent availability display strings stay consistent (drift to dropping 'Not on this tier' would lose the explicit-absence signal customers scan for; drift to dropping 'custom' on Enterprise would lose the dedicated-rate signal)", () => {
    expect(body).toMatch(/if \(!aiAgent\) return 'Not on this tier';/);
    expect(body).toMatch(/case 'byok_only':\s*\n?\s*return 'BYOK only';/);
    expect(body).toMatch(/case 'byok_or_bundled':\s*\n?\s*return 'BYOK or bundled';/);
    expect(body).toMatch(
      /case 'byok_or_bundled_custom':\s*\n?\s*return 'BYOK or bundled \(custom\)';/,
    );
  });

  it("DIMENSIONS 3-group taxonomy: 'Pricing' + 'Quotas' + 'Features' — pinned so the 3-group comparison-table structure stays consistent (drift to merging groups would lose the buyer-mental-model split between $-questions / capacity-questions / feature-questions)", () => {
    expect(body).toMatch(/heading: 'Pricing',/);
    expect(body).toMatch(/heading: 'Quotas',/);
    expect(body).toMatch(/heading: 'Features',/);
  });

  it("Pricing-group 4 rows: Monthly + Annual (monthly equivalent) + Annual total + Overage / hour — pinned so the 4 pricing-dimensions stay complete (drift to dropping 'Annual (monthly equivalent)' would force buyers to do their own math; drift to dropping 'Overage / hour' would hide overage exposure on hour-metered tiers)", () => {
    expect(body).toMatch(/label: 'Monthly',/);
    expect(body).toMatch(/label: 'Annual \(monthly equivalent\)',/);
    expect(body).toMatch(/label: 'Annual total',/);
    expect(body).toMatch(/label: 'Overage \/ hour',/);
  });

  it("Quotas-group 4 rows: Persistent profiles + Concurrent sessions + Session hours + Archetype access — pinned so the 4 quota-dimensions stay complete (drift to dropping 'Archetype access' would lose the per-tier device-mix differentiation; drift to dropping 'Session hours' would obscure the hour-metering boundary for the trial-pack column)", () => {
    expect(body).toMatch(/label: 'Persistent profiles',/);
    expect(body).toMatch(/label: 'Concurrent sessions',/);
    expect(body).toMatch(/label: 'Session hours',/);
    expect(body).toMatch(/label: 'Archetype access',/);
  });

  it("Features-group 3 rows: AI agent (bundled LLM) + Audience + Support — pinned so the 3 feature-dimensions stay complete (drift to dropping 'Audience' would lose the use-case anchoring; drift to dropping 'Support' would hide the per-tier SLA escalation)", () => {
    expect(body).toMatch(/label: 'AI agent \(bundled LLM\)',/);
    expect(body).toMatch(/label: 'Audience',/);
    expect(body).toMatch(/label: 'Support',/);
  });

  it("Free-tier standalone card pinned: 'Free ({fmtUsd(freeTier.monthlyUsd)}, forever)' + 'evaluation tier, no card required, before committing to a paid tier' — pinned so the free-tier-as-separate-evaluation-tier framing survives (drift to merging it into the paid-tier table would lose the 'evaluate before committing' positioning)", () => {
    expect(body).toMatch(/Free \(\{fmtUsd\(freeTier\.monthlyUsd\)\}, forever\)/);
    expect(body).toMatch(/evaluation tier, no card required/);
  });

  it("★ popular-tier framing pinned: '★ = team's most popular tier in active evaluations. Not a sales push — just the current cohort signal.' — pinned so the honest 'cohort signal, not sales pressure' framing survives (drift to dropping 'Not a sales push' would let the highlight read as upsell rather than data signal)", () => {
    expect(body).toMatch(
      /★ = team's most popular tier in active evaluations\. Not a sales\s*\n?\s*push — just the current cohort signal\./,
    );
  });

  it("4-card tier-switching mechanics: 'Upgrade mid-month' (immediate + prorate) + 'Downgrade at renewal' (end-of-period + readable-but-uncreatable) + 'Cancel any time' (end-of-period + 30-day-data-retention) + 'Annual vs monthly' (~20% off + monthly→annual instant / annual→monthly at term end) — pinned so the 4 tier-switching policies stay consistent (drift to dropping 'readable but uncreatable' on downgrade would surprise customers when profile-creation hits a 402; drift to changing the 30-day-data-retention would create marketing↔DPA divergence)", () => {
    expect(body).toMatch(/Upgrade mid-month/);
    expect(body).toMatch(
      /Switching to a higher tier is immediate\. We prorate the\s*\n?\s*remaining billing-period at the new tier's rate/,
    );
    expect(body).toMatch(/Downgrade at renewal/);
    expect(body).toMatch(
      /Profile counts above the new\s*\n?\s*tier's cap stay readable but become uncreatable\./,
    );
    expect(body).toMatch(/Cancel any time/);
    expect(body).toMatch(
      /we keep your data for\s*\n?\s*30 days post-cancel for grace-period recovery, then delete\s*\n?\s*per our DPA terms\./,
    );
    expect(body).toMatch(/Annual vs monthly/);
    expect(body).toMatch(/Annual billing is ~20% off the monthly rate, paid up-front\./);
  });

  it("Custom-quote CTA pinned: 'Need a custom quote?' + 'we'll quote in one business day.' + mailto:sales@driftstack.dev — pinned so the enterprise-quote escalation + the one-business-day commitment + the sales-team routing survive (drift to dropping the 'one business day' SLA would let prospects expect indefinite waits; drift to dropping the sales@ address would orphan the inbound)", () => {
    expect(body).toMatch(/Need a custom quote\?/);
    expect(body).toMatch(/we'll quote in one business day\./);
    expect(body).toMatch(
      /<a href="mailto:sales@driftstack\.dev" class="btn-primary">Email sales<\/a>/,
    );
  });

  it("Cross-link to glanceable /pricing pinned: 'Looking for the glanceable view? /pricing has the headline cards.' — pinned so the back-link to the glanceable page survives (drift to dropping would orphan buyers who land on /pricing/comparison first and want the simpler overview)", () => {
    expect(body).toMatch(
      /Looking for the glanceable view\?\s*\n?\s*<a href="\/pricing" class="text-oxblood-700 underline">\/pricing<\/a>\s*\n?\s*has the headline cards\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
