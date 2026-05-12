// W466.B — drift guard for apps/gui-client/src/lib/cost-panel.ts.
// V-534.F cost-panel formatter + threshold helpers. Drift here
// either swaps the default currency from 'EUR' (V-541 design
// decision pinned for the BV — switching to USD would be a
// silent compliance change since billing-cycle CSVs export the
// same numbers) or breaks the `classifyTone` mapping (UI would
// surface 'over-hard' as 'ok' / green, the customer sees no
// alert at all while burning past the hard cap).
//
//   • V-534.F framing pinned: 'cost-panel formatter + threshold
//     helpers for the gui-client.' + 'customer-facing GUI doesn't
//     expose admin cost endpoints, but the same shape will be
//     reused for the customer "your spend this month" panel
//     against /v1/account/cost (V-541.D follow-up). This module
//     is pure presentation logic — formats centsand classifies
//     threshold colours — so the React panel can stay declarative.'
//   • ThresholdTone 3-value union ('ok'|'warn'|'alert').
//   • CostBreakdownInput 7-field (5 *Cents + totalCents +
//     thresholdState 3-union 'under-soft'|'between-soft-and-hard'|
//     'over-hard').
//   • FormattedCostBreakdown 4-field (rows ReadonlyArray + total
//     + tone + toneCopy).
//   • COMPONENT_LABELS 5-entry Record with exact display labels.
//   • formatCents JSDoc framing: 'Format a cents integer as a
//     localised currency string. currency defaults to EUR (V-541
//     design decision); customer-facing variants may pass USD.
//     We don't round — every cent is shown.'
//   • formatCents Intl.NumberFormat with style:'currency'.
//   • classifyTone 3-case switch (over-hard→alert; between-soft-
//     and-hard→warn; under-soft→ok).
//   • TONE_COPY 3-entry Record with specific copy strings.
//   • formatCostBreakdown opts: currency default 'EUR' + locale
//     default 'en-US'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/cost-panel.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W466.B apps/gui-client/src/lib/cost-panel.ts content parity', () => {
  const body = read(LIB);

  it("V-534.F framing pinned: 'V-534.F — cost-panel formatter + threshold helpers for the gui-client.' + 'customer-facing GUI doesn't expose admin cost endpoints, but the same shape will be reused for the customer \"your spend this month\" panel against /v1/account/cost (V-541.D follow-up). This module is pure presentation logic — formats centsand classifies threshold colours — so the React panel can stay declarative.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.F — cost-panel formatter \+ threshold helpers for the gui-client\./,
    );
    expect(body).toMatch(
      /\/\/ The customer-facing GUI doesn't expose admin cost endpoints, but\s*\n?\s*\/\/ the same shape will be reused for the customer "your spend this\s*\n?\s*\/\/ month" panel against \/v1\/account\/cost \(V-541\.D follow-up\)\. This\s*\n?\s*\/\/ module is pure presentation logic — formats centsand classifies\s*\n?\s*\/\/ threshold colours — so the React panel can stay declarative\./,
    );
  });

  it("ThresholdTone 3-value union ('ok'|'warn'|'alert')", () => {
    expect(body).toMatch(/export type ThresholdTone = 'ok' \| 'warn' \| 'alert';/);
  });

  it("CostBreakdownInput 7-field: 5 *Cents (compute + storage + egress + email + llm) + totalCents + thresholdState 3-union ('under-soft'|'between-soft-and-hard'|'over-hard')", () => {
    expect(body).toMatch(
      /export interface CostBreakdownInput \{\s*\n?\s*computeCents: number;\s*\n?\s*storageCents: number;\s*\n?\s*egressCents: number;\s*\n?\s*emailCents: number;\s*\n?\s*llmCents: number;\s*\n?\s*totalCents: number;\s*\n?\s*thresholdState: 'under-soft' \| 'between-soft-and-hard' \| 'over-hard';\s*\n?\s*\}/,
    );
  });

  it('FormattedCostBreakdown 4-field: rows ReadonlyArray<{label + formatted + cents}> + total {formatted + cents} + tone ThresholdTone + toneCopy string', () => {
    expect(body).toMatch(
      /export interface FormattedCostBreakdown \{\s*\n?\s*rows: ReadonlyArray<\{ label: string; formatted: string; cents: number \}>;\s*\n?\s*total: \{ formatted: string; cents: number \};\s*\n?\s*tone: ThresholdTone;\s*\n?\s*toneCopy: string;\s*\n?\s*\}/,
    );
  });

  it("COMPONENT_LABELS 5-entry Record with exact display labels: 'Compute (session-minutes)' + 'Storage (R2 GB-months)' + 'Egress (TURN GB)' + 'Email (Postmark sends)' + 'LLM tokens'", () => {
    expect(body).toMatch(
      /const COMPONENT_LABELS: Record<\s*\n?\s*keyof Omit<CostBreakdownInput, 'totalCents' \| 'thresholdState'>,\s*\n?\s*string\s*\n?\s*> = \{\s*\n?\s*computeCents: 'Compute \(session-minutes\)',\s*\n?\s*storageCents: 'Storage \(R2 GB-months\)',\s*\n?\s*egressCents: 'Egress \(TURN GB\)',\s*\n?\s*emailCents: 'Email \(Postmark sends\)',\s*\n?\s*llmCents: 'LLM tokens',\s*\n?\s*\};/,
    );
  });

  it("formatCents: JSDoc framing pinned 'Format a cents integer as a localised currency string. `currency` defaults to EUR (V-541 design decision); customer-facing variants may pass \"USD\". We don't round — every cent is shown.' + signature with currency: 'EUR' | 'USD' = 'EUR' default + locale = 'en-US' default + Intl.NumberFormat style: 'currency'", () => {
    expect(body).toMatch(
      /\*\s*Format a cents integer as a localised currency string\. `currency`\s*\n?\s*\*\s*defaults to EUR \(V-541 design decision\); customer-facing variants\s*\n?\s*\*\s*may pass 'USD'\. We don't round — every cent is shown\./,
    );
    expect(body).toMatch(
      /export function formatCents\(\s*\n?\s*cents: number,\s*\n?\s*currency: 'EUR' \| 'USD' = 'EUR',\s*\n?\s*locale = 'en-US',\s*\n?\s*\): string \{\s*\n?\s*const value = cents \/ 100;\s*\n?\s*return new Intl\.NumberFormat\(locale, \{\s*\n?\s*style: 'currency',\s*\n?\s*currency,\s*\n?\s*\}\)\.format\(value\);\s*\n?\s*\}/,
    );
  });

  it("classifyTone 3-case switch (over-hard → 'alert'; between-soft-and-hard → 'warn'; under-soft → 'ok')", () => {
    expect(body).toMatch(
      /export function classifyTone\(state: CostBreakdownInput\['thresholdState'\]\): ThresholdTone \{\s*\n?\s*switch \(state\) \{\s*\n?\s*case 'over-hard':\s*\n?\s*return 'alert';\s*\n?\s*case 'between-soft-and-hard':\s*\n?\s*return 'warn';\s*\n?\s*case 'under-soft':\s*\n?\s*return 'ok';\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("TONE_COPY 3-entry Record pinned: ok 'On track for this billing cycle.' + warn 'Approaching the configured spend threshold for this account.' + alert 'Over the configured hard threshold. Investigate or raise the cap.'", () => {
    expect(body).toMatch(
      /const TONE_COPY: Record<ThresholdTone, string> = \{\s*\n?\s*ok: 'On track for this billing cycle\.',\s*\n?\s*warn: 'Approaching the configured spend threshold for this account\.',\s*\n?\s*alert: 'Over the configured hard threshold\. Investigate or raise the cap\.',\s*\n?\s*\};/,
    );
  });

  it("formatCostBreakdown: opts { currency?: 'EUR'|'USD'; locale?: string } with EUR + 'en-US' defaults + 5-key as-const tuple ['computeCents','storageCents','egressCents','emailCents','llmCents'] + total formatted with formatCents(input.totalCents) + tone via classifyTone + toneCopy lookup", () => {
    expect(body).toMatch(
      /export function formatCostBreakdown\(\s*\n?\s*input: CostBreakdownInput,\s*\n?\s*opts: \{ currency\?: 'EUR' \| 'USD'; locale\?: string \} = \{\},\s*\n?\s*\): FormattedCostBreakdown \{\s*\n?\s*const currency = opts\.currency \?\? 'EUR';\s*\n?\s*const locale = opts\.locale \?\? 'en-US';\s*\n?\s*const tone = classifyTone\(input\.thresholdState\);/,
    );
    expect(body).toMatch(
      /rows: \(\['computeCents', 'storageCents', 'egressCents', 'emailCents', 'llmCents'\] as const\)\.map\(\s*\n?\s*\(key\) => \(\{\s*\n?\s*label: COMPONENT_LABELS\[key\],\s*\n?\s*formatted: formatCents\(input\[key\], currency, locale\),\s*\n?\s*cents: input\[key\],\s*\n?\s*\}\),\s*\n?\s*\),/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
