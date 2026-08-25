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
      /\/\/\s+GET\s+\/v1\/account\/me\/bundled-llm-settings\s+— read current state\s*\/\/\s+PATCH \/v1\/account\/me\/bundled-llm-settings\s+— flip consent \+\/or cap\s*\/\/\s+GET\s+\/v1\/account\/me\/bundled-llm-status\s+— spend \+ remaining \(sub-slice 6\.7\)/,
    );
  });

  it("Migration 0050 CHECK-constraint range invariant framing pinned: 'monthly_cap_usd_cents ∈ [0, 1_000_000] (i.e. $0 to $10,000). The server rejects out-of-range inputs with 400; the CHECK is a defence-in-depth backstop if the route validation is ever skipped.' — pinned so the migration-0050 + 0-to-1M cent range + $10,000 ceiling + defence-in-depth-CHECK contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Same range invariants as the migration 0050 CHECK constraint:\s*\/\/ monthly_cap_usd_cents ∈ \[0, 1_000_000\] \(i\.e\. \$0 to \$10,000\)\. The\s*\/\/ server rejects out-of-range inputs with 400; the CHECK is a\s*\/\/ defence-in-depth backstop if the route validation is ever skipped\./,
    );
  });

  it("Q4=A BYOK-always-wins framing pinned: 'BYOK always wins. Flipping consent=true does NOT silently bill customers — bundled-LLM only resolves at turn time when no BYOK key (header or stored) is available AND the soft-cap hasn't been reached (sub-slice 6.5).' — pinned so the Q4=A verdict + BYOK-priority + soft-cap-gating-resolution contract all stay documented (drift to letting consent=true silently bill bundled-LLM regardless of BYOK availability would break the customer-trust contract)", () => {
    expect(body).toMatch(
      /\/\/ Q4=A locked: BYOK always wins\. Flipping consent=true does NOT\s*\/\/ silently bill customers — bundled-LLM only resolves at turn time\s*\/\/ when no BYOK key \(header or stored\) is available AND the soft-cap\s*\/\/ hasn't been reached \(sub-slice 6\.5\)\./,
    );
  });

  it('Q3 account_owner-only ownership-model framing pinned: PATCH requires account_owner while reads require broad read so granular/zero-scope keys cannot inspect billing consent or spend', () => {
    expect(body).toMatch(
      /\/\/ Per Q3 v2-#6 verdict \(no explicit team-scope verdict yet for\s*\/\/ bundled-LLM\), this slice mirrors the byok-anthropic ownership model:\s*\/\/ account_owner-only for the PATCH\. Reads require broad `read` so a\s*\/\/ resource-granular or zero-scope key cannot inspect billing consent\/spend\./,
    );
    expect((body.match(/app\.requireScope\('read'\)/g) ?? []).length).toBe(2);
  });

  it("PatchBodySchema 2-optional-field shape + at-least-one-required refine pinned: consent: z.boolean().optional() + monthly_cap_usd_cents: z.number().int().min(0).max(1_000_000).optional() + .refine((b) => b.consent !== undefined || b.monthly_cap_usd_cents !== undefined, { message: 'Body must include at least one of: consent, monthly_cap_usd_cents.' }). Drift to dropping the at-least-one refine would let empty PATCH bodies succeed silently as no-ops", () => {
    expect(body).toMatch(
      /const PatchBodySchema = z\s*\.object\(\{\s*consent: z\.boolean\(\)\.optional\(\),\s*monthly_cap_usd_cents: z\.number\(\)\.int\(\)\.min\(0\)\.max\(1_000_000\)\.optional\(\),\s*\}\)\s*\.refine\(\(b\) => b\.consent !== undefined \|\| b\.monthly_cap_usd_cents !== undefined, \{\s*message: 'Body must include at least one of: consent, monthly_cap_usd_cents\.',\s*\}\);/,
    );
  });

  it('GET /v1/account/me/bundled-llm-settings null-row-defaults framing pinned: \'Null means "no row" (account was deleted between auth + this call). Defaults match migration 0050.\' + consent: settings?.consent ?? false + monthly_cap_usd_cents: settings?.monthlyCapUsdCents ?? 2000. The $20 default cap ($2000 cents) matches the migration 0050 default + drift to a different default would create marketing↔migration divergence', () => {
    expect(body).toMatch(
      /\/\/ Null means "no row" \(account was deleted between auth \+ this\s*\/\/ call\)\. Defaults match migration 0050\./,
    );
    expect(body).toMatch(
      /return \{\s*consent: settings\?\.consent \?\? false,\s*monthly_cap_usd_cents: settings\?\.monthlyCapUsdCents \?\? 2000,\s*\};/,
    );
  });

  // CORRECTED 2026-08-14. This pin used to freeze the sentence "The
  // refused_count_this_month field tracks BundledLlmBudgetExhausted throws;
  // today the route layer doesn't write an audit row for these (audit wire is a
  // follow-up slice)". That was not true, and the pin was protecting it.
  //
  // The field tracks nothing. Refusals genuinely occur — a turn past the cap
  // throws and the same path increments a Prometheus counter — but no
  // per-account count is persisted ANYWHERE, so the gap is not a missing audit
  // row that a follow-up slice would close; there is no counter to read at all.
  // The old wording made a placeholder sound like a nearly-finished feature, to
  // the one reader most likely to act on it: whoever picks this up next.
  //
  // A pin records what the text SAID, never whether it was TRUE. When a pin and
  // reality disagree, suspect the pin.
  it("Arc 1 sub-slice 6.7 GET /bundled-llm-status framing pinned: 'dashboard data endpoint. Returns consent / cap / month-to-date spend / remaining headroom. The refused_count_this_month field does NOT track anything: refusals do occur — a turn past the cap throws BundledLlmBudgetExhausted and is counted for operators in Prometheus — but no per-account counter is persisted anywhere, so the field reports 0 as a placeholder and the published schema discloses that. Customer + dashboard can branch on `remaining_cents <= 0` for the same \"you've hit the cap\" UX.' — pinned so the dashboard-data + not-a-tracker + schema-discloses-it + remaining-cents-<=-0-cap-UX contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.7 \(v2-#6\) — dashboard data endpoint\. Returns\s*\/\/ consent \/ cap \/ month-to-date spend \/ remaining headroom\. The\s*\/\/ refused_count_this_month field does NOT track anything: refusals\s*\/\/ do occur/,
    );
    expect(body).toMatch(
      /\/\/ counter is persisted anywhere, so the field reports 0 as a\s*\/\/ placeholder and the published schema discloses that\./,
    );
  });

  it('Status response 6-field shape pinned: consent + cap_cents + used_this_month_cents + remaining_cents + refused_count_this_month + month_started_at (ISO-8601 calendar-month-start). + Math.max(0, capCents - usedCents) clamp + Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0).toISOString() month-boundary derivation. Drift to dropping month_started_at would force the dashboard to re-derive the boundary itself (timezone-dance bug invitation)', () => {
    // SPLIT from one chain. The single regex ran from the clamp straight through
    // to `refused_count_this_month: 0,` as consecutive lines, so a comment
    // documenting that field — the honest thing to add — broke a pin about the
    // response SHAPE. A chain that long fails for reasons it is not about.
    expect(body).toMatch(
      /const remaining = Math\.max\(0, capCents - usedCents\);\s*return \{\s*consent,\s*cap_cents: capCents,\s*used_this_month_cents: usedCents,\s*remaining_cents: remaining,/,
    );
    expect(body).toMatch(/^\s*refused_count_this_month: 0,\s*$/m);
    expect(body).toMatch(
      /\/\/ ISO-8601 calendar-month-start so the dashboard can render\s*\/\/ "resets on <date>" without re-deriving the boundary itself\./,
    );
    expect(body).toMatch(
      /month_started_at: new Date\(\s*Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), 1, 0, 0, 0, 0\),\s*\)\.toISOString\(\),/,
    );
  });

  it("PATCH 400-on-null-update + spread-only-defined-fields framing pinned: BadRequestError('Account row not found — re-authenticate and retry.') on next === null + conditional spread of consent + monthlyCapUsdCents so undefined keys don't write back. Drift to spreading the undefined keys would null out an existing consent on a cap-only PATCH (and vice versa)", () => {
    expect(body).toMatch(
      /const next = await service\.updateSettings\(\{\s*accountId: ctx\.account\.id,\s*\.\.\.\(parsed\.data\.consent !== undefined \? \{ consent: parsed\.data\.consent \} : \{\}\),\s*\.\.\.\(parsed\.data\.monthly_cap_usd_cents !== undefined\s*\? \{ monthlyCapUsdCents: parsed\.data\.monthly_cap_usd_cents \}\s*: \{\}\),\s*\}\);\s*if \(next === null\) \{\s*throw new BadRequestError\('Account row not found — re-authenticate and retry\.'\);/,
    );
  });
});
