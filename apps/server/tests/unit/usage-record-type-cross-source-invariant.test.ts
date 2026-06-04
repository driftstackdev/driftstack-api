// W857 — UsageRecordType 6-value cross-source invariant. One-
// hundred-eighty-third in the drift-guard series. Pins the 6-value
// billing-usage record-type enum:
//   1. session_minute     — V-148 metered session-time (minute-precision).
//   2. navigate           — driver call: navigate().
//   3. interact           — driver call: interact(...).
//   4. wait               — driver call: wait(...).
//   5. state_capture      — driver call: capture state.
//   6. screenshot_capture — driver call: capture screenshot.
// stays in lockstep across:
//   - packages/api-types/src/usage.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//
// Drift in any of these — adding a billable event without
// coordinated Go SDK + DB updates — would silently let the
// metering pipeline drop the event (no pgEnum value to persist)
// OR let the Go SDK customer attempt to query totals for an
// event the server doesn't track.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageRecordTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const USAGE_RECORD_TYPES = [
  'session_minute',
  'navigate',
  'interact',
  'wait',
  'state_capture',
  'screenshot_capture',
] as const;

// Server-internal cost-accounting record types that are INTENTIONALLY absent
// from the customer-facing api-types UsageRecordTypeSchema: the usage-repo
// aggregation filters them out of customer totals (db/usage-repo.ts
// INTERNAL_RECORD_TYPES — SQL `ne(...)` + a JS skip), so a customer /v1/usage
// response keyed by UsageRecordType never carries them. They exist only in the
// DB pgEnum (migrations 0046/0051). Pinned here so the pgEnum's superset over
// api-types stays EXACT + documented — see [[project_admin_audit_action_enum_drift_fixed]]
// for why an undocumented pgEnum→api-types delta is a drift hazard.
const INTERNAL_ONLY_RECORD_TYPES = ['agent_decomposer', 'agent_decomposer_bundled'] as const;

