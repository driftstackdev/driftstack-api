// Drift guard for apps/marketing-site/src/data/pricing.ts — the
// single source of truth for marketing-site tier pricing. Pins the
// canonical price points across the 7 customer-facing tiers + the
// trial pack + the LlmBilling discriminator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tierBlockIn } from './_helpers/pricing-tiers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('marketing-site data/pricing content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('ADR-004 + V-073 cross-source contract pinned: pricing.ts must agree with sessions.ts (TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER). Drift would create marketing↔server divergence on the load-bearing price-to-cap mapping', () => {
    expect(body).toMatch(/Per ADR-004 \(two-ladder concurrent-only restructure/);
    expect(body).toMatch(/Backend equivalent at apps\/server\/src\/services\/sessions\.ts/);
    expect(body).toMatch(/Both layers must agree on tier ids \+ concurrent caps \+ profile/);
  });

  it("TierType discriminator pinned: 'free' | 'manual' | 'api' (trial→free 2026-05-27). Drift to dropping any would break the two-ladder pricing-page section grouping", () => {
    expect(body).toMatch(/export type TierType = 'free' \| 'manual' \| 'api';/);
  });

  it('LlmBilling discriminator pinned: byok_only | byok_or_bundled | byok_or_bundled_custom | null. Drift to dropping a variant would break the agent-LLM tier-gating UI on /pricing', () => {
    expect(body).toMatch(
      /export type LlmBilling = 'byok_only' \| 'byok_or_bundled' \| 'byok_or_bundled_custom' \| null;/,
    );
  });

  it('free-tier pricing pinned: $0 + perpetual + 1 profile + 1 concurrent + community-support + Evaluation audience (trial_pack retired 2026-05-27)', () => {
    expect(body).toMatch(/id: 'free',/);
    expect(body).toMatch(/monthlyUsd: 0,/);
    expect(body).toMatch(/oneTime: false,/);
    expect(body).toMatch(/profiles: 1,/);
    expect(body).toMatch(/hoursLabel: '20-minute sessions',/);
  });

  it('Manual-ladder 3-tier price points pinned: $79 / $249 / $699 (Solo / Team / Agency). Drift would break ALL three pricing-page rows AND the changelog 2026-05-03 two-ladder-pricing entry', () => {
    expect(body).toMatch(/name: 'Personal',\s*\n?\s*monthlyUsd: 79,/);
    expect(body).toMatch(/name: 'Team',\s*\n?\s*monthlyUsd: 249,/);
    expect(body).toMatch(/monthlyUsd: 699,/);
  });

  it('Personal concurrent=1 + 10 profiles pinned: the tier-defining caps. Drift would break the price-to-concurrent ratio that defines the tier ladder shape', () => {
    expect(tierBlockIn(body, 'solo_manual')).toMatch(/profiles: 10,[\s\S]*?concurrent: 1,/);
  });

  it("Team highlight=true pinned (the recommended Manual-tier): drift would shift the dashboard's highlighted recommendation, which affects conversion rate on the pricing page", () => {
    expect(tierBlockIn(body, 'team_manual')).toMatch(/highlight: true,/);
  });

  it("Team aiAgent + llmBilling='byok_only' pinned: the entry AI-agent tier on the Manual ladder — Agency carries aiAgent: true + llmBilling: 'byok_only' too, so this is NOT an exclusivity claim, and could not be one: the block is scoped to team_manual by tierBlockIn and cannot see another tier. V-803 retracted the word 'only'. Team requires BYOK (per ADR-004 founder Tier 3 spec). Drift to enabling AI on Solo would break the ladder differentiation; drift to bundled-LLM at this tier would create a billing-rail mismatch with the server-side tier configuration", () => {
    expect(tierBlockIn(body, 'team_manual')).toMatch(
      /aiAgent: true,[\s\S]*?llmBilling: 'byok_only',/,
    );
  });
});
