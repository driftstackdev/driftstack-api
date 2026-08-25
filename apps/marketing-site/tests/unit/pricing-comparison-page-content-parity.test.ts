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
    expect(body).toMatch(
      /Numbers come from the same data file the live billing\s+system uses — what you see here is what your invoice will say\./,
    );
  });

  it('DIMENSIONS 3 heading groups + canonical row labels pinned', () => {
    // Headings in order.
    const headingMatches = body.match(/heading: '([^']+)'/g);
    expect(headingMatches).toEqual([
      "heading: 'Pricing'",
      "heading: 'Quotas'",
      "heading: 'Features'",
    ]);
    // Pricing rows (S20b 2026-07-06 plain-language labels; the overage row
    // now renders 'None' instead of a bare dash so the no-overage fact
    // reads as a fact, not missing data).
    expect(body).toMatch(/label: 'Monthly'/);
    expect(body).toMatch(/label: 'Annual \(monthly equivalent\)'/);
    expect(body).toMatch(/label: 'Annual total'/);
    expect(body).toMatch(/label: 'Extra hourly charges \(overage\)'/);
    expect(body).toMatch(
      /t\.overagePerHourUsd === null \? 'None' : fmtUsd\(t\.overagePerHourUsd\)/,
    );
    // Quotas rows.
    expect(body).toMatch(/label: 'Saved profiles'/);
    expect(body).toMatch(/label: 'Concurrent sessions'/);
    expect(body).toMatch(/label: 'Session hours'/);
    expect(body).toMatch(/label: 'Device types \(archetypes\)'/);
    // Features rows.
    expect(body).toMatch(/label: 'AI agent'/);
    expect(body).toMatch(/label: 'Audience'/);
    expect(body).toMatch(/label: 'Support'/);
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
    expect(body).toMatch(
      /★ = team's most popular tier in active evaluations\. Not a sales\s+push — just what prospective customers are picking right now\./,
    );
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
    expect(body).toMatch(/Looking for the glanceable view\?/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('free-tier card uses data import for figures (not hardcoded; S20b: "evaluation tier" → "try-before-you-buy tier")', () => {
    expect(body).toMatch(/const freeTier = API_TIERS\.find\(\(t\) => t\.id === 'free'\);/);
    expect(body).toMatch(/Free \(\{fmtUsd\(freeTier\.monthlyUsd\)\}, forever\)/);
    expect(body).toMatch(/\{freeTier\.hoursLabel\} — a try-before-you-buy tier/);
  });

  it('sticky-left "Dimension" column header pinned (table-shape decision)', () => {
    // Load-bearing UX choice — the dimension column stays visible
    // when the table scrolls horizontally on narrow screens.
    expect(body).toMatch(/sticky left-0 z-10[\s\S]*?>\s*Dimension\s*<\/th>/);
  });
});
