// W850 — AccountTier 8-value enum cross-source invariant. One-
// hundred-seventy-sixth in the drift-guard series. Pins the V-148
// two-ladder AccountTier enum (free + solo_manual + team_manual
// + agency_manual + api_starter + api_builder + api_scale + enterprise)
// is consistent across api-types schema + Go const declarations +
// cross-app references.
//
// AccountTier is the canonical pricing-tier enum:
//   - Manual ladder: solo_manual / team_manual / agency_manual.
//   - API ladder: api_starter / api_builder / api_scale.
//   - Special: free (perpetual free tier) + enterprise.
//
// Drift to adding/removing a tier without coordinated SDK + dashboard
// + billing-flow updates would break tier-checking branches across
// the entire codebase.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// The canonical 8-value AccountTier set.
const ACCOUNT_TIERS = [
  'free',
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
  'enterprise',
] as const;

describe('W850 AccountTier 8-value cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/common.ts declares AccountTierSchema = z.enum([...]) with the EXACT 8-value set (free + solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale + enterprise). Drift would cascade through every tier-check.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/export const AccountTierSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 8-value set, not merely
    // contain it — a 9th tier added to the schema would silently pass the
    // subset for-loop below (the same weak pattern that let the
    // WebhookEventType roster drift out of the Go SDK unnoticed).
    expect(AccountTierSchema.options).toEqual([...ACCOUNT_TIERS]);
    for (const tier of ACCOUNT_TIERS) {
      expect(p, `AccountTierSchema must include '${tier}'`).toMatch(new RegExp(`'${tier}'`));
    }
  });

  it("CRITICAL AccountTier type re-exports from AccountTierSchema z.infer — 'export type AccountTier = z.infer<typeof AccountTierSchema>;'. Drift to a hand-written type would let it drift from the runtime schema.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/export type AccountTier = z\.infer<typeof AccountTierSchema>;/);
  });

  // ─── Go SDK 8-const declarations ─────────────────────────────

  it('CRITICAL Go SDK packages/sdk-go/types.go declares 8 AccountTier consts — TierFree + TierSoloManual + TierTeamManual + TierAgencyManual + TierAPIStarter + TierAPIBuilder + TierAPIScale + TierEnterprise. Each maps to one canonical tier string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type AccountTier string/);
    expect(p).toMatch(/TierFree +AccountTier = "free"/);
    expect(p).toMatch(/TierSoloManual +AccountTier = "solo_manual"/);
    expect(p).toMatch(/TierTeamManual +AccountTier = "team_manual"/);
    expect(p).toMatch(/TierAgencyManual AccountTier = "agency_manual"/);
    expect(p).toMatch(/TierAPIStarter +AccountTier = "api_starter"/);
    expect(p).toMatch(/TierAPIBuilder +AccountTier = "api_builder"/);
    expect(p).toMatch(/TierAPIScale +AccountTier = "api_scale"/);
    expect(p).toMatch(/TierEnterprise +AccountTier = "enterprise"/);
  });

  it("CRITICAL Go SDK AccountTier comment references V-148 (two-ladder pricing) + 'closed enum'. The V-148 anchor threads the pricing-policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/AccountTier is the closed enum of pricing tiers \(V-148 two-ladder/);
  });

  // ─── 3-ladder + 2-special framing ────────────────────────────

  it('CRITICAL the 8-tier set decomposes as 3 Manual + 3 API + 2 Special (free + enterprise). The 3+3+2 shape matches the V-148 two-ladder + special-cases model. Drift to a different decomposition (e.g. 4 Manual tiers) would break the pricing-page UI.', () => {
    // Manual ladder: 3 tiers.
    const manual = ACCOUNT_TIERS.filter((t) => t.endsWith('_manual'));
    expect(manual.length, '3 Manual-ladder tiers').toBe(3);
    expect(manual).toEqual(['solo_manual', 'team_manual', 'agency_manual']);

    // API ladder: 3 tiers.
    const api = ACCOUNT_TIERS.filter((t) => t.startsWith('api_'));
    expect(api.length, '3 API-ladder tiers').toBe(3);
    expect(api).toEqual(['api_starter', 'api_builder', 'api_scale']);

    // Special: 2 tiers.
    const special = ACCOUNT_TIERS.filter((t) => !t.endsWith('_manual') && !t.startsWith('api_'));
    expect(special.length, '2 special tiers').toBe(2);
    expect(special).toEqual(['free', 'enterprise']);

    // Total: 8.
    expect(ACCOUNT_TIERS.length).toBe(8);
  });

  // ─── Cross-app + cross-SDK reference completeness ─────────────

  it("CRITICAL api-types/src/index.ts uses 'export * from ./common.js' which transitively re-exports AccountTier + AccountTierSchema. The barrel-re-export pattern is what makes the type available to all consumers. Drift to dropping common.js from the re-export set would orphan the AccountTier type.", () => {
    const apiTypesIndex = read(resolve(REPO_ROOT, 'packages/api-types/src/index.ts'));
    expect(apiTypesIndex).toMatch(/export \* from '\.\/common\.js';/);
  });

  // ─── No forbidden tier names ─────────────────────────────────

  it('CRITICAL no source declares forbidden tier names (pro / basic / premium / pro_plus / startup). These are common SaaS-tier names that AccountTier intentionally avoids — drift to adding them would break the two-ladder positioning. (NOTE: free is now the canonical entry tier as of 2026-05-27, replacing trial_pack.)', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    for (const forbidden of ["'pro'", "'basic'", "'premium'", "'pro_plus'", "'startup'"]) {
      expect(apiTypes, `AccountTier must NOT include forbidden tier ${forbidden}`).not.toMatch(
        new RegExp(`AccountTierSchema[\\s\\S]+?${forbidden}[\\s\\S]+?\\]\\)`),
      );
    }
  });

  // ─── perf/_harness.ts seedTier type matches ──────────────────

  it("CRITICAL perf/_harness.ts Scenario.seedTier type must match AccountTier values. Per W805, perf-harness types tier as 'free | starter | solo | builder | scale | enterprise' — these are SHORT-form names that the harness maps internally. Drift in either direction would let perf scenarios target nonexistent tiers.", () => {
    const p = read(resolve(REPO_ROOT, 'perf/_harness.ts'));
    expect(p).toMatch(
      /seedTier\?: 'free' \| 'starter' \| 'solo' \| 'builder' \| 'scale' \| 'enterprise'/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-tier-enum-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