describe('W857 UsageRecordType cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/usage.ts UsageRecordTypeSchema = z.enum([6 values]). The 6-value closed-roster is the contract every billing-quota check pivots on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/export const UsageRecordTypeSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 6-value set, not merely
    // contain it — a 7th record type would silently pass the body-subset check
    // below (the weak pattern that let the WebhookEventType roster drift).
    expect(UsageRecordTypeSchema.options).toEqual([...USAGE_RECORD_TYPES]);
    const m = p.match(/UsageRecordTypeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'UsageRecordTypeSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const t of USAGE_RECORD_TYPES) {
      expect(body, `UsageRecordTypeSchema must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts usageRecordType = pgEnum('usage_record_type', [6 customer + 2 internal]). Postgres rejects INSERTs of unknown values — drift would drop billable events.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/usageRecordType = pgEnum\('usage_record_type', \[/);
    const m = p.match(/usageRecordType = pgEnum\('usage_record_type', \[([\s\S]+?)\]\);/);
    expect(m, 'usageRecordType pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const t of USAGE_RECORD_TYPES) {
      expect(body, `pgEnum must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
    // 2026-06-05 anti-recurrence — the pgEnum is a SUPERSET of the customer
    // api-types enum by EXACTLY the documented internal-only record types, no
    // more. A prior subset-only check here would let a new pgEnum value lead
    // api-types silently (the drift class that broke the admin audit-log filter
    // — [[project_admin_audit_action_enum_drift_fixed]]). This EXACT-set pin
    // forces a conscious choice for any new usage_record_type: expose it to
    // customers (add to USAGE_RECORD_TYPES + api-types) or mark it internal
    // (add to INTERNAL_ONLY_RECORD_TYPES + the usage-repo filter).
    const pgValues = ((body ?? '').match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
    expect(new Set(pgValues)).toEqual(
      new Set([...USAGE_RECORD_TYPES, ...INTERNAL_ONLY_RECORD_TYPES]),
    );
  });

  it('CRITICAL the internal-only record types (agent_decomposer + agent_decomposer_bundled) are filtered out of customer usage totals by db/usage-repo.ts INTERNAL_RECORD_TYPES — they must NOT leak into the api-types UsageRecordType-keyed response.', () => {
    const repo = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(repo).toMatch(
      /INTERNAL_RECORD_TYPES = \['agent_decomposer', 'agent_decomposer_bundled'\]/,
    );
    // The aggregation excludes them (SQL ne(...) filter + a defensive JS skip).
    expect(repo).toMatch(/INTERNAL_RECORD_TYPES\[0\]/);
    expect(repo).toMatch(/INTERNAL_RECORD_TYPES as readonly string\[\]\)\.includes/);
    // And none of them appear in the customer-facing api-types enum.
    for (const internal of INTERNAL_ONLY_RECORD_TYPES) {
      expect(
        USAGE_RECORD_TYPES.includes(internal as (typeof USAGE_RECORD_TYPES)[number]),
        `${internal} must stay internal-only (absent from the customer enum)`,
      ).toBe(false);
    }
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 6 UsageRecordType consts — UsageSessionMinute + UsageNavigate + UsageInteract + UsageWait + UsageStateCapture + UsageScreenshotCapture. Each maps to one canonical record-type string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type UsageRecordType string/);
    expect(p).toMatch(/UsageSessionMinute\s+UsageRecordType = "session_minute"/);
    expect(p).toMatch(/UsageNavigate\s+UsageRecordType = "navigate"/);
    expect(p).toMatch(/UsageInteract\s+UsageRecordType = "interact"/);
    expect(p).toMatch(/UsageWait\s+UsageRecordType = "wait"/);
    expect(p).toMatch(/UsageStateCapture\s+UsageRecordType = "state_capture"/);
    expect(p).toMatch(/UsageScreenshotCapture UsageRecordType = "screenshot_capture"/);
  });

  it('CRITICAL Go SDK exposes UsageTotals + UsageQuotas as map[UsageRecordType]int. The typed-map signature locks consumers into the closed-enum keys — drift to a string-keyed map would silently weaken type-safety.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type UsageTotals map\[UsageRecordType\]int/);
    expect(p).toMatch(/type UsageQuotas map\[UsageRecordType\]\*int/);
  });

  // ─── Records use z.record(UsageRecordTypeSchema, ...) ────────

  it('CRITICAL api-types UsageSummary + UsagePeriodSummary use z.record(UsageRecordTypeSchema, ...) for totals + quotas. The Zod record-with-enum-key pattern enforces all 6 record-types must be present (or none extra). Drift to z.record(z.string(), ...) would weaken type-safety.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    // totals: z.record(UsageRecordTypeSchema, z.number()...).
    expect(p).toMatch(
      /totals: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\)/,
    );
    // quotas: z.record(UsageRecordTypeSchema, z.number()...nullable()).
    expect(p).toMatch(
      /quotas: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\)\)/,
    );
  });

  // ─── Customer-dashboard usage.astro tile-keys ────────────────

  it("CRITICAL customer-dashboard usage.astro tile-update loop iterates the 5 visible record-types (session_minute + navigate + interact + screenshot_capture + state_capture) — 'wait' is intentionally NOT rendered as a tile (it's tracked but not customer-facing-prominent). Drift to dropping any visible tile-key would silently break the dashboard tile update.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro'));
    expect(p).toMatch(
      /'session_minute',\s*\n\s*'navigate',\s*\n\s*'interact',\s*\n\s*'screenshot_capture',\s*\n\s*'state_capture',/,
    );
  });

  // ─── 6-value cardinality + categorization ─────────────────────

  it('CRITICAL UsageRecordType = EXACTLY 6 values — 1 session-level (session_minute) + 3 driver-action (navigate/interact/wait) + 2 capture (state_capture/screenshot_capture). The category split is what billing-tier quotas branch on.', () => {
    expect(USAGE_RECORD_TYPES.length).toBe(6);
    const sessionLevel = USAGE_RECORD_TYPES.filter((t) => t === 'session_minute');
    const driverAction = USAGE_RECORD_TYPES.filter((t) =>
      (['navigate', 'interact', 'wait'] as const).includes(t as 'navigate' | 'interact' | 'wait'),
    );
    const captureType = USAGE_RECORD_TYPES.filter((t) => t.endsWith('_capture'));
    expect(sessionLevel.length).toBe(1);
    expect(driverAction.length).toBe(3);
    expect(captureType.length).toBe(2);
  });

  // ─── No forbidden / legacy record-type names ─────────────────

  it("CRITICAL no source declares forbidden record-type names (api_call / request / event / page_view / browse). These are common metering conventions the 6-value model intentionally avoids — Driftstack meters driver-actions, not REST-style 'api_call'.", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    const forbidden = ['api_call', 'request', 'event', 'page_view', 'browse'];
    const m = apiTypes.match(/UsageRecordTypeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `UsageRecordType must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/usage-record-type-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
