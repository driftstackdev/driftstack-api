// W954 — usage service V-073 + ADR-004 unmetered-paid cross-source
// invariant. Two-hundred-eightieth in the drift-guard series. Pins
// the per-billing-period usage aggregation service:
//
//   Service intro — 'Usage service — aggregates usage_records for
//   the current billing period and pairs the totals with tier
//   quotas'.
//
//   Period framing — 'Period definition (Phase 6 default): calendar
//   month UTC. The period start is YYYY-MM-01T00:00:00Z; end is the
//   start of the next month. Customers who need finer granularity
//   can wire in a per-account billing-anchor field later (out of
//   scope for Phase 6)'.
//
//   session_minute → browser_hour future-rename framing — 'FUTURE-
//   SELF NOTE — session_minute rename to browser_hour is deferred
//   to Workstream D (Stripe Meter integration). The unit name is
//   misleading: this column stores minutes of session time (one
//   row per minute of active session). The customer-facing meter
//   is browser-hours (file 127 + V-061), so summary-layer code
//   rolls this up via floor(session_minute_total / 60) =
//   browser_hour_total'.
//
//   UsageRecordType 6-value union: 'session_minute' | 'navigate' |
//     'interact' | 'wait' | 'state_capture' | 'screenshot_capture'.
//
//   ALL_TYPES 6-entry tuple — preserves the UsageRecordType ordering
//     used by /v1/usage summary response.
//
//   ADR-004 paid-tier-unmetered framing — 'paid tiers are concurrent-
//   only; hours metering exists ONLY for the trial pack (via
//   accounts.trial_pack_credit_cents decrement at session_end per
//   ADR-003 — independent of this map). All TIER_QUOTAS values are
//   now null (unmetered) across every tier'.
//
//   V-073 preservation note — 'this map is preserved with null
//   values rather than removed entirely so the /v1/usage summary
//   response shape (which returns quotas: Record<UsageRecordType,
//   number | null>) doesn't change. The customer-visible signal is
//   "no per-meter caps at this tier" rather than the absence of
//   the field'.
//
//   TIER_QUOTAS Record<AccountTier, Record<UsageRecordType, number
//     | null>> — every value null per ADR-004.
//
// stays in lockstep across apps/server/src/services/usage.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W954 V-073 + ADR-004 usage cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/services/usage.ts header pins surface — 'Usage service — aggregates usage_records for the current billing period and pairs the totals with tier quotas'. The aggregate + tier-quota pairing is the central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/Usage service — aggregates usage_records for the current billing period/);
    expect(p).toMatch(/and pairs the totals with tier quotas\./);
  });

  // ─── Period framing (calendar month UTC) ─────────────────────

  it("CRITICAL period framing — 'Period definition (Phase 6 default): calendar month UTC. The period start is YYYY-MM-01T00:00:00Z; end is the start of the next month. Customers who need finer granularity can wire in a per-account billing-anchor field later (out of scope for Phase 6)'. The UTC + calendar-month + future-billing-anchor framing is the V-073 billing-period contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(
      /Period definition \(Phase 6 default\): calendar month UTC\. The period start/,
    );
    expect(p).toMatch(/is `YYYY-MM-01T00:00:00Z`; end is the start of the next month\./);
    expect(p).toMatch(/Customers/);
    expect(p).toMatch(/who need finer granularity can wire in a per-account billing-anchor field/);
    expect(p).toMatch(/later \(out of scope for Phase 6\)\./);
  });

  // ─── session_minute → browser_hour future-rename framing ─────

  it("CRITICAL future-rename framing — 'FUTURE-SELF NOTE — session_minute rename to browser_hour is deferred to Workstream D (Stripe Meter integration). The unit name is misleading: this column stores **minutes** of session time (one row per minute of active session). The customer-facing meter is browser-hours (file 127 + V-061), so summary-layer code rolls this up via floor(session_minute_total / 60) = browser_hour_total'. The deferred-rename + Workstream-D + floor-by-60 conversion is the V-061 meter contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/FUTURE-SELF NOTE — `session_minute` rename to `browser_hour` is/);
    expect(p).toMatch(/deferred to Workstream D \(Stripe Meter integration\)\. The unit name/);
    expect(p).toMatch(/is misleading: this column stores \*\*minutes\*\* of session time \(one/);
    expect(p).toMatch(/row per minute of active session\)\. The customer-facing meter is/);
    expect(p).toMatch(/browser-hours \(file 127 \+ V-061\), so summary-layer code rolls this/);
    expect(p).toMatch(/up via `floor\(session_minute_total \/ 60\) = browser_hour_total`/);
  });

  it("CRITICAL coordinated-breaking-change framing — 'The rename is a coordinated breaking change (Postgres enum migration + 3-SDK regen + OpenAPI version bump) and bundles cleanly with the Stripe Meter event-name introduction in Workstream D — doing it twice would create churn. Until then: anywhere code references session_minute, treat the value as a minute-granular ledger and translate to hours at the API/UI boundary'. The bundle-with-Workstream-D framing is the deferral rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(
      /The\s*\n\/\/ rename is a coordinated breaking change \(Postgres enum migration \+/,
    );
    expect(p).toMatch(/3-SDK regen \+ OpenAPI version bump\) and bundles cleanly with the/);
    expect(p).toMatch(/Stripe Meter event-name introduction in Workstream D — doing it/);
    expect(p).toMatch(/twice would create churn\. Until then: anywhere code references/);
    expect(p).toMatch(/`session_minute`, treat the value as a minute-granular ledger and/);
    expect(p).toMatch(/translate to hours at the API\/UI boundary\./);
  });

  // ─── UsageRecordType 6-value union ───────────────────────────

  it("CRITICAL UsageRecordType 6 values — 'session_minute' | 'navigate' | 'interact' | 'wait' | 'state_capture' | 'screenshot_capture'. The 6-meter taxonomy covers session-time + 5 per-operation counters.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/export type UsageRecordType =/);
    expect(p).toMatch(/\| 'session_minute'/);
    expect(p).toMatch(/\| 'navigate'/);
    expect(p).toMatch(/\| 'interact'/);
    expect(p).toMatch(/\| 'wait'/);
    expect(p).toMatch(/\| 'state_capture'/);
    expect(p).toMatch(/\| 'screenshot_capture';/);
  });

  // ─── ALL_TYPES 6-entry ordered tuple ─────────────────────────

  it("CRITICAL ALL_TYPES const has 6 entries in the same order as UsageRecordType — 'session_minute' + 'navigate' + 'interact' + 'wait' + 'state_capture' + 'screenshot_capture'. The 6-entry ordered tuple is what /v1/usage summary response iteration preserves.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/const ALL_TYPES: UsageRecordType\[\] = \[/);
    expect(p).toMatch(
      /'session_minute',\s*\n\s*'navigate',\s*\n\s*'interact',\s*\n\s*'wait',\s*\n\s*'state_capture',\s*\n\s*'screenshot_capture',/,
    );
  });

  // ─── ADR-004 paid-tier-unmetered framing ─────────────────────

  it("CRITICAL ADR-004 framing — 'Per ADR-004: paid tiers are concurrent-only; no hours metering remains (the one-time trial_pack that decremented a prepaid credit at session_end was retired 2026-05-27). All TIER_QUOTAS values are now null (unmetered) across every tier'. The ADR-004 + concurrent-only design is the unmetered-paid policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/Per ADR-004: paid tiers are concurrent-only; no hours metering/);
    expect(p).toMatch(/remains \(the one-time trial_pack that decremented a prepaid/);
    expect(p).toMatch(/credit at session_end was retired 2026-05-27\)\./);
    expect(p).toMatch(/All TIER_QUOTAS values are now `null` \(unmetered\) across every/);
    expect(p).toMatch(/tier;/);
  });

  it("CRITICAL session_minute-as-ledger framing — 'the session_minute usage_record_type stays as the granular ledger primitive for analytics + abuse detection but is not gated against a per-tier cap. Operation-count meters (navigate / interact / wait / state_capture / screenshot_capture) likewise remain unmetered scaffolding'. The ledger-not-cap + scaffolding-only contract is the ADR-004 retention rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/the `session_minute` usage_record_type stays as the granular/);
    expect(p).toMatch(/ledger primitive for analytics \+ abuse detection but is not gated/);
    expect(p).toMatch(/against a per-tier cap\. Operation-count meters \(navigate \/ interact/);
    expect(p).toMatch(/\/ wait \/ state_capture \/ screenshot_capture\) likewise remain/);
    expect(p).toMatch(/unmetered scaffolding\./);
  });

  // ─── V-073 quota-shape preservation framing ──────────────────

  it("CRITICAL V-073 NOTE framing — 'this map is preserved with null values rather than removed entirely so the /v1/usage summary response shape (which returns quotas: Record<UsageRecordType, number | null>) doesn't change. The customer-visible signal is \"no per-meter caps at this tier\" rather than the absence of the field'. The preserve-shape + null-signal design is the V-073 backward-compat contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(/V-073 NOTE: this map is preserved with `null` values rather than/);
    expect(p).toMatch(/removed entirely so the `\/v1\/usage` summary response shape \(which/);
    expect(p).toMatch(/returns `quotas: Record<UsageRecordType, number \| null>`\) doesn't/);
    expect(p).toMatch(/change\. The customer-visible signal is "no per-meter caps at this/);
    expect(p).toMatch(/tier" rather than the absence of the field\./);
  });

  // ─── TIER_QUOTAS shape ───────────────────────────────────────

  it('CRITICAL TIER_QUOTAS = Record<AccountTier, Record<UsageRecordType, number | null>> — 2D map. The 2D shape with nullable values lets every tier have a per-meter quota slot that defaults to null (unmetered).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/usage.ts'));
    expect(p).toMatch(
      /const TIER_QUOTAS: Record<AccountTier, Record<UsageRecordType, number \| null>> = \{/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/usage-v073-adr004-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
