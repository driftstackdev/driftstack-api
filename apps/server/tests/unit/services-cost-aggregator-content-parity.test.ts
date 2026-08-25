// W396.B — drift guard for apps/server/src/services/cost-aggregator.ts.
// V-541.H production UsageAggregator wiring V-541.B cost monitoring to
// real V-073 usage data. Today only sessionMinutes is fed from real
// ledger; storage / egress / email / llm dimensions return zero until
// per-account meters land (V-541.I/J/K follow-ups). Drift here either
// breaks the customer-facing /v1/account/cost contract (extra zero
// drops, real lines fabricated from synthetic data) or accidentally
// promotes a zero-meter to a real one before the meter exists.
//
//   • V-541.H framing + V-073 UsageRepo wiring pinned.
//   • Today's-coverage matrix: sessionMinutes only; the other 5
//     dimensions zero pending V-541.I/J/K follow-ups.
//   • Customer-facing /v1/account/cost contract: real compute number
//     + zeros for other lines until meters land.
//   • aggregateForAccount: returns null when window malformed OR
//     sessionMinutes=0.
//   • billingCycleWindow: YYYY-MM regex → [UTC month start, next
//     month start) Date pair; null for malformed input (admin tools
//     show friendlier error than 500).
//   • Month bounds: 1 ≤ month ≤ 12 OR null.
//   • V-541.G prod-bootstrap swap hook framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/cost-aggregator.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W396.B apps/server/src/services/cost-aggregator.ts content parity', () => {
  const body = read(LIB);

  it('V-541.H framing pinned + V-073 UsageRepo wiring + V-541.B cost-monitoring connection', () => {
    expect(body).toMatch(
      /V-541\.H — production UsageAggregator wiring the V-541\.B cost\s*\/\/\s*monitoring service to real usage data from the V-073 UsageRepo/,
    );
  });

  it('6-dimension UsageInputs framing pinned: sessionMinutes / storageGbMonths / egressGb / emailSends / llmInputTokens / llmOutputTokens', () => {
    expect(body).toMatch(
      /The cost estimator's UsageInputs has six dimensions:\s*\/\/\s*sessionMinutes \/ storageGbMonths \/ egressGb \/ emailSends \/\s*\/\/\s*llmInputTokens \/ llmOutputTokens/,
    );
  });

  it('Today-coverage framing: sessionMinutes only (session_minute UsageRecordType) + 4 follow-up meters', () => {
    expect(body).toMatch(
      /Today, the only one we have a per-account ledger for is\s*\/\/\s*session_minute \(UsageRecordType\)/,
    );
    expect(body).toMatch(/- storage: {2}per-account R2 quota \(V-541\.I follow-up\)/);
    expect(body).toMatch(/- egress: {3}TURN \/ R2 egress meter \(V-531 follow-up\)/);
    expect(body).toMatch(
      /- email: {4}Postmark fan-out is account-level but not yet\s*\/\/\s*aggregated into usage_records \(V-541\.J follow-up\)/,
    );
    expect(body).toMatch(
      /- llm: {6}sub-processor tokens are accounted-for in the\s*\/\/\s*LLM-billing module \(V-487\) but not yet rolled\s*\/\/\s*into usage_records \(V-541\.K follow-up\)/,
    );
  });

  it('Customer-facing /v1/account/cost contract framing: real compute + zeros until meters land', () => {
    expect(body).toMatch(
      /For now, the aggregator fills sessionMinutes from real data and\s*\/\/\s*returns zero for the rest\. That matches the customer-facing\s*\/\/\s*\/v1\/account\/cost contract — the customer sees a real compute\s*\/\/\s*number \+ zeros for the other lines until the meters land/,
    );
  });

  it('V-541.G prod-bootstrap swap hook framing pinned (stub aggregator → this implementation when founder ready)', () => {
    expect(body).toMatch(
      /The\s*\/\/\s*V-541\.G prod bootstrap can swap its stub aggregator for this\s*\/\/\s*implementation when the founder is ready to expose real numbers\s*\/\/\s*to customers/,
    );
  });

  it('UsageAggregatorFromUsageRepo class: implements UsageAggregator + constructor injects repo via opts', () => {
    expect(body).toMatch(/export class UsageAggregatorFromUsageRepo implements UsageAggregator \{/);
    expect(body).toMatch(
      /constructor\(private readonly opts: UsageAggregatorFromUsageRepoOpts\) \{\}/,
    );
  });

  it('aggregateForAccount: billingCycleWindow → null OR sessionMinutes=0 → null; else 6-field UsageInputs with zeros', () => {
    expect(body).toMatch(/const window = billingCycleWindow\(args\.billingCycle\);/);
    expect(body).toMatch(/if \(window === null\) return null;/);
    expect(body).toMatch(
      /const totals = await this\.opts\.repo\.totalsForPeriod\(args\.accountId, window\.start, window\.end\);/,
    );
    expect(body).toMatch(/const sessionMinutes = totals\.totals\.session_minute \?\? 0;/);
    expect(body).toMatch(/if \(sessionMinutes === 0\) return null;/);
    expect(body).toMatch(
      /return \{\s*sessionMinutes,\s*\/\/ V-541\.I\/J\/K follow-ups — zero placeholders until the meters\s*\/\/\s*for these dimensions exist at the per-account granularity\.\s*storageGbMonths: 0,\s*egressGb: 0,\s*emailSends: 0,\s*llmInputTokens: 0,\s*llmOutputTokens: 0,\s*\};/,
    );
  });

  it('billingCycleWindow: ^\\d{4}-\\d{2}$ regex; null on malformed (admin-tool friendlier error than 500)', () => {
    expect(body).toMatch(
      /Parse a billing_cycle string \('YYYY-MM'\) into a \[start, end\) UTC\s*\*\s*Date pair\. Returns null for malformed input \(callers treat as no\s*\*\s*usage rather than throwing — admin tools display a friendlier\s*\*\s*error than a 500\)/,
    );
    expect(body).toMatch(
      /export function billingCycleWindow\(billingCycle: string\): \{ start: Date; end: Date \} \| null \{\s*const match = \/\^\(\\d\{4\}\)-\(\\d\{2\}\)\$\/\.exec\(billingCycle\);/,
    );
    expect(body).toMatch(/if \(!match\) return null;/);
  });

  it('billingCycleWindow: month bounds 1..12 OR null (Number.isFinite guard for year + month)', () => {
    expect(body).toMatch(
      /if \(!Number\.isFinite\(year\) \|\| !Number\.isFinite\(month\) \|\| month < 1 \|\| month > 12\) \{\s*return null;\s*\}/,
    );
  });

  it('billingCycleWindow: UTC [start, end) — Date.UTC(year, month-1, 1) to Date.UTC(year, month, 1)', () => {
    expect(body).toMatch(/const start = new Date\(Date\.UTC\(year, month - 1, 1\)\);/);
    expect(body).toMatch(/const end = new Date\(Date\.UTC\(year, month, 1\)\);/);
    expect(body).toMatch(/return \{ start, end \};/);
  });

  it('imports: UsageInputs type + UsageAggregator type + UsageRepo type only', () => {
    expect(body).toMatch(/import type \{ UsageInputs \} from '\.\.\/lib\/cost-estimator\.js';/);
    expect(body).toMatch(/import type \{ UsageAggregator \} from '\.\/cost-monitoring\.js';/);
    expect(body).toMatch(/import type \{ UsageRepo \} from '\.\/usage\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
