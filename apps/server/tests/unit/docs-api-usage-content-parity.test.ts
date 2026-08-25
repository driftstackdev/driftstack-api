// Drift guard for apps/docs/src/pages/api/usage.md. Pins the
// customer-facing usage API docs — 2 endpoints (/v1/usage current
// period + /v1/usage/series daily) + 6-field UsageRecordType enum +
// 8-tier quota table snapshot + ADR-004 soft-cap-doesn't-cut-off
// posture + team RBAC X-Driftstack-Account scoping.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/usage.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/usage content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Usage overview framing pinned: '/v1/usage exposes the calling account's current billing-period totals + tier quotas. /v1/usage/series returns a daily-bucketed sparkline for the last N days.' — pinned so the 2-endpoint roster (current + series) contract stays documented", () => {
    expect(body).toMatch(
      /`\/v1\/usage` exposes the calling account's current billing-period\s*totals \+ tier quotas\. `\/v1\/usage\/series` returns a daily-bucketed\s*sparkline for the last N days\./,
    );
  });

  it("Team RBAC X-Driftstack-Account framing pinned: 'Both endpoints honor the X-Driftstack-Account header (Team RBAC): when set to a team owner's account id, the response covers the OWNER's usage rather than the calling member's. The owner's tier is the quota-cap source — being on a team doesn't bump a member's personal cap.' — pinned so the X-Driftstack-Account header + OWNER's-usage + tier-cap-is-OWNER's contract all stay documented (drift to bumping member cap via team membership would create a quota-bypass vector)", () => {
    expect(body).toMatch(
      /Both endpoints honor the `X-Driftstack-Account` header \(Team RBAC\):\s*when set to a team owner's account id, the response covers the\s*OWNER's usage rather than the calling member's\. The owner's tier is\s*the quota-cap source — being on a team doesn't bump a member's\s*personal cap\./,
    );
  });

  it("6-field UsageRecordType enum (singular) pinned: session_minute + navigate + interact + wait + state_capture + screenshot_capture. 'totals.* and quotas.* use the same key set — the UsageRecordType enum (singular). Both maps always carry all six keys.' — pinned so the 6-key roster + singular-naming + both-maps-always-have-all-6-keys contract all stay documented (drift to omitting any key would crash dashboard renders that destructure all 6)", () => {
    expect(body).toMatch(
      /`totals\.\*` and `quotas\.\*` use the same key set — the\s*`UsageRecordType` enum \(singular\): `session_minute`, `navigate`,\s*`interact`, `wait`, `state_capture`, `screenshot_capture`\. Both\s*maps always carry all six keys\./,
    );
  });

  it("Quota all-tiers-null + concurrent-only-no-overage framing pinned (2026-06-24, ADR-004). The previous pin asserted enterprise quotas.session_minute 'may be null' (others numeric) + 'soft cap ... Stripe overage billing' + quota-warning webhooks. Per ADR-004 (services/usage.ts:45-125) hours metering was retired — every TIER_QUOTAS value is null, so there is no per-meter cap or overage billing at any tier. The doc now states quotas.session_minute is null for every tier including enterprise, the paid tiers are concurrent-only with no monthly meter, and the only minute-based bound is the free tier's 20-minute per-session cap (session-lifecycle auto-destroy, not a billing event).", () => {
    expect(body).toMatch(
      /`quotas\.session_minute` is `null` for every tier, including\s*enterprise \(no per-meter cap is gated at any tier\)\./,
    );
    expect(body).toMatch(
      /Per ADR-004 the paid tiers are concurrent-only: there is no monthly\s*session-minute meter and no per-meter overage billing\./,
    );
    // The retired overage/Stripe + quota-warning-webhook framing must NOT return.
    expect(body).not.toMatch(/Stripe overage billing/);
    expect(body).not.toMatch(/billing-overage flag/);
    expect(body).not.toMatch(/quota-warning webhooks/);
    expect(body).not.toMatch(/quota\.warning_80pct/);
  });

  it("Series response shape framing pinned: 'totals is a record keyed by record type (singular form, matching the UsageRecordType enum + the field names on the current_period totals). days parameter: 1-90, default 30. The series is right-aligned on \"yesterday\" (the most-recent fully-closed UTC day); today's partial bucket is intentionally not surfaced — the dashboard's sparkline renders cleaner without a half-empty trailing bucket.' + 'Empty days return zeros for every counter (not omitted from the response) so the dashboard can render an empty-state without client-side date-fill logic.' — pinned so the right-aligned-on-yesterday + zeros-not-omitted contract all stay documented", () => {
    expect(body).toMatch(
      /`days` parameter: 1-90, default 30\.\s*The series is right-aligned on "yesterday" \(the most-recent\s*fully-closed UTC day\); today's partial bucket is intentionally\s*not surfaced/,
    );
    expect(body).toMatch(
      /Empty days are included in the series \(not omitted from the\s*response\) so the dashboard can render an empty-state without\s*client-side date-fill logic, but their `totals` is an empty object\s*`\{\}` — treat a missing counter key as `0`\. \(The current-period\s*summary, by contrast, zero-fills every counter\.\)/,
    );
  });

  it("8-tier quota table snapshot pinned: 2-column (concurrent / profiles) — free (1/1) + solo_manual (1/10) + team_manual (3/50) + agency_manual (8/200) + api_starter (2/25) + api_builder (8/100) + api_scale (24/500) + enterprise (32/custom). + 'driven by TIER_CONCURRENT_SESSION_LIMITS and PROFILES_PER_TIER in @driftstack/api-types' source-of-truth pointer. 2026-06-24: the previous 3rd 'Session minutes / month' column (with per-tier monthly numbers) was removed — per ADR-004 (services/usage.ts retired hours metering) there is no monthly session-minute meter. Concurrent + profiles still match the tier-cap source-of-truth.", () => {
    expect(body).toMatch(
      /`TIER_CONCURRENT_SESSION_LIMITS`\s*and `PROFILES_PER_TIER` in `@driftstack\/api-types`/,
    );
    expect(body).toMatch(/\|\s*`free`\s*\|\s+1 \|\s+1 \|/);
    expect(body).toMatch(/\|\s*`solo_manual`\s*\|\s+1 \|\s+10 \|/);
    expect(body).toMatch(/\|\s*`api_starter`\s*\|\s+2 \|\s+25 \|/);
    expect(body).toMatch(/\|\s*`api_builder`\s*\|\s+8 \|\s+100 \|/);
    expect(body).toMatch(/\|\s*`api_scale`\s*\|\s+24 \|\s+500 \|/);
    expect(body).toMatch(/\|\s*`enterprise`\s*\|\s+32 \|\s+custom \|/);
    // The retired monthly session-minute column must NOT return.
    expect(body).not.toMatch(/Session minutes \/ month/);
    expect(body).not.toMatch(/250,000/);
  });

  it("Auth scoping framing pinned: 'Both endpoints accept any valid bearer (API key OR web session) with read scope. The X-Driftstack-Account header is honored for team scopes per the (member roles read the owner's usage).' + 3-row errors (401 unauthorized + 403 forbidden cross-account + 400 validation-failed days-out-of-range) — pinned so the API-key-OR-web-session + read-scope-sufficient + 3-error-status contract all stay documented", () => {
    expect(body).toMatch(
      /Both endpoints accept any valid bearer \(API key OR web session\)\s*with `read` scope\./,
    );
    expect(body).toMatch(/\|\s*401\s+\|\s+`unauthorized`/);
    expect(body).toMatch(
      /\|\s*403\s+\|\s+`forbidden`\s+\|\s+X-Driftstack-Account points at an account the caller isn't a member of/,
    );
    expect(body).toMatch(
      /\|\s*400\s+\|\s+`validation-failed`\s+\|\s+`days` outside \[1, 90\] on \/series/,
    );
  });

  it('3-language SDK code samples pinned: TS client.usage.series + Python client.usage.series(days=30) + Go client.Usage.Series(ctx, 30). Drift to a different SDK method shape would mismatch the cross-language usage docs from the actual SDK surface', () => {
    expect(body).toMatch(/const series = await client\.usage\.series\(\{ days: 30 \}\);/);
    expect(body).toMatch(/series = client\.usage\.series\(days=30\)/);
    expect(body).toMatch(/series, _ := client\.Usage\.Series\(ctx, 30\)/);
  });
});
