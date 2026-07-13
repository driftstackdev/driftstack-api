// Drift guard for apps/server/src/routes/account-bundled-llm.ts.
// Pins Arc 1 sub-slice 6.6 + 6.7 (v2-#6) customer-facing bundled-LLM
// settings + status. Q4=A locked: BYOK always wins. Drift to flipping
// consent silently billing customers would break the Q4=A trust
// contract; drift to dropping the 1_000_000-cent ceiling would let
// customers bypass the migration 0050 CHECK backstop at the route
// layer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-bundled-llm.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/account-bundled-llm content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 1 sub-slice 6.6 module-level framing pinned: 'customer-facing bundled-LLM settings. Surface: GET /v1/account/me/bundled-llm-settings — read current state + PATCH /v1/account/me/bundled-llm-settings — flip consent +/or cap + GET /v1/account/me/bundled-llm-status — spend + remaining (sub-slice 6.7).' — pinned so the 6.6 + 6.7 anchors + 3-endpoint surface roster + read/patch/status purpose all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.6 \(v2-#6\) — customer-facing bundled-LLM settings\./,
    );
    expect(body).toMatch(
      /\/\/\s+GET\s+\/v1\/account\/me\/bundled-llm-settings\s+— read current state\s*\n?\s*\/\/\s+PATCH \/v1\/account\/me\/bundled-llm-settings\s+— flip consent \+\/or cap\s*\n?\s*\/\/\s+GET\s+\/v1\/account\/me\/bundled-llm-status\s+— spend \+ remaining \(sub-slice 6\.7\)/,
    );
  });

  it("Migration 0050 CHECK-constraint range invariant framing pinned: 'monthly_cap_usd_cents ∈ [0, 1_000_000] (i.e. $0 to $10,000). The server rejects out-of-range inputs with 400; the CHECK is a defence-in-depth backstop if the route validation is ever skipped.' — pinned so the migration-0050 + 0-to-1M cent range + $10,000 ceiling + defence-in-depth-CHECK contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Same range invariants as the migration 0050 CHECK constraint:\s*\n?\s*\/\/ monthly_cap_usd_cents ∈ \[0, 1_000_000\] \(i\.e\. \$0 to \$10,000\)\. The\s*\n?\s*\/\/ server rejects out-of-range inputs with 400; the CHECK is a\s*\n?\s*\/\/ defence-in-depth backstop if the route validation is ever skipped\./,
    );
  });

  it("Q4=A BYOK-always-wins framing pinned: 'BYOK always wins. Flipping consent=true does NOT silently bill customers — bundled-LLM only resolves at turn time when no BYOK key (header or stored) is available AND the soft-cap hasn't been reached (sub-slice 6.5).' — pinned so the Q4=A verdict + BYOK-priority + soft-cap-gating-resolution contract all stay documented (drift to letting consent=true silently bill bundled-LLM regardless of BYOK availability would break the customer-trust contract)", () => {
    expect(body).toMatch(
      /\/\/ Q4=A locked: BYOK always wins\. Flipping consent=true does NOT\s*\n?\s*\/\/ silently bill customers — bundled-LLM only resolves at turn time\s*\n?\s*\/\/ when no BYOK key \(header or stored\) is available AND the soft-cap\s*\n?\s*\/\/ hasn't been reached \(sub-slice 6\.5\)\./,
    );
  });

  it('Q3 account_owner-only ownership-model framing pinned: PATCH requires account_owner while reads require broad read so granular/zero-scope keys cannot inspect billing consent or spend', () => {
    expect(body).toMatch(
      /\/\/ Per Q3 v2-#6 verdict \(no explicit team-scope verdict yet for\s*\n?\s*\/\/ bundled-LLM\), this slice mirrors the byok-anthropic ownership model:\s*\n?\s*\/\/ account_owner-only for the PATCH\. Reads require broad `read` so a\s*\n?\s*\/\/ resource-granular or zero-scope key cannot inspect billing consent\/spend\./,
    );
    expect((body.match(/app\.requireScope\('read'\)/g) ?? []).length).toBe(2);
  });

  it("PatchBodySchema 2-optional-field shape + at-least-one-required refine pinned: consent: z.boolean().optional() + monthly_cap_usd_cents: z.number().int().min(0).max(1_000_000).optional() + .refine((b) => b.consent !== undefined || b.monthly_cap_usd_cents !== undefined, { message: 'Body must include at least one of: consent, monthly_cap_usd_cents.' }). Drift to dropping the at-least-one refine would let empty PATCH bodies succeed silently as no-ops", () => {
    expect(body).toMatch(
      /const PatchBodySchema = z\s*\n?\s*\.object\(\{\s*\n?\s*consent: z\.boolean\(\)\.optional\(\),\s*\n?\s*monthly_cap_usd_cents: z\.number\(\)\.int\(\)\.min\(0\)\.max\(1_000_000\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.refine\(\(b\) => b\.consent !== undefined \|\| b\.monthly_cap_usd_cents !== undefined, \{\s*\n?\s*message: 'Body must include at least one of: consent, monthly_cap_usd_cents\.',\s*\n?\s*\}\);/,
    );
  });

  it('GET /v1/account/me/bundled-llm-settings null-row-defaults framing pinned: \'Null means "no row" (account was deleted between auth + this call). Defaults match migration 0050.\' + consent: settings?.consent ?? false + monthly_cap_usd_cents: settings?.monthlyCapUsdCents ?? 2000. The $20 default cap ($2000 cents) matches the migration 0050 default + drift to a different default would create marketing↔migration divergence', () => {
    expect(body).toMatch(
      /\/\/ Null means "no row" \(account was deleted between auth \+ this\s*\n?\s*\/\/ call\)\. Defaults match migration 0050\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*consent: settings\?\.consent \?\? false,\s*\n?\s*monthly_cap_usd_cents: settings\?\.monthlyCapUsdCents \?\? 2000,\s*\n?\s*\};/,
    );
  });

  it("Arc 1 sub-slice 6.7 GET /bundled-llm-status framing pinned: 'dashboard data endpoint. Returns consent / cap / month-to-date spend / remaining headroom. The refused_count_this_month field tracks BundledLlmBudgetExhausted throws; today the route layer doesn't write an audit row for these (audit wire is a follow-up slice), so the field reports 0 as a stable schema placeholder. Customer + dashboard can branch on `remaining_cents <= 0` for the same \"you've hit the cap\" UX.' — pinned so the dashboard-data + refused_count-stable-0-placeholder + remaining-cents-<=-0-cap-UX contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.7 \(v2-#6\) — dashboard data endpoint\. Returns\s*\n?\s*\/\/ consent \/ cap \/ month-to-date spend \/ remaining headroom\. The\s*\n?\s*\/\/ refused_count_this_month field tracks BundledLlmBudgetExhausted\s*\n?\s*\/\/ throws; today the route layer doesn't write an audit row for\s*\n?\s*\/\/ these \(audit wire is a follow-up slice\), so the field reports 0\s*\n?\s*\/\/ as a stable schema placeholder\./,
    );
  });

  it('Status response 6-field shape pinned: consent + cap_cents + used_this_month_cents + remaining_cents + refused_count_this_month + month_started_at (ISO-8601 calendar-month-start). + Math.max(0, capCents - usedCents) clamp + Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0).toISOString() month-boundary derivation. Drift to dropping month_started_at would force the dashboard to re-derive the boundary itself (timezone-dance bug invitation)', () => {
    expect(body).toMatch(
      /const remaining = Math\.max\(0, capCents - usedCents\);\s*\n?\s*return \{\s*\n?\s*consent,\s*\n?\s*cap_cents: capCents,\s*\n?\s*used_this_month_cents: usedCents,\s*\n?\s*remaining_cents: remaining,\s*\n?\s*refused_count_this_month: 0,/,
    );
    expect(body).toMatch(
      /\/\/ ISO-8601 calendar-month-start so the dashboard can render\s*\n?\s*\/\/ "resets on <date>" without re-deriving the boundary itself\./,
    );
    expect(body).toMatch(
      /month_started_at: new Date\(\s*\n?\s*Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), 1, 0, 0, 0, 0\),\s*\n?\s*\)\.toISOString\(\),/,
    );
  });

  it("PATCH 400-on-null-update + spread-only-defined-fields framing pinned: BadRequestError('Account row not found — re-authenticate and retry.') on next === null + conditional spread of consent + monthlyCapUsdCents so undefined keys don't write back. Drift to spreading the undefined keys would null out an existing consent on a cap-only PATCH (and vice versa)", () => {
    expect(body).toMatch(
      /const next = await service\.updateSettings\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*\.\.\.\(parsed\.data\.consent !== undefined \? \{ consent: parsed\.data\.consent \} : \{\}\),\s*\n?\s*\.\.\.\(parsed\.data\.monthly_cap_usd_cents !== undefined\s*\n?\s*\? \{ monthlyCapUsdCents: parsed\.data\.monthly_cap_usd_cents \}\s*\n?\s*: \{\}\),\s*\n?\s*\}\);\s*\n?\s*if \(next === null\) \{\s*\n?\s*throw new BadRequestError\('Account row not found — re-authenticate and retry\.'\);/,
    );
  });
});
