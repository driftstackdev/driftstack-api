// W550.C — drift guard for /docs/adr/ADR-004-pricing-restructure-two-ladder.md.
// Contractual decision record. Drift here either weakens the
// two-ladder concurrent-only posture (would re-introduce hours-
// with-overage which is hostile to manual users running persistent
// profiles 8+ hours daily), drops the 8-paid-tier + 3-self-hosted-
// tier inventory (would diverge from Stripe 19 price ID inventory
// + account_tier Postgres enum), or weakens the V-073 enforcement
// implications (would drift from PROFILES_PER_TIER + the 429 tier-limit
// and 429 concurrency-limit semantics that actually ship).
//
//   • Status: Accepted, 2026-05-03, Contractual.
//   • Related V-entry: V-061 + V-071 + V-073.
//   • Two ladders: Manual (Solo + Team + Agency) + API (Starter +
//     Builder + Scale + Enterprise).
//   • Manual: $79 / $249 / $699 monthly; 10/50/200 profiles.
//   • API: $149 / $499 / $1,499 monthly; 25/100/500 profiles.
//   • Self-hosted: $1,000 / $2,000 / $4,000+/mo.
//   • Annual discount: 20% across all tiers. Setup fees: zero.
//   • 19 Stripe price IDs total. Both caps are 429 — V-814 corrected an
//     ADR bullet that specified a payment-required status for the profile
//     cap, a contrast the implementation never drew.
//   • account_tier enum: trial_pack + 3 manual + 3 api + enterprise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-004-pricing-restructure-two-ladder.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W550.C /docs/adr/ADR-004-pricing-restructure-two-ladder.md content parity', () => {
  const body = read(LIB);

  it("Header + Status-Contractual + Related-V framing pinned: '# ADR-004 — Pricing restructure to two-ladder concurrent-only' + '**Status:** Accepted' + '**Date:** 2026-05-03' + '**Tier:** Contractual (explicit; commercial-commitment shape)' + '**Related V-entry:** V-061 (file-127 sweep that landed the previous single-ladder values), V-071 (this ADR), V-073 (data-layer rewrite that codifies the new structure — V-072 was renumbered).' + '**Related ADR:** ADR-003 (paid trial pack — unchanged by this restructure; trial-pack mechanics survive intact).' — pinned so the ADR-004-Accepted-2026-05-03 + Tier-Contractual + V-061-prior-single-ladder + V-071-ADR + V-073-data-layer-rewrite + V-072-renumbered + ADR-003-trial-pack-mechanics-intact commitment survives", () => {
    expect(body).toMatch(/^# ADR-004 — Pricing restructure to two-ladder concurrent-only$/m);
    expect(body).toMatch(/\*\*Status:\*\* Accepted/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(/\*\*Tier:\*\* Contractual \(explicit; commercial-commitment shape\)/);
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-061 \(file-127 sweep that landed the previous single-ladder values\),/,
    );
    expect(body).toMatch(/V-071 \(this ADR\),/);
    expect(body).toMatch(
      /V-073 \(data-layer rewrite that codifies the new structure — V-072 was renumbered\)\./,
    );
    expect(body).toMatch(
      /\*\*Related ADR:\*\* ADR-003 \(paid trial pack — unchanged by this restructure; trial-pack mechanics survive intact\)\./,
    );
  });

  it("Context — hours-metering-hostile + concurrent-only-simpler + N=4-fleet-capacity framing pinned: '1. **Hours metering is hostile to manual users.**' + 'persistent profiles** for 8+ hours daily' + '2. **Concurrent-only metering is simpler everywhere.**' + 'A third constraint shaped the absolute price points: **conservative fleet capacity assumption**.' + 'estimate is `N=4`' + '$50-70 per concurrent session-slot per month' + '**Manual ladder** (Solo / Team / Agency Manual) — humans clicking the GUI client.' + '**API ladder** (API Starter / Builder / Scale / Enterprise) — code calling the SDK.' — pinned so the hours-hostile-to-manual + concurrent-only-simpler + N=4-conservative + $50-70/slot/mo + Manual-humans + API-code commitment survives", () => {
    expect(body).toMatch(/1\. \*\*Hours metering is hostile to manual users\.\*\*/);
    expect(body).toMatch(/\*\*persistent profiles\*\* for 8\+ hours daily/);
    expect(body).toMatch(/2\. \*\*Concurrent-only metering is simpler everywhere\.\*\*/);
    expect(body).toMatch(
      /A third constraint shaped the absolute price points: \*\*conservative fleet capacity assumption\*\*\./,
    );
    expect(body).toMatch(/estimate is `N=4`/);
    expect(body).toMatch(/\$50-70 per concurrent session-slot per month/);
    expect(body).toMatch(
      /- \*\*Manual ladder\*\* \(Solo \/ Team \/ Agency Manual\) — humans clicking the GUI client\./,
    );
    expect(body).toMatch(
      /- \*\*API ladder\*\* \(API Starter \/ Builder \/ Scale \/ Enterprise\) — code calling the SDK\./,
    );
  });

  it("Decision — Manual + API + Self-Hosted 11-tier-table inventory framing pinned: '**Replace the single-ladder hours-with-overage model with a two-ladder concurrent-only model.**' + 'Solo Manual   | $79' + 'Team Manual   | $249' + 'Agency Manual | $699' + 'API Starter | $149' + 'API Builder | $499' + 'API Scale   | $1,499' + 'Self-Hosted Solo       | $1,000' + 'Self-Hosted Pro        | $2,000' + 'Self-Hosted Enterprise | from $4,000/mo' + '**Annual discount:** 20% across all tiers. **Setup fees:** zero across all tiers.' — pinned so the two-ladder-concurrent-only + 3-Manual-tier-prices + 3-API-tier-prices + 3-Self-Hosted-tier-prices + 20%-annual-discount + zero-setup-fees commitment survives", () => {
    expect(body).toMatch(
      /\*\*Replace the single-ladder hours-with-overage model with a two-ladder concurrent-only model\.\*\*/,
    );
    expect(body).toMatch(/Solo Manual\s+\|\s+\$79/);
    expect(body).toMatch(/Team Manual\s+\|\s+\$249/);
    expect(body).toMatch(/Agency Manual \| \$699/);
    expect(body).toMatch(/API Starter \| \$149/);
    expect(body).toMatch(/API Builder \| \$499/);
    expect(body).toMatch(/API Scale\s+\|\s+\$1,499/);
    expect(body).toMatch(/Self-Hosted Solo\s+\|\s+\$1,000/);
    expect(body).toMatch(/Self-Hosted Pro\s+\|\s+\$2,000/);
    expect(body).toMatch(/Self-Hosted Enterprise \| from \$4,000\/mo/);
    expect(body).toMatch(
      /\*\*Annual discount:\*\* 20% across all tiers\. \*\*Setup fees:\*\* zero across all tiers\./,
    );
  });

  it("V-073 enforcement implications framing pinned: 'Postgres `account_tier` enum drops `'free' | 'starter' | 'solo' | 'builder' | 'scale' | 'enterprise'` and becomes `'trial_pack' | 'solo_manual' | 'team_manual' | 'agency_manual' | 'api_starter' | 'api_builder' | 'api_scale' | 'enterprise'`.' + '`TIER_CONCURRENT_SESSION_LIMITS` becomes the only tier-limit metric on paid tiers.' + '`TIER_QUOTAS.session_minute` removed. Trial-pack `trial_pack_credit_cents` decrement at $0.18/hr stays per ADR-003' + the `PROFILES_PER_TIER` enforcement bullet and the concurrency-cap bullet — pinned so the account_tier-old-vs-new-enum + TIER_CONCURRENT_SESSION_LIMITS-only + TIER_QUOTAS.session_minute-removed + PROFILES_PER_TIER-map commitments survive. V-814 REWROTE this title: it used to quote both cap bullets verbatim, including a payment-required status and a body identifier the server has never emitted, so the pin's own title was a second copy of the false claim", () => {
    expect(body).toMatch(/Postgres `account_tier` enum drops `'free' \| 'starter' \| 'solo' \|/);
    expect(body).toMatch(/'builder' \| 'scale' \| 'enterprise'` and becomes `'trial_pack' \|/);
    // V-827 — the enum bullet is kept as the accepted decision; what must be
    // present is the note recording that migration 0065 retired trial_pack.
    expect(body).toMatch(
      /Implementation note \(V-827\) — the first enum member is no longer `trial_pack`\./,
    );
    expect(body).toMatch(/0065_retire_trial_pack_free_tier\.sql/);
    expect(body).toMatch(/'solo_manual' \| 'team_manual' \| 'agency_manual' \| 'api_starter' \|/);
    expect(body).toMatch(/'api_builder' \| 'api_scale' \| 'enterprise'`\./);
    expect(body).toMatch(
      /`TIER_CONCURRENT_SESSION_LIMITS` becomes the only tier-limit metric on paid tiers\./,
    );
    expect(body).toMatch(
      /`TIER_QUOTAS\.session_minute` removed\. Trial-pack `trial_pack_credit_cents` decrement at \$0\.18\/hr stays per ADR-003/,
    );
    expect(body).toMatch(
      /New `PROFILES_PER_TIER` map enforces profile count at the `\/v1\/profiles` creation endpoint\./,
    );
    // V-814 — these two bullets now describe what ships. The profile cap
    // throws TierLimitError (status 429, type .../tier-limit); the ADR as
    // accepted specified a payment-required status with a body identifier
    // that exists nowhere in the codebase, and the implementation note
    // below the bullets records that divergence rather than hiding it.
    expect(body).toMatch(
      /Exceeding profile cap → 429 with the `https:\/\/errors\.driftstack\.dev\/tier-limit` problem type\./,
    );
    expect(body).toMatch(
      /Concurrent cap exceeded at session-creation → 429 with the `https:\/\/errors\.driftstack\.dev\/concurrency-limit` problem type\./,
    );
    expect(body, 'the ADR must carry the divergence note, not just the corrected bullets').toMatch(
      /Implementation note \(V-814, 2026-08-18\) — what shipped differs from the decision above\./,
    );

    // SENTINEL — the retired claim must not return. There is no
    // profile-cap-reached identifier in the codebase and no 402 on this path.
    expect(body, 'the retired payment-required claim must not return').not.toMatch(
      /profile cap → 402/,
    );
    expect(body, 'the fabricated body identifier must not return').not.toMatch(
      /profile-cap-reached body/,
    );
  });

  it("Consequences — 11-paid-tiers + 19-Stripe-price-IDs + Manual-vs-API-boundary-confusion framing pinned: 'More tiers (8 paid + 3 self-hosted = 11) vs prior (5 paid + 3 self-hosted = 8) on the marketing site.' + 'more SKU price IDs in Stripe (19 total)' + '**Risk of audience confusion at the boundary**' + 'FAQ entry \"What's the difference between Manual and API?\" addresses this directly (Workstream B v3).' — pinned so the 8-paid+3-self-hosted=11-tiers + 19-Stripe-price-IDs + Manual-vs-API-audience-boundary + Workstream-B-v3-FAQ commitment survives", () => {
    expect(body).toMatch(
      /\*\*More tiers \(8 paid \+ 3 self-hosted = 11\) vs prior \(5 paid \+ 3 self-hosted = 8\) on the marketing site\.\*\*/,
    );
    expect(body).toMatch(/more SKU price IDs in Stripe \(19 total\)/);
    expect(body).toMatch(/\*\*Risk of audience confusion at the boundary\*\*/);
    expect(body).toMatch(
      /FAQ entry "What's the difference between Manual and API\?" addresses this directly \(Workstream B v3\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
