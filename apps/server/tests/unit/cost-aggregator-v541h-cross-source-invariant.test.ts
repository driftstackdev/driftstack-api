// W925 — V-541.H cost-aggregator zero-placeholder cross-source
// invariant. Two-hundred-fifty-first in the drift-guard series.
// Pins the production UsageAggregator wiring contract:
//
//   V-541.H anchor — 'production UsageAggregator wiring the V-541.B
//   cost monitoring service to real usage data from the V-073
//   UsageRepo'.
//
//   UsageInputs 6-dimension shape:
//     - sessionMinutes (the ONLY dimension wired today).
//     - storageGbMonths (V-541.I follow-up — R2 quota).
//     - egressGb (V-531 follow-up — TURN/R2 egress).
//     - emailSends (V-541.J follow-up — Postmark fan-out).
//     - llmInputTokens (V-541.K follow-up — V-487 LLM tokens).
//     - llmOutputTokens (V-541.K follow-up — V-487 LLM tokens).
//
//   Per-account meter status:
//     - session_minute: per-account ledger EXISTS in UsageRepo.
//     - storage: V-541.I follow-up (R2 quota per-account).
//     - egress: V-531 follow-up (TURN/R2 egress meter).
//     - email: V-541.J follow-up (Postmark account-level not yet
//       aggregated into usage_records).
//     - llm: V-541.K follow-up (LLM-billing V-487 tokens not yet
//       rolled into usage_records).
//
//   For now: aggregator fills sessionMinutes from real data; returns
//   zero for the rest. Matches customer-facing /v1/account/cost
//   contract — customer sees real compute + zeros for other lines
//   until meters land.
//
//   billingCycleWindow('YYYY-MM') returns [start of UTC month,
//     start of next) Date pair OR null for malformed input.
//
//   aggregateForAccount returns null when account has zero usage
//     rows in window — CostMonitoringService interprets null as
//     'no usage in cycle' and returns synthetic-zero to customer.
//
// stays in lockstep across apps/server/src/services/cost-aggregator.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billingCycleWindow } from '../../src/services/cost-aggregator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W925 V-541.H cost-aggregator cross-source invariant', () => {
  // ─── V-541.H anchor + V-541.B + V-073 wiring ─────────────────

  it("CRITICAL apps/server/src/services/cost-aggregator.ts header pins V-541.H anchor — 'V-541.H — production UsageAggregator wiring the V-541.B cost monitoring service to real usage data from the V-073 UsageRepo'. The V-541.H + V-541.B + V-073 chain is the dependency-provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/V-541\.H — production UsageAggregator wiring the V-541\.B cost/);
    expect(p).toMatch(/monitoring service to real usage data from the V-073 UsageRepo/);
  });

  // ─── 6-dimension UsageInputs framing ─────────────────────────

  it("CRITICAL header pins UsageInputs 6 dimensions — 'sessionMinutes / storageGbMonths / egressGb / emailSends / llmInputTokens / llmOutputTokens'. The 6-dimension envelope is what the cost-estimator consumes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/sessionMinutes \/ storageGbMonths \/ egressGb \/ emailSends \//);
    expect(p).toMatch(/llmInputTokens \/ llmOutputTokens/);
  });

  // ─── Per-dimension follow-up V-NNN status ────────────────────

  it("CRITICAL per-dimension follow-up framing — 'storage: per-account R2 quota (V-541.I follow-up)' + 'egress: TURN / R2 egress meter (V-531 follow-up)' + 'email: Postmark fan-out is account-level but not yet aggregated into usage_records (V-541.J follow-up)' + 'llm: sub-processor tokens are accounted-for in the LLM-billing module (V-487) but not yet rolled into usage_records (V-541.K follow-up)'. The 4 follow-up anchors track meter-implementation status per dimension.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/storage: {2}per-account R2 quota \(V-541\.I follow-up\)/);
    expect(p).toMatch(/egress: {3}TURN \/ R2 egress meter \(V-531 follow-up\)/);
    expect(p).toMatch(/email: {4}Postmark fan-out is account-level but not yet/);
    expect(p).toMatch(/aggregated into usage_records \(V-541\.J follow-up\)/);
    expect(p).toMatch(/llm: {6}sub-processor tokens are accounted-for in the/);
    expect(p).toMatch(/LLM-billing module \(V-487\) but not yet rolled/);
    expect(p).toMatch(/into usage_records \(V-541\.K follow-up\)/);
  });

  // ─── Zero-placeholder framing ────────────────────────────────

  it("CRITICAL zero-placeholder framing — 'the aggregator fills sessionMinutes from real data and returns zero for the rest. That matches the customer-facing /v1/account/cost contract — the customer sees a real compute number + zeros for the other lines until the meters land'. The zero-placeholder design lets the API expose the 6-dim shape without 4 of the 6 meters being live.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/For now, the aggregator fills sessionMinutes from real data and/);
    expect(p).toMatch(/returns zero for the rest\. That matches the customer-facing/);
    expect(p).toMatch(/\/v1\/account\/cost contract — the customer sees a real compute/);
    expect(p).toMatch(/number \+ zeros for the other lines until the meters land/);
  });

  it('CRITICAL aggregateForAccount returns 5 zero placeholders — storageGbMonths: 0, egressGb: 0, emailSends: 0, llmInputTokens: 0, llmOutputTokens: 0. Mechanically verified via source pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/storageGbMonths: 0,/);
    expect(p).toMatch(/egressGb: 0,/);
    expect(p).toMatch(/emailSends: 0,/);
    expect(p).toMatch(/llmInputTokens: 0,/);
    expect(p).toMatch(/llmOutputTokens: 0,/);
  });

  // ─── V-541.G stub-swap framing ───────────────────────────────

  it("CRITICAL V-541.G stub-swap framing — 'The V-541.G prod bootstrap can swap its stub aggregator for this implementation when the founder is ready to expose real numbers to customers'. The stub-swap is the V-541.H rollout strategy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/The\s*\n\/\/ V-541\.G prod bootstrap can swap its stub aggregator for this/);
    expect(p).toMatch(/implementation when the founder is ready to expose real numbers/);
    expect(p).toMatch(/to customers/);
  });

  // ─── aggregateForAccount null when zero usage ────────────────

  it('CRITICAL aggregateForAccount null framing — \'Returns null when the account has zero usage rows in the window — the caller (CostMonitoringService) interprets null as "no usage in cycle" and returns synthetic-zero to the customer\'. The null-as-no-usage contract is the caller-contract for synthetic-zero.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/Returns null when the account has zero usage rows in the window/);
    expect(p).toMatch(/— the caller \(CostMonitoringService\) interprets null as "no/);
    expect(p).toMatch(/usage in cycle" and returns synthetic-zero to the customer/);
  });

  it("CRITICAL aggregateForAccount returns null when sessionMinutes is 0 — 'if (sessionMinutes === 0) return null'. Mechanically verified.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/if \(sessionMinutes === 0\) return null;/);
  });

  // ─── billingCycleWindow YYYY-MM parser ───────────────────────

  it("CRITICAL billingCycleWindow JSDoc — 'Parse a billing_cycle string (YYYY-MM) into a [start, end) UTC Date pair. Returns null for malformed input (callers treat as no usage rather than throwing — admin tools display a friendlier error than a 500)'. The null-on-malformed is what keeps admin tools robust against bad input.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/Parse a billing_cycle string \('YYYY-MM'\) into a \[start, end\) UTC/);
    expect(p).toMatch(/Date pair\. Returns null for malformed input \(callers treat as no/);
    expect(p).toMatch(/usage rather than throwing — admin tools display a friendlier/);
    expect(p).toMatch(/error than a 500\)/);
  });

  it("CRITICAL billingCycleWindow uses regex '^(\\d{4})-(\\d{2})$' — 4 digits / 2 digits with hyphen. The strict regex prevents '2026-1' / '26-05' / '2026-13' from squeaking through.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/const match = \/\^\(\\d\{4\}\)-\(\\d\{2\}\)\$\/\.exec\(billingCycle\);/);
  });

  it("CRITICAL billingCycleWindow validates month 1..12 — 'month < 1 || month > 12' rejected. The bound check rejects '2026-00' / '2026-13' / negative months.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts'));
    expect(p).toMatch(/month < 1 \|\| month > 12/);
  });

  // ─── Runtime parser parity ───────────────────────────────────

  it("CRITICAL billingCycleWindow('2026-05') returns UTC [May 1, June 1). The 31-day May window verified mechanically.", () => {
    const out = billingCycleWindow('2026-05')!;
    expect(out.start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(out.end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it("CRITICAL billingCycleWindow('2026-12') returns UTC [Dec 1, Jan 1 of next year). The year-rollover is what month=12 → month+1=13 → JS Date Date.UTC(year, 12, 1) handles.", () => {
    const out = billingCycleWindow('2026-12')!;
    expect(out.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(out.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it("CRITICAL billingCycleWindow returns null for malformed input — '2026-1' (1 digit), '26-05' (2-digit year), '2026/05' (slash), '2026-13' (invalid month), '' (empty), 'abc' (non-numeric). The 6 malformed cases prove the 'callers treat as no usage rather than throwing' contract.", () => {
    expect(billingCycleWindow('2026-1')).toBeNull();
    expect(billingCycleWindow('26-05')).toBeNull();
    expect(billingCycleWindow('2026/05')).toBeNull();
    expect(billingCycleWindow('2026-13')).toBeNull();
    expect(billingCycleWindow('2026-00')).toBeNull();
    expect(billingCycleWindow('')).toBeNull();
    expect(billingCycleWindow('abc')).toBeNull();
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-aggregator-v541h-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });

  it("CRITICAL bootstrap.ts does not still describe the aggregator as a stub. V-541.H's note was ADDED below the V-541.G paragraph rather than replacing it, so for one release the file said both that the aggregator returns null and that it reads the real ledger — and the routes it claimed 'always return no usage in cycle' were returning measured usage. Two adjacent paragraphs, opposite claims, and this invariant green throughout.", () => {
    const boot = read(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
    expect(boot, 'the real aggregator is no longer wired').toMatch(
      /aggregator: new UsageAggregatorFromUsageRepo\(/,
    );
    // V-1017 — the retracted paragraph called it a stub returning null.
    expect(boot, 'bootstrap.ts calls the aggregator a stub again').not.toMatch(
      /aggregator is a stub\s*\n?\s*\/\/\s*returning null/,
    );
    expect(
      boot,
      'bootstrap.ts says the cost routes always return an empty cycle again',
    ).not.toMatch(/always return "no usage in\s*\n?\s*\/\/\s*cycle"/);
  });
});
