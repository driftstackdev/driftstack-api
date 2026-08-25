// W408.B — drift guard for apps/server/src/services/usage.ts.
// Customer usage stats — aggregates usage_records for current
// calendar-month-UTC period + pairs totals with tier quotas. Drift
// here either accidentally enables per-tier quota enforcement
// (ADR-004 says paid tiers are concurrent-only — no per-meter caps)
// or scrambles the session_minute → browser_hour translation
// posture (Workstream D deferred rename).
//
//   • Period definition framing pinned: calendar month UTC (period
//     start YYYY-MM-01T00:00:00Z; end = start of next month);
//     Phase 6 default; per-account billing-anchor deferred.
//   • UsageRecordType: 6-literal union (session_minute / navigate /
//     interact / wait / state_capture / screenshot_capture).
//   • FUTURE-SELF NOTE framing pinned: session_minute → browser_
//     hour rename deferred to Workstream D (Stripe Meter
//     integration); session_minute stores minutes; customer-facing
//     meter is browser-hours via floor(/60).
//   • ADR-004 framing pinned: paid tiers concurrent-only; trial pack
//     hours metering via accounts.trial_pack_credit_cents at
//     session_end per ADR-003 (independent of this map); all
//     TIER_QUOTAS values null across every tier.
//   • V-073 NOTE: map preserved with null rather than removed so
//     /v1/usage response shape unchanged.
//   • TIER_QUOTAS: 8 tiers × 6 record types = 48 nulls; covers
//     trial_pack / solo_manual / team_manual / agency_manual /
//     api_starter / api_builder / api_scale / enterprise.
//   • summaryFor: monthStartUtc(now) + nextMonthStartUtc; fullTotals
//     defaults all 6 types to 0; quotas mirrors TIER_QUOTAS[tier].
//   • V-170 dailySeries: clampedDays = max(1, min(days, 90));
//     fromDate = toDate - clampedDays*day; fills missing buckets
//     with empty (sparkline gap handling) + V-330e team-owner
//     effectiveAccountId.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/usage.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W408.B apps/server/src/services/usage.ts content parity', () => {
  const body = read(LIB);

  it('Period definition framing pinned: calendar month UTC + Phase 6 default + per-account billing-anchor deferred', () => {
    expect(body).toMatch(
      /Period definition \(Phase 6 default\): calendar month UTC\. The period start\s*\/\/\s*is `YYYY-MM-01T00:00:00Z`; end is the start of the next month\. Customers\s*\/\/\s*who need finer granularity can wire in a per-account billing-anchor field\s*\/\/\s*later \(out of scope for Phase 6\)\./,
    );
  });

  it('FUTURE-SELF NOTE framing pinned: session_minute → browser_hour rename deferred to Workstream D Stripe Meter', () => {
    expect(body).toMatch(
      /FUTURE-SELF NOTE — `session_minute` rename to `browser_hour` is\s*\/\/\s*deferred to Workstream D \(Stripe Meter integration\)\./,
    );
    expect(body).toMatch(
      /The customer-facing meter is\s*\/\/\s*browser-hours \(file 127 \+ V-061\), so summary-layer code rolls this\s*\/\/\s*up via `floor\(session_minute_total \/ 60\) = browser_hour_total`\./,
    );
    expect(body).toMatch(
      /The\s*\/\/\s*rename is a coordinated breaking change \(Postgres enum migration \+\s*\/\/\s*3-SDK regen \+ OpenAPI version bump\) and bundles cleanly with the\s*\/\/\s*Stripe Meter event-name introduction in Workstream D/,
    );
  });

  it('UsageRecordType: 6-literal union (session_minute / navigate / interact / wait / state_capture / screenshot_capture)', () => {
    expect(body).toMatch(
      /export type UsageRecordType =\s*\| 'session_minute'\s*\| 'navigate'\s*\| 'interact'\s*\| 'wait'\s*\| 'state_capture'\s*\| 'screenshot_capture';/,
    );
  });

  it('ALL_TYPES array mirrors 6-literal union order (session_minute first)', () => {
    expect(body).toMatch(
      /const ALL_TYPES: UsageRecordType\[\] = \[\s*'session_minute',\s*'navigate',\s*'interact',\s*'wait',\s*'state_capture',\s*'screenshot_capture',\s*\];/,
    );
  });

  it('ADR-004 framing pinned: paid tiers concurrent-only; no hours metering remains (trial_pack retired 2026-05-27); all TIER_QUOTAS null', () => {
    expect(body).toMatch(
      /\/\/ Per ADR-004: paid tiers are concurrent-only; no hours metering\s*\/\/ remains \(the one-time trial_pack that decremented a prepaid\s*\/\/ credit at session_end was retired 2026-05-27\)\./,
    );
    expect(body).toMatch(
      /\/\/ All TIER_QUOTAS values are now `null` \(unmetered\) across every\s*\/\/ tier; the `session_minute` usage_record_type stays as the granular\s*\/\/ ledger primitive for analytics \+ abuse detection but is not gated\s*\/\/ against a per-tier cap\./,
    );
  });

  it('V-073 NOTE framing pinned: map preserved with null rather than removed so /v1/usage response shape unchanged', () => {
    expect(body).toMatch(
      /\/\/ V-073 NOTE: this map is preserved with `null` values rather than\s*\/\/ removed entirely so the `\/v1\/usage` summary response shape \(which\s*\/\/ returns `quotas: Record<UsageRecordType, number \| null>`\) doesn't\s*\/\/ change\./,
    );
  });

  it('TIER_QUOTAS: 8 tiers covered (free / solo_manual / team_manual / agency_manual / api_starter / api_builder / api_scale / enterprise)', () => {
    expect(body).toMatch(
      /const TIER_QUOTAS: Record<AccountTier, Record<UsageRecordType, number \| null>> = \{/,
    );
    expect(body).toMatch(/free: \{/);
    expect(body).toMatch(/solo_manual: \{/);
    expect(body).toMatch(/team_manual: \{/);
    expect(body).toMatch(/agency_manual: \{/);
    expect(body).toMatch(/api_starter: \{/);
    expect(body).toMatch(/api_builder: \{/);
    expect(body).toMatch(/api_scale: \{/);
    expect(body).toMatch(/enterprise: \{/);
  });

  it('summaryFor: monthStartUtc(now) + nextMonthStartUtc(periodStart); fullTotals defaults all 6 types to 0; quotas mirrors TIER_QUOTAS[tier]', () => {
    expect(body).toMatch(
      /const periodStart = monthStartUtc\(now\);\s*const periodEnd = nextMonthStartUtc\(periodStart\);/,
    );
    expect(body).toMatch(
      /const fullTotals: Record<UsageRecordType, number> = \{\s*session_minute: 0,\s*navigate: 0,\s*interact: 0,\s*wait: 0,\s*state_capture: 0,\s*screenshot_capture: 0,\s*\};/,
    );
    expect(body).toMatch(/for \(const t of ALL_TYPES\) \{\s*fullTotals\[t\] = totals\[t\] \?\? 0;/);
    expect(body).toMatch(/quotas: TIER_QUOTAS\[tier\],/);
  });

  it('V-170 dailySeries: clampedDays = max(1, min(days, 90)); fills missing buckets with empty (sparkline gap-free)', () => {
    expect(body).toMatch(
      /V-170 — daily series for the most recent N days \(default 30, max 90\)\./,
    );
    expect(body).toMatch(/const clampedDays = Math\.max\(1, Math\.min\(days, 90\)\);/);
    expect(body).toMatch(
      /\/\/ Fill missing days with empty buckets so the response is contiguous\s*\/\/ \(sparkline rendering doesn't need to handle gaps\)\./,
    );
    expect(body).toMatch(
      /buckets\.push\(\{ date: dateStr, totals: byDate\.get\(dateStr\) \?\? \{\} \}\);/,
    );
  });

  it("V-170 dailySeries empty-buckets framing: writers aren't wired in production today (V-014/V-015 amendment); endpoint returns contract shape with zeros", () => {
    expect(body).toMatch(
      /Today the buckets are all empty because usage_records writers\s*\*\s*aren't wired in production code \(per V-014\/V-015 amendment \+\s*\*\s*usage\.ts:51-53 comment\)\. The endpoint returns the contract shape\s*\*\s*with zeros; once writers land, the dashboard auto-populates\./,
    );
  });

  it("V-330e dailySeries: effectiveAccountId pulls OWNER's daily buckets via team RBAC; tier-quotas not needed (just bucket counts)", () => {
    expect(body).toMatch(
      /\/\/ V-330e — pull the OWNER's daily buckets when called via team\s*\/\/ RBAC\. Tier-derived quotas don't apply to the series response\s*\/\/ shape \(it's just bucket counts\), so we don't need the owner's\s*\/\/ tier here\./,
    );
    expect(body).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
  });

  it('UsageDailyBucket: date YYYY-MM-DD UTC + totals Partial<Record>; dailyBucketsForRange returns INCLUDING zero-usage days', () => {
    expect(body).toMatch(
      /V-170 — one daily bucket of usage totals\. Date is the UTC day in `YYYY-MM-DD`\./,
    );
    expect(body).toMatch(
      /export interface UsageDailyBucket \{\s*date: string;\s*totals: Partial<Record<UsageRecordType, number>>;\s*\}/,
    );
    expect(body).toMatch(
      /V-170 — daily aggregation in `\[fromDate, toDate\)` \(toDate exclusive\)\.\s*\*\s*Returns one bucket per UTC day, INCLUDING days with zero usage/,
    );
  });

  it('dayStartUtc + monthStartUtc + nextMonthStartUtc helpers: Date.UTC constructor (no local-tz drift)', () => {
    expect(body).toMatch(
      /function dayStartUtc\(now: Date\): Date \{\s*return new Date\(Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), now\.getUTCDate\(\)\)\);\s*\}/,
    );
    expect(body).toMatch(
      /function monthStartUtc\(now: Date\): Date \{\s*return new Date\(Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), 1\)\);\s*\}/,
    );
    expect(body).toMatch(
      /function nextMonthStartUtc\(monthStart: Date\): Date \{\s*return new Date\(Date\.UTC\(monthStart\.getUTCFullYear\(\), monthStart\.getUTCMonth\(\) \+ 1, 1\)\);/,
    );
  });

  it('UsageSummary 5-field response shape (periodStart/periodEnd/tier/totals/quotas)', () => {
    expect(body).toMatch(/export interface UsageSummary \{/);
    expect(body).toMatch(/periodStart: Date;/);
    expect(body).toMatch(/periodEnd: Date;/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/totals: Record<UsageRecordType, number>;/);
    expect(body).toMatch(/quotas: Record<UsageRecordType, number \| null>;/);
  });

  it('imports: AccountContext + AccountTier types', () => {
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
