// W769 — apps/docs api/usage.md content parity. Ninety-fifth in the
// cross-SDK drift-guard series.
//
// /api/usage is the canonical programmatic reference for /v1/usage +
// /v1/usage/series. Drift to the tier-cap table or the
// concurrent-vs-session-minutes meter framing would mismatch W749 +
// W754 dashboard + V-186 server-side enforcement + ADR-004 pricing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/usage.md');

describe('W769 docs /api/usage content parity', () => {
  it('api/usage.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Usage\n/);
    expect(p).toMatch(
      /description: Quota counters, current-period totals, and a daily time series — the \/v1\/usage and \/v1\/usage\/series endpoints\./,
    );
  });

  it("CRITICAL owner-tier-is-cap-source framing pinned. The 'when set to a team owner\\'s account id, the response covers the OWNER\\'s usage rather than the calling member\\'s. The owner\\'s tier is the quota-cap source — being on a team doesn\\'t bump a member\\'s personal cap.' wording is the load-bearing team-RBAC quota framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/when set to a team owner's account id, the response covers the/);
    expect(p).toMatch(
      /OWNER's usage rather than the calling member's\. The owner's tier is\s*\n?the quota-cap source — being on a team doesn't bump a member's\s*\n?personal cap\./,
    );
  });

  it("CRITICAL period_end-exclusive framing pinned. The 'period_start / period_end — UTC ISO 8601. The current calendar month bounds (period_end is exclusive — the first second of the next month)' wording is the load-bearing time-bound contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`period_start` \/ `period_end` — UTC ISO 8601\. The current calendar\s*\n?\s+month bounds \(period_end is exclusive — the first second of the\s*\n?\s+next month\)\./,
    );
  });

  it("CRITICAL session_minute meter framing pinned — 'wall-clock minutes a session was active, summed across the calendar month'. The previous pin asserted `session_minutes` (plural, fictional) but the UsageRecordType enum is singular per packages/api-types/src/usage.ts:4-11. Refreshed against source-of-truth + simplified wording (no BYOK/bundled hedge — the meter sums session minutes regardless of the LLM rail).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`totals\.session_minute` — wall-clock minutes a session was\s*\n?\s+active, summed across the calendar month\./,
    );
    // The fictional plural must NOT return.
    expect(p).not.toMatch(/`totals\.session_minutes`/);
  });

  it("CRITICAL navigates/interacts/waits free-across-tiers framing pinned. The 'Free across all tiers; surfaced for observability' wording matches W754 dashboard /usage ADR-004 'count everything, charge for nothing-but-concurrent' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Free across all tiers; surfaced for\s*\n?\s+observability\./);
  });

  it("CRITICAL 402-style billing-overage signal framing pinned. The 'Crossing the cap triggers a 402-style billing-overage signal at the BillingService layer (this endpoint reports raw counters; the cap is informational here).' wording is the canonical overage-contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Crossing the cap triggers a 402-style billing-overage\s*\n?\s+signal at the BillingService layer \(this endpoint reports raw\s*\n?\s+counters; the cap is informational here\)\./,
    );
  });

  it('CRITICAL enterprise null-quota framing pinned. The previous pin asserted `quotas.profiles_limit` which is fictional — UsageRecordType has no "profiles_limit" member; the actual quotas map uses the singular UsageRecordType keys (session_minute, navigate, etc.). For enterprise the singular `session_minute` cap may be null. Drift would let SDK consumers crash on a null cap.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /For the enterprise tier, `quotas\.session_minute` may be `null`\s*\n?\(meaning "no fixed cap; see your contract"\)\./,
    );
    // Fictional key must NOT return.
    expect(p).not.toMatch(/`quotas\.profiles_limit`/);
  });

  it("CRITICAL daily series right-aligned-on-yesterday framing pinned. The 'right-aligned on \"yesterday\" (the most-recent fully-closed UTC day); today\\'s partial bucket is intentionally not surfaced — the dashboard\\'s sparkline renders cleaner without a half-empty trailing bucket' wording is the load-bearing bucket-alignment contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The series is right-aligned on "yesterday" \(the most-recent\s*\n?fully-closed UTC day\); today's partial bucket is intentionally\s*\n?not surfaced/,
    );
  });

  it("CRITICAL series-empty-days-return-zeros framing pinned. The 'Empty days return zeros for every counter (not omitted from the response) so the dashboard can render an empty-state without client-side date-fill logic' wording matches W754 dashboard /usage sparkline rendering.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Empty days return zeros for every counter \(not omitted from the\s*\n?response\) so the dashboard can render an empty-state without\s*\n?client-side date-fill logic\./,
    );
  });

  it('CRITICAL series `days` parameter range pinned — 1-90, default 30. Drift to a different bound would let SDK consumers pass invalid windows; the 30-default matches W754 dashboard /usage sparkline width.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`days` parameter: 1-90, default 30\./);
  });

  it("CRITICAL series UsageRecordType singular-form framing pinned. The 'totals is a record keyed by record type (singular form, matching the UsageRecordType enum + the field names on the current_period totals)' wording explains the bucket-shape contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`totals` is a record keyed by record type \(singular form, matching\s*\n?the `UsageRecordType` enum/,
    );
  });

  it('CRITICAL TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER source-of-truth framing pinned. The "The locked tier table is driven by TIER_CONCURRENT_SESSION_LIMITS and PROFILES_PER_TIER in @driftstack/api-types" wording matches W761 + W763 + V-186 + V-136 cross-page shared-constant references.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The locked tier table is driven by `TIER_CONCURRENT_SESSION_LIMITS`\s*\n?and `PROFILES_PER_TIER` in `@driftstack\/api-types`/,
    );
  });

  it('CRITICAL 8-tier table pinned with concurrent + profiles + session minutes columns. Drift would mismatch W761 + W763 cross-reference table + V-186 + V-136 server-side enforcement.', () => {
    const p = read(PAGE);

    const tierData: Array<[string, string, string, string]> = [
      ['trial_pack', '1', '1', '30'],
      ['solo_manual', '1', '10', '600'],
      ['team_manual', '3', '50', '6,000'],
      ['agency_manual', '8', '200', '24,000'],
      ['api_starter', '2', '25', '6,000'],
      ['api_builder', '8', '100', '50,000'],
      ['api_scale', '24', '500', '250,000'],
      ['enterprise', '32', 'custom', 'custom'],
    ];
    for (const [tier, conc, profiles, mins] of tierData) {
      expect(p, `${tier} → ${conc}/${profiles}/${mins}`).toMatch(
        new RegExp(
          `\\| \`${tier}\`\\s+\\|\\s+${conc}\\s+\\|\\s+${profiles.replace(/,/g, ',')}\\s+\\|\\s+${mins.replace(/,/g, ',')}\\s+\\|`,
        ),
      );
    }
  });

  it("CRITICAL soft-cap-doesn't-cut-off + Stripe overage billing framing pinned. The 'Crossing the soft cap doesn\\'t cut off the API — it triggers a billing-overage flag and (per ADR-004) Stripe overage billing at the configured per-unit rate' wording is the load-bearing customer-comms.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Crossing the soft cap doesn't cut off the API — it triggers a\s*\n?billing-overage flag and \(per ADR-004\) Stripe overage billing at\s*\n?the configured per-unit rate\./,
    );
  });

  it('CRITICAL quota webhook event-name pair pinned — quota.warning_80pct + quota.exceeded. Matches W753 dashboard /webhooks event-subscription list.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Customers approaching the cap get\s*\n?quota-warning webhooks \(`quota\.warning_80pct`, `quota\.exceeded`\)\s*\n?when an endpoint is subscribed\./,
    );
  });

  it("CRITICAL 3-error-row table pinned — 401/403/400. The 403 'X-Driftstack-Account points at an account the caller isn't a member of' matches W768 audit-log error table.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\| 401\s+\| `unauthorized`\s+\| Missing \/ invalid bearer/);
    expect(p).toMatch(
      /\| 403\s+\| `forbidden`\s+\| X-Driftstack-Account points at an account the caller isn't a member of/,
    );
    expect(p).toMatch(/\| 400\s+\| `validation-failed`\s+\| `days` outside \[1, 90\] on \/series/);
  });

  it("CRITICAL usage_records-source-of-truth + empty-state-is-expected framing pinned. The 'The usage_records table is the source of truth ... The dashboard currently renders zeros for buckets that predate the writers landing in production; that\\'s expected empty-state, not a bug.' wording matches W754 dashboard /usage V-014/V-015 framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/The `usage_records` table is the source of truth/);
    expect(p).toMatch(
      /The dashboard currently renders zeros for buckets that\s*\n?predate the writers landing in production; that's expected\s*\n?empty-state, not a bug\./,
    );
  });

  it('CRITICAL V-452 SDK series anchor pinned. Drift would lose the threading to the V-452 SDK series-method anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*SDK usage\*\* \(V-452\):/);
  });

  it('CRITICAL 3-language SDK examples pinned — TypeScript + Python + Go. All call usage.series / usage.series / Usage.Series with days=30.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const series = await client\.usage\.series\(\{ days: 30 \}\);/);
    expect(p).toMatch(/series = client\.usage\.series\(days=30\)/);
    expect(p).toMatch(/client\.Usage\.Series\(ctx, 30\)/);
  });

  it("CRITICAL response shape — totals + quotas blocks. Matches UsageRecordType enum at packages/api-types/src/usage.ts:4-11 (singular keys, NOT plurals; quotas keys are the SAME enum keys with optional null values, NOT fictional `_limit`-suffixed keys). Drift previously pinned plural keys + 3 fictional `_limit` quota keys that don't exist in the response.", () => {
    const p = read(PAGE);

    // The 6-key UsageRecordType enum (singular). totals + quotas share
    // the same key space; both maps always carry all six keys.
    for (const field of [
      'session_minute',
      'navigate',
      'interact',
      'wait',
      'state_capture',
      'screenshot_capture',
    ]) {
      expect(p, `key ${field}`).toMatch(new RegExp(`"${field}":`));
    }
    // The fictional plurals + `_limit` keys must NOT return.
    for (const fictional of [
      'session_minutes',
      'navigates',
      'interacts',
      'waits',
      'state_captures',
      'screenshot_captures',
      'session_minutes_limit',
      'concurrent_sessions_limit',
      'profiles_limit',
    ]) {
      expect(p, `fictional key ${fictional}`).not.toMatch(new RegExp(`"${fictional}":`));
    }
  });

  it('CRITICAL series buckets singular-key shape pinned — session_minute/navigate/interact/wait/state_capture/screenshot_capture. Drift to plural would let SDK consumers parse a different schema.', () => {
    const p = read(PAGE);

    for (const field of [
      'session_minute',
      'navigate',
      'interact',
      'wait',
      'state_capture',
      'screenshot_capture',
    ]) {
      expect(p, `bucket totals.${field}`).toMatch(new RegExp(`"${field}":`));
    }
  });

  it('CRITICAL 2-endpoint canonical set — GET /v1/usage + GET /v1/usage/series?days=30.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/usage`/);
    expect(p).toMatch(/`GET \/v1\/usage\/series\?days=30`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-usage-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
