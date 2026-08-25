// Drift guard for apps/server/src/services/bundled-llm.ts.
// Pins the Arc 1 sub-slice 6.3 bundled-LLM settings lookup service —
// BundledLlmSettings shape + BundledLlmRepo 3-method interface +
// Q4=A 'BYOK ALWAYS wins' resolution-chain framing + the
// startOfCalendarMonthUtc UTC-boundary helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/bundled-llm.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/bundled-llm content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 1 sub-slice 6.3 module-level framing pinned: 'bundled-LLM settings lookup. Single read method: findSettings(accountId) returns the customer's consent flag + monthly cap (cents). Used by the agent-sessions resolution path in sub-slice 6.3 to decide whether to fall through to the deployment Anthropic key when the customer's BYOK is absent or past its v2-#21 TTL.' — pinned so the 6.3 anchor + agent-sessions-resolution-path role + the v2-#21 BYOK TTL cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 1 sub-slice 6\.3 \(v2-#6\) — bundled-LLM settings lookup\./);
    expect(body).toMatch(
      /\/\/ Single read method: `findSettings\(accountId\)` returns the customer's\s*\/\/ consent flag \+ monthly cap \(cents\)\. Used by the agent-sessions\s*\/\/ resolution path in sub-slice 6\.3 to decide whether to fall through\s*\/\/ to the deployment Anthropic key when the customer's BYOK is absent\s*\/\/ or past its v2-#21 TTL\./,
    );
  });

  it("Q4=A 'BYOK ALWAYS wins' framing pinned: 'Q4=A locked: BYOK ALWAYS wins. Bundled-LLM only resolves when there is no BYOK plaintext to use. The resolution chain in routes/agent-sessions.ts encodes this — this service is a pure read.' — pinned so the Q4=A verdict + the resolution-precedence contract + the pure-read role stay documented (drift would silently change the BYOK-vs-bundled precedence which determines who pays for AI chat)", () => {
    expect(body).toMatch(
      /\/\/ Q4=A locked: BYOK ALWAYS wins\. Bundled-LLM only resolves when there\s*\/\/ is no BYOK plaintext to use\. The resolution chain in routes\/\s*\/\/ agent-sessions\.ts encodes this — this service is a pure read\./,
    );
  });

  it("Intentionally-tiny-repo framing pinned: 'The repo is intentionally tiny so the v1.0 surface can land without the cost-recording (sub-slice 6.4) or soft-cap enforcement (6.5) bound up in the same interface. Those follow-ups extend this service with additional methods.' — pinned so the deliberate-minimal-surface + 6.4 + 6.5 cross-reference stay documented", () => {
    expect(body).toMatch(
      /\/\/ The repo is intentionally tiny so the v1\.0 surface can land without\s*\/\/ the cost-recording \(sub-slice 6\.4\) or soft-cap enforcement \(6\.5\)\s*\/\/ bound up in the same interface\. Those follow-ups extend this\s*\/\/ service with additional methods\./,
    );
  });

  it('BundledLlmSettings 2-field shape pinned: consent (Migration 0050 bundled_llm_consent column) + monthlyCapUsdCents (Migration 0050 bundled_llm_monthly_cap_usd_cents column; sub-slice 6.5 enforces, today read-only). Drift to dropping monthlyCapUsdCents would break the sub-slice 6.5 soft-cap enforcement that depends on this field being persisted at the same scope as consent', () => {
    expect(body).toMatch(
      /export interface BundledLlmSettings \{\s*\/\*\* Migration 0050 `bundled_llm_consent` column\. \*\/\s*consent: boolean;\s*\/\*\* Migration 0050 `bundled_llm_monthly_cap_usd_cents` column —\s*\*\s+soft-cap on bundled-LLM spend per calendar month\. Sub-slice 6\.5\s*\*\s+enforces this; today it's read-only\. \*\/\s*monthlyCapUsdCents: number;\s*\}/,
    );
  });

  it("BundledLlmRepo 3-method surface pinned: findSettings + sumMonthlySpendCents (6.5) + updateSettings (6.6). + sumMonthlySpendCents framing pinned: 'sum usage_records.cost_usd_cents over rows where account_id = ? AND record_type = agent_decomposer_bundled AND recorded_at >= start_of_calendar_month derived from now. Returns 0 when there are no matching rows. Used by the route's pre-turn soft-cap check.' — pinned so the cross-table SQL contract (usage_records + record_type filter) + 0-on-empty + pre-turn-check role all stay documented", () => {
    expect(body).toMatch(/export interface BundledLlmRepo \{/);
    expect(body).toMatch(/findSettings\(accountId: string\): Promise<BundledLlmSettings \| null>;/);
    expect(body).toMatch(
      /\* Arc 1 sub-slice 6\.5 \(v2-#6\) — sum `usage_records\.cost_usd_cents`\s*\*\s+over rows where account_id = \? AND record_type =\s*\*\s+'agent_decomposer_bundled' AND recorded_at >= start_of_calendar_month\s*\*\s+derived from `now`\. Returns 0 when there are no matching rows\./,
    );
    expect(body).toMatch(
      /sumMonthlySpendCents\(args: \{ accountId: string; now: Date \}\): Promise<number>;/,
    );
    expect(body).toMatch(/updateSettings\(args: \{/);
  });

  it("updateSettings PATCH-semantics framing pinned: 'partial update on the customer's settings. Either field may be omitted (PATCH semantics). When both omitted, this is a no-op. Returns the post-update settings so the route can echo back what the customer set.' — pinned so the PATCH-semantics + no-op-on-empty + echo-back contract stay documented (drift to PUT semantics would force callers to send both fields on every update)", () => {
    expect(body).toMatch(
      /\* Arc 1 sub-slice 6\.6 \(v2-#6\) — partial update on the customer's\s*\*\s+settings\. Either field may be omitted \(PATCH semantics\)\. When\s*\*\s+both omitted, this is a no-op\. Returns the post-update settings\s*\*\s+so the route can echo back what the customer set\./,
    );
  });

  it('startOfCalendarMonthUtc UTC-boundary pure-function pinned: Date.UTC(year, month, 1, 0, 0, 0, 0). Drift to localtime would break the monthly-cap reset for non-UTC dev environments (the soft-cap depends on the boundary being aligned with the SQL recorded_at filter)', () => {
    expect(body).toMatch(
      /\/\*\* Start-of-calendar-month boundary \(UTC\) for the supplied date\.\s*\*\s+Pure function; exported so tests can pin the boundary\. \*\/\s*export function startOfCalendarMonthUtc\(now: Date\): Date \{\s*return new Date\(Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), 1, 0, 0, 0, 0\)\);\s*\}/,
    );
  });

  it("BundledLlmService.findSettings null-treated-as-consent-false framing pinned: 'Returns null when the account row is missing (treat as consent=false on the resolution path). The route layer defends against this by short-circuiting to 502 when null AND no other BYOK leg resolved.' — pinned so the missing-row-vs-explicit-no semantic + the 502-on-no-resolution short-circuit stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Returns null when the account row is missing \(treat as\s*\*\s+consent=false on the resolution path\)\. The route layer\s*\*\s+defends against this by short-circuiting to 502 when null\s*\*\s+AND no other BYOK leg resolved\. \*\//,
    );
  });

  it('InMemoryBundledLlmRepo default monthly-cap of 2000 cents ($20) on first-update pinned. Drift to a different default would diverge from the migration 0050 server-side default + force every test to set both fields when starting from no-prior-row', () => {
    expect(body).toMatch(
      /const existing = this\.rows\.get\(args\.accountId\) \?\? \{ consent: false, monthlyCapUsdCents: 2000 \};/,
    );
  });

  it("InMemoryBundledLlmRepo.sumMonthlySpendCents sums spend records >= start-of-calendar-month-UTC. Drift to a different inclusivity (> instead of >=) would silently skip the first-second-of-month spend; drift to dropping the start-boundary filter would re-bill prior-month spend against the current month's cap", () => {
    expect(body).toMatch(
      /const start = startOfCalendarMonthUtc\(args\.now\);\s*const arr = this\.monthlySpend\.get\(args\.accountId\) \?\? \[\];\s*let total = 0;\s*for \(const r of arr\) \{\s*if \(r\.at >= start\) total \+= r\.cents;\s*\}/,
    );
  });
});
