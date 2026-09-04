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

  it("CRITICAL session_minute meter framing pinned — 'wall-clock minutes a session was active, summed across the calendar month'. The previous pin asserted `session_minutes` (plural, fictional) but the UsageRecordType enum is singular per packages/api-types/src/usage.ts:4-11. Refreshed 2026-06-24: per ADR-004 (services/usage.ts:45-59 retired hours metering — every TIER_QUOTAS value is null) the meter is now framed as 'a granular usage primitive for analytics; not gated against a per-tier cap', NOT a Stripe-billed meter.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`totals\.session_minute` — wall-clock minutes a session was\s*\n?\s+active, summed across the calendar month\. A granular usage\s*\n?\s+primitive for analytics; not gated against a per-tier cap\./,
    );
    // The fictional plural must NOT return.
    expect(p).not.toMatch(/`totals\.session_minutes`/);
    // The retired Stripe-meter framing must NOT return (ADR-004).
    expect(p).not.toMatch(/Drives the\s*\n?\s+session-minutes meter on Stripe\./);
  });

  it("CRITICAL navigates/interacts/waits free-across-tiers framing pinned. The 'Free across all tiers; surfaced for observability' wording matches W754 dashboard /usage ADR-004 'count everything, charge for nothing-but-concurrent' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Free across all tiers; surfaced for\s*\n?\s+observability\./);
  });

  it("CRITICAL quotas.session_minute-is-null framing pinned (2026-06-24, ADR-004). The previous pin asserted a '402-style billing-overage signal at the BillingService layer' but services/usage.ts:60-125 sets session_minute (and every other key) to null for every tier — no overage enforcement exists. The doc now states 'quotas.session_minute — null on every tier ... no per-minute meter is gated; the field is preserved (rather than removed) so the response shape stays stable'.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`quotas\.session_minute` — `null` on every tier\. Per ADR-004 the\s*\n?\s+paid tiers are concurrent-only and no per-minute meter is gated;\s*\n?\s+the field is preserved \(rather than removed\) so the response\s*\n?\s+shape stays stable\./,
    );
    // The retired overage-signal framing must NOT return.
    expect(p).not.toMatch(/402-style billing-overage/);
    expect(p).not.toMatch(/BillingService layer/);
  });

  it('CRITICAL null-quota + free-tier-20-min-per-session-cap framing pinned (2026-06-24). The previous pin asserted enterprise `quotas.session_minute` "may be null"; per ADR-004 (services/usage.ts) it is null for EVERY tier. The doc now states quotas.session_minute is null for every tier including enterprise, and that the free tier instead enforces a 20-minute per-session wall-clock cap (MAX_SESSION_MINUTES_PER_TIER free → 20, packages/api-types/src/common.ts:183-192) at the session-lifecycle layer — NOT a monthly meter. Fictional `quotas.profiles_limit` key must NOT return.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`quotas\.session_minute` is `null` for every tier, including\s*\n?enterprise \(no per-meter cap is gated at any tier\)\./,
    );
    expect(p).toMatch(
      /The free tier\s*\n?instead enforces a 20-minute \*\*per-session\*\* wall-clock cap\s*\n?\(`MAX_SESSION_MINUTES_PER_TIER` free → 20\)/,
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

  it("CRITICAL series-empty-days-included-with-empty-totals framing pinned. The 'Empty days are included in the series (not omitted from the response) so the dashboard can render an empty-state without client-side date-fill logic, but their totals is an empty object {} — treat a missing counter key as 0. (The current-period summary, by contrast, zero-fills every counter.)' wording matches W754 dashboard /usage sparkline rendering.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Empty days are included in the series \(not omitted from the\s*\n?response\) so the dashboard can render an empty-state without\s*\n?client-side date-fill logic, but their `totals` is an empty object\s*\n?`\{\}` — treat a missing counter key as `0`\. \(The current-period\s*\n?summary, by contrast, zero-fills every counter\.\)/,
    );
    // Ban the superseded "return zeros for every counter" framing — empty days now
    // carry an empty {} totals object, not zero-filled counters.
    expect(p).not.toMatch(/Empty days return zeros for every counter/);
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

  it('CRITICAL 8-tier table pinned with concurrent + profiles columns (2026-06-24). The previous pin asserted a 4th "Session minutes / month" column with per-tier monthly numbers; per ADR-004 (services/usage.ts retired hours metering) there is no monthly session-minute meter, so the column was removed. Concurrent + profiles columns still match TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER (W761 + W763 + V-186 + V-136).', () => {
    const p = read(PAGE);

    const tierData: Array<[string, string, string]> = [
      ['free', '1', '1'],
      ['solo_manual', '1', '10'],
      ['team_manual', '3', '50'],
      ['agency_manual', '8', '200'],
      ['api_starter', '2', '25'],
      ['api_builder', '8', '100'],
      ['api_scale', '24', '500'],
      ['enterprise', '32', 'custom'],
    ];
    for (const [tier, conc, profiles] of tierData) {
      expect(p, `${tier} → ${conc}/${profiles}`).toMatch(
        new RegExp(`\\| \`${tier}\`\\s+\\|\\s+${conc}\\s+\\|\\s+${profiles}\\s+\\|`),
      );
    }
    // The retired monthly session-minute numbers must NOT return.
    expect(p).not.toMatch(/Session minutes \/ month/);
    expect(p).not.toMatch(/250,000/);
  });

  it("CRITICAL concurrent-only + no-overage-billing framing pinned (2026-06-24, ADR-004). The previous pin asserted 'Crossing the soft cap doesn't cut off the API — it triggers a billing-overage flag and (per ADR-004) Stripe overage billing' + quota-warning webhooks. Per ADR-004 (services/usage.ts) the paid tiers are concurrent-only: no monthly session-minute meter and no overage billing exists. The doc now states the operation counters are never charged, and the only minute-based bound is the free tier's 20-minute per-session cap enforced at the session-lifecycle layer (auto-destroy), not a billing event.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Per ADR-004 the paid tiers are concurrent-only: there is no monthly\s*\n?session-minute meter and no per-meter overage billing\./,
    );
    expect(p).toMatch(
      /The only minute-based bound is\s*\n?the free tier's 20-minute per-session wall-clock cap, enforced at\s*\n?the session-lifecycle layer \(the session auto-destroys\), not as a\s*\n?billing event\./,
    );
    // The retired overage/Stripe + quota-warning-webhook framing must NOT return.
    expect(p).not.toMatch(/Stripe overage billing/);
    expect(p).not.toMatch(/billing-overage flag/);
    expect(p).not.toMatch(/quota\.warning_80pct/);
    expect(p).not.toMatch(/quota\.exceeded/);
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
      /The dashboard\s*\n?currently renders zeros for buckets that predate the writers\s*\n?landing in production; that's expected empty-state, not a bug\./,
    );
    // 2026-06-24: the broken placeholder "(per the +\n." fragment that
    // followed "source of truth" was removed — it must not return.
    expect(p).not.toMatch(/the source of truth \(per the \+/);
  });

  it('CRITICAL SDK series anchor pinned: "**SDK usage:**" precedes the 3-language code block. The previous skip pinned `(V-452)` with the inline internal version anchor; the V-452 anchor was removed from the customer-rendered copy as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the framing itself survives without it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*SDK usage:\*\*/);
    // Drift-guard: the internal V-452 anchor MUST NOT bleed back
    // into the customer-rendered SDK-usage marker.
    expect(p).not.toMatch(/\*\*SDK usage\*\* \(V-452\):/);
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

  it('CRITICAL auth contract — both endpoints require read and honor selected team workspace', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Both endpoints accept any valid bearer \(API key OR web session\)\s*with `read` scope\./,
    );
    expect(p).toMatch(
      /The X-Driftstack-Account header is honored for\s*team scopes — member roles read the owner's usage\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-usage-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
