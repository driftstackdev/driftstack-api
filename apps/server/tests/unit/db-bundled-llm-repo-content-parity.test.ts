// Drift guard for apps/server/src/db/bundled-llm-repo.ts. Pins
// Arc 1 sub-slice 6.3 Drizzle-backed BundledLlmRepo: reads consent
// + monthly_cap_usd_cents off the accounts row; null when missing
// (caller treats as consent=false). 6.5 soft-cap pre-turn check via
// sumMonthlySpendCents over current calendar month + bundled-LLM
// rows only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/bundled-llm-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/bundled-llm-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 1 sub-slice 6.3 + 6.5 module-level framing pinned: 'Drizzle-backed BundledLlmRepo. Reads bundled_llm_consent + bundled_llm_monthly_cap_usd_cents off the accounts row via a single SELECT. Returns null when the account row is missing (caller treats as consent=false). Arc 1 sub-slice 6.5 — also exposes sumMonthlySpendCents(accountId, now) for the soft-cap pre-turn check. Sums usage_records.cost_usd_cents over the current calendar month for bundled-LLM rows only.' — pinned so the 6.3+6.5 anchors + null-row-as-consent=false + bundled-LLM-rows-only filter contract all stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 1 sub-slice 6\.3 \(v2-#6\) — Drizzle-backed BundledLlmRepo\./);
    expect(body).toMatch(
      /\/\/ Reads bundled_llm_consent \+ bundled_llm_monthly_cap_usd_cents off\s*\/\/ the accounts row via a single SELECT\. Returns null when the account\s*\/\/ row is missing \(caller treats as consent=false\)\./,
    );
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.5 \(v2-#6\) — also exposes\s*\/\/ sumMonthlySpendCents\(accountId, now\) for the soft-cap pre-turn\s*\/\/ check\. Sums usage_records\.cost_usd_cents over the current calendar\s*\/\/ month for bundled-LLM rows only\./,
    );
  });

  it('findSettings 2-field SELECT pinned: consent + cap → BundledLlmSettings (consent + monthlyCapUsdCents). row null → return null (caller treats as consent=false sentinel). Drift to dropping the null branch would crash on accounts deleted between auth + the lookup', () => {
    expect(body).toMatch(
      /\.select\(\{\s*consent: accounts\.bundledLlmConsent,\s*cap: accounts\.bundledLlmMonthlyCapUsdCents,\s*\}\)/,
    );
    expect(body).toMatch(
      /if \(!row\) return null;\s*return \{\s*consent: row\.consent,\s*monthlyCapUsdCents: row\.cap,\s*\};/,
    );
  });

  it("updateSettings PATCH-semantics framing pinned: 'PATCH semantics — only touch the columns that were supplied. No-op when neither field is set; returns current state for echo.' + conditional spread + return this.findSettings(accountId). Drift to spreading undefined fields would clobber the existing value on partial PATCH; drift to dropping the no-op-empty-body branch would issue redundant UPDATEs", () => {
    expect(body).toMatch(
      /\/\/ PATCH semantics — only touch the columns that were supplied\.\s*\/\/ No-op when neither field is set; returns current state for echo\./,
    );
    expect(body).toMatch(
      /const set: Record<string, unknown> = \{\};\s*if \(args\.consent !== undefined\) set\.bundledLlmConsent = args\.consent;\s*if \(args\.monthlyCapUsdCents !== undefined\) \{\s*set\.bundledLlmMonthlyCapUsdCents = args\.monthlyCapUsdCents;\s*\}/,
    );
    expect(body).toMatch(
      /if \(Object\.keys\(set\)\.length > 0\) \{\s*await this\.database\.db\.update\(accounts\)\.set\(set\)\.where\(eq\(accounts\.id, args\.accountId\)\);\s*\}\s*return this\.findSettings\(args\.accountId\);/,
    );
  });

  it("sumMonthlySpendCents calendar-month-start + agent_decomposer_bundled record_type filter + COALESCE-0 framing pinned: startOfCalendarMonthUtc(args.now) + recordType: 'agent_decomposer_bundled' + 'COALESCE so an empty match returns 0 instead of NULL.' + 'SUM is over JSONB metadata.cost_usd_cents — the recorder writes a numeric value there for every bundled row (sub-slice 6.4).' Drift to dropping the COALESCE would let an empty-month customer trip a NaN/null parse; drift to a different record_type filter would mix non-bundled spend into the cap calculation", () => {
    expect(body).toMatch(
      /\/\/ SUM is over JSONB metadata\.cost_usd_cents — the recorder writes\s*\/\/ a numeric value there for every bundled row \(sub-slice 6\.4\)\.\s*\/\/ COALESCE so an empty match returns 0 instead of NULL\./,
    );
    expect(body).toMatch(
      /total: sql<string>`coalesce\(sum\(\s*\(\$\{usageRecords\.metadata\}->>'cost_usd_cents'\)::int\s*\), 0\)`/,
    );
    expect(body).toMatch(/eq\(usageRecords\.recordType, 'agent_decomposer_bundled'\),/);
    expect(body).toMatch(/gte\(usageRecords\.recordedAt, start\),/);
  });

  it('Number.parseInt + Number.isFinite guard pinned: total === undefined → 0 + Number.parseInt(total, 10) + Number.isFinite(parsed) ? parsed : 0. Drift to dropping the isFinite guard would let NaN slip through to the soft-cap comparison (and silently allow billing past the cap)', () => {
    expect(body).toMatch(
      /const total = rows\[0\]\?\.total;\s*if \(total === undefined\) return 0;\s*const parsed = Number\.parseInt\(total, 10\);\s*return Number\.isFinite\(parsed\) \? parsed : 0;/,
    );
  });
});
