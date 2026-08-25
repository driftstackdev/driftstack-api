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
      /\/\/ The customer-facing GUI doesn't expose admin cost endpoints, but\s*\/\/ the same shape will be reused for the customer "your spend this\s*\/\/ month" panel against \/v1\/account\/cost \(V-541\.D follow-up\)\. This\s*\/\/ module is pure presentation logic — formats centsand classifies\s*\/\/ threshold colours — so the React panel can stay declarative\./,
    );
  });

  it("ThresholdTone 3-value union ('ok'|'warn'|'alert')", () => {
    expect(body).toMatch(/export type ThresholdTone = 'ok' \| 'warn' \| 'alert';/);
  });

  it("CostBreakdownInput 7-field: 5 *Cents (compute + storage + egress + email + llm) + totalCents + thresholdState 3-union ('under-soft'|'between-soft-and-hard'|'over-hard')", () => {
    expect(body).toMatch(
      /export interface CostBreakdownInput \{\s*computeCents: number;\s*storageCents: number;\s*egressCents: number;\s*emailCents: number;\s*llmCents: number;\s*totalCents: number;\s*thresholdState: 'under-soft' \| 'between-soft-and-hard' \| 'over-hard';\s*\}/,
    );
  });

  it('FormattedCostBreakdown 4-field: rows ReadonlyArray<{label + formatted + cents}> + total {formatted + cents} + tone ThresholdTone + toneCopy string', () => {
    expect(body).toMatch(
      /export interface FormattedCostBreakdown \{\s*rows: ReadonlyArray<\{ label: string; formatted: string; cents: number \}>;\s*total: \{ formatted: string; cents: number \};\s*tone: ThresholdTone;\s*toneCopy: string;\s*\}/,
    );
  });

  it("COMPONENT_LABELS 5-entry Record with exact display labels: 'Compute (session-minutes)' + 'Storage (R2 GB-months)' + 'Egress (TURN GB)' + 'Email (Postmark sends)' + 'LLM tokens'", () => {
    expect(body).toMatch(
      /const COMPONENT_LABELS: Record<\s*keyof Omit<CostBreakdownInput, 'totalCents' \| 'thresholdState'>,\s*string\s*> = \{\s*computeCents: 'Compute \(session-minutes\)',\s*storageCents: 'Storage \(R2 GB-months\)',\s*egressCents: 'Egress \(TURN GB\)',\s*emailCents: 'Email \(Postmark sends\)',\s*llmCents: 'LLM tokens',\s*\};/,
    );
  });

  it("formatCents: JSDoc framing pinned 'Format a cents integer as a localised currency string. `currency` defaults to EUR (V-541 design decision); customer-facing variants may pass \"USD\". We don't round — every cent is shown.' + signature with currency: 'EUR' | 'USD' = 'EUR' default + locale = 'en-US' default + Intl.NumberFormat style: 'currency'", () => {
    expect(body).toMatch(
      /\*\s*Format a cents integer as a localised currency string\. `currency`\s*\*\s*defaults to EUR \(V-541 design decision\); customer-facing variants\s*\*\s*may pass 'USD'\. We don't round — every cent is shown\./,
    );
    expect(body).toMatch(
      /export function formatCents\(\s*cents: number,\s*currency: 'EUR' \| 'USD' = 'EUR',\s*locale = 'en-US',\s*\): string \{\s*const value = cents \/ 100;\s*return new Intl\.NumberFormat\(locale, \{\s*style: 'currency',\s*currency,\s*\}\)\.format\(value\);\s*\}/,
    );
  });

  it("classifyTone 3-case switch (over-hard → 'alert'; between-soft-and-hard → 'warn'; under-soft → 'ok')", () => {
    expect(body).toMatch(
      /export function classifyTone\(state: CostBreakdownInput\['thresholdState'\]\): ThresholdTone \{\s*switch \(state\) \{\s*case 'over-hard':\s*return 'alert';\s*case 'between-soft-and-hard':\s*return 'warn';\s*case 'under-soft':\s*return 'ok';\s*\}\s*\}/,
    );
  });

  it("TONE_COPY 3-entry Record pinned: ok 'On track for this billing cycle.' + warn 'Approaching the configured spend threshold for this account.' + alert 'Over the configured hard threshold. Investigate or raise the cap.'", () => {
    expect(body).toMatch(
      /const TONE_COPY: Record<ThresholdTone, string> = \{\s*ok: 'On track for this billing cycle\.',\s*warn: 'Approaching the configured spend threshold for this account\.',\s*alert: 'Over the configured hard threshold\. Investigate or raise the cap\.',\s*\};/,
    );
  });

  it("formatCostBreakdown: opts { currency?: 'EUR'|'USD'; locale?: string } with EUR + 'en-US' defaults + 5-key as-const tuple ['computeCents','storageCents','egressCents','emailCents','llmCents'] + total formatted with formatCents(input.totalCents) + tone via classifyTone + toneCopy lookup", () => {
    expect(body).toMatch(
      /export function formatCostBreakdown\(\s*input: CostBreakdownInput,\s*opts: \{ currency\?: 'EUR' \| 'USD'; locale\?: string \} = \{\},\s*\): FormattedCostBreakdown \{\s*const currency = opts\.currency \?\? 'EUR';\s*const locale = opts\.locale \?\? 'en-US';\s*const tone = classifyTone\(input\.thresholdState\);/,
    );
    expect(body).toMatch(
      /rows: \(\['computeCents', 'storageCents', 'egressCents', 'emailCents', 'llmCents'\] as const\)\.map\(\s*\(key\) => \(\{\s*label: COMPONENT_LABELS\[key\],\s*formatted: formatCents\(input\[key\], currency, locale\),\s*cents: input\[key\],\s*\}\),\s*\),/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
