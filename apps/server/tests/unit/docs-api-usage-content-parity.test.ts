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
      /`\/v1\/usage` exposes the calling account's current billing-period\s*\n?\s*totals \+ tier quotas\. `\/v1\/usage\/series` returns a daily-bucketed\s*\n?\s*sparkline for the last N days\./,
    );
  });

  it("Team RBAC X-Driftstack-Account framing pinned: 'Both endpoints honor the X-Driftstack-Account header (Team RBAC): when set to a team owner's account id, the response covers the OWNER's usage rather than the calling member's. The owner's tier is the quota-cap source — being on a team doesn't bump a member's personal cap.' — pinned so the X-Driftstack-Account header + OWNER's-usage + tier-cap-is-OWNER's contract all stay documented (drift to bumping member cap via team membership would create a quota-bypass vector)", () => {
    expect(body).toMatch(
      /Both endpoints honor the `X-Driftstack-Account` header \(Team RBAC\):\s*\n?\s*when set to a team owner's account id, the response covers the\s*\n?\s*OWNER's usage rather than the calling member's\. The owner's tier is\s*\n?\s*the quota-cap source — being on a team doesn't bump a member's\s*\n?\s*personal cap\./,
    );
  });

  it("6-field UsageRecordType enum (singular) pinned: session_minute + navigate + interact + wait + state_capture + screenshot_capture. 'totals.* and quotas.* use the same key set — the UsageRecordType enum (singular). Both maps always carry all six keys.' — pinned so the 6-key roster + singular-naming + both-maps-always-have-all-6-keys contract all stay documented (drift to omitting any key would crash dashboard renders that destructure all 6)", () => {
    expect(body).toMatch(
      /`totals\.\*` and `quotas\.\*` use the same key set — the\s*\n?\s*`UsageRecordType` enum \(singular\): `session_minute`, `navigate`,\s*\n?\s*`interact`, `wait`, `state_capture`, `screenshot_capture`\. Both\s*\n?\s*maps always carry all six keys\./,
    );
  });

  it("Quota enterprise-null + soft-cap-doesn't-cut-off framing pinned: 'For the enterprise tier, quotas.session_minute may be null (meaning \"no fixed cap; see your contract\"). All other tiers return a numeric value.' + 'Crossing the soft cap doesn't cut off the API — it triggers a billing-overage flag and (per ADR-004) Stripe overage billing at the configured per-unit rate. Customers approaching the cap get quota-warning webhooks (quota.warning_80pct, quota.exceeded) when an endpoint is subscribed.' — pinned so the enterprise-null-no-fixed-cap + ADR-004 overage-billing + quota-warning-webhooks contract all stay documented", () => {
    expect(body).toMatch(
      /For the enterprise tier, `quotas\.session_minute` may be `null`\s*\n?\s*\(meaning "no fixed cap; see your contract"\)\. All other tiers\s*\n?\s*return a numeric value\./,
    );
    expect(body).toMatch(
      /Crossing the soft cap doesn't cut off the API — it triggers a\s*\n?\s*billing-overage flag and \(per ADR-004\) Stripe overage billing at\s*\n?\s*the configured per-unit rate\./,
    );
    expect(body).toMatch(/quota-warning webhooks \(`quota\.warning_80pct`, `quota\.exceeded`\)/);
  });

  it("Series response shape framing pinned: 'totals is a record keyed by record type (singular form, matching the UsageRecordType enum + the field names on the current_period totals). days parameter: 1-90, default 30. The series is right-aligned on \"yesterday\" (the most-recent fully-closed UTC day); today's partial bucket is intentionally not surfaced — the dashboard's sparkline renders cleaner without a half-empty trailing bucket.' + 'Empty days return zeros for every counter (not omitted from the response) so the dashboard can render an empty-state without client-side date-fill logic.' — pinned so the right-aligned-on-yesterday + zeros-not-omitted contract all stay documented", () => {
    expect(body).toMatch(
      /`days` parameter: 1-90, default 30\.\s*\n?\s*The series is right-aligned on "yesterday" \(the most-recent\s*\n?\s*fully-closed UTC day\); today's partial bucket is intentionally\s*\n?\s*not surfaced/,
    );
    expect(body).toMatch(
      /Empty days return zeros for every counter \(not omitted from the\s*\n?\s*response\) so the dashboard can render an empty-state without\s*\n?\s*client-side date-fill logic\./,
    );
  });

  it("8-tier quota table snapshot pinned: free (1/1/—) + solo_manual (1/10/600) + team_manual (3/50/6,000) + agency_manual (8/200/24,000) + api_starter (2/25/6,000) + api_builder (8/100/50,000) + api_scale (24/500/250,000) + enterprise (32/custom/custom). + 'driven by TIER_CONCURRENT_SESSION_LIMITS and PROFILES_PER_TIER in @driftstack/api-types' source-of-truth pointer — pinned so the 8-tier×3-cap snapshot + canonical constant names contract all stay documented (drift on numbers would mismatch the tier-cap source-of-truth + likely under/over-charge customers)", () => {
    expect(body).toMatch(
      /`TIER_CONCURRENT_SESSION_LIMITS`\s*\n?\s*and `PROFILES_PER_TIER` in `@driftstack\/api-types`/,
    );
    expect(body).toMatch(/\|\s*`free`\s*\|\s+1 \|\s+1 \|\s+— \|/);
    expect(body).toMatch(/\|\s*`solo_manual`\s*\|\s+1 \|\s+10 \|\s+600 \|/);
    expect(body).toMatch(/\|\s*`api_starter`\s*\|\s+2 \|\s+25 \|\s+6,000 \|/);
    expect(body).toMatch(/\|\s*`api_builder`\s*\|\s+8 \|\s+100 \|\s+50,000 \|/);
    expect(body).toMatch(/\|\s*`api_scale`\s*\|\s+24 \|\s+500 \|\s+250,000 \|/);
    expect(body).toMatch(/\|\s*`enterprise`\s*\|\s+32 \|\s+custom \|\s+custom \|/);
  });

  it("Auth scoping framing pinned: 'Both endpoints accept any valid bearer (API key OR web session) with read scope. The X-Driftstack-Account header is honored for team scopes per the (member roles read the owner's usage).' + 3-row errors (401 unauthorized + 403 forbidden cross-account + 400 validation-failed days-out-of-range) — pinned so the API-key-OR-web-session + read-scope-sufficient + 3-error-status contract all stay documented", () => {
    expect(body).toMatch(
      /Both endpoints accept any valid bearer \(API key OR web session\)\s*\n?\s*with `read` scope\./,
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
