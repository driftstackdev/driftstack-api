// W475.B — drift guard for apps/gui-client/src/components/CostPanel.tsx.
// V-534.G cost-panel React component. Drift here either drops the
// 3-tone label triad (On track / Approaching limit / Over hard limit
// — operators lose the at-a-glance status read on the cost panel,
// have to read the numbers to know if anything's wrong) or breaks
// the dl/dt/dd semantic markup (screen readers stop announcing the
// breakdown as a definition list and the per-row label↔value pair
// pronunciation breaks).
//
//   • V-534.G framing pinned: 'cost-panel React component.' +
//     'Renders the breakdown produced by `lib/cost-panel.ts::
//     formatCostBreakdown`. Pure presentation; no data fetching
//     here — caller supplies the pre-formatted breakdown.'
//   • CostPanelProps 3-field (breakdown: CostBreakdownInput +
//     billingCycle: string + currency? 2-union 'EUR'|'USD').
//   • TONE_BORDER + TONE_CHIP_BG + TONE_LABEL all Record<'ok'|'warn'
//     |'alert', string>; labels: 'On track' / 'Approaching limit'
//     / 'Over hard limit'.
//   • Semantic markup: <section> aria-label `Cost breakdown for
//     ${billingCycle}` + <dl role="list"> with <dt>label</dt>
//     <dd>formatted</dd> rows + Total row with border-t separator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/CostPanel.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W475.B apps/gui-client/src/components/CostPanel.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.G framing pinned: 'V-534.G — cost-panel React component. Renders the breakdown produced by `lib/cost-panel.ts::formatCostBreakdown`. Pure presentation; no data fetching here — caller supplies the pre-formatted breakdown.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.G — cost-panel React component\. Renders the breakdown\s*\/\/ produced by `lib\/cost-panel\.ts::formatCostBreakdown`\. Pure\s*\/\/ presentation; no data fetching here — caller supplies the\s*\/\/ pre-formatted breakdown\./,
    );
  });

  it("CostPanelProps 3-field: breakdown: CostBreakdownInput 'raw breakdown from /v1/account/cost (V-541.D) or admin route' + billingCycle: string 'e.g. \"2026-05\"' + currency? 2-union 'EUR'|'USD' 'Default EUR.'", () => {
    expect(body).toMatch(
      /export interface CostPanelProps \{\s*\/\*\* The raw breakdown from \/v1\/account\/cost \(V-541\.D\) or admin route\. \*\/\s*breakdown: CostBreakdownInput;\s*\/\*\* Billing cycle label, e\.g\. "2026-05"\. \*\/\s*billingCycle: string;\s*\/\*\* Currency to format in\. Default EUR\. \*\/\s*currency\?: 'EUR' \| 'USD';\s*\}/,
    );
  });

  it("3-tone Record triad pinned with same key shape 'ok'|'warn'|'alert': TONE_BORDER (border-status-success/40, /warning/50, /error/60) + TONE_CHIP_BG (bg-status-*/15 + text-status-*) + TONE_LABEL ('On track' / 'Approaching limit' / 'Over hard limit') — pinned so the 3-tone visual + label surface stays coherent across the panel", () => {
    expect(body).toMatch(
      /const TONE_BORDER: Record<'ok' \| 'warn' \| 'alert', string> = \{\s*ok: 'border-status-success\/40',\s*warn: 'border-status-warning\/50',\s*alert: 'border-status-error\/60',\s*\};/,
    );
    expect(body).toMatch(
      /const TONE_CHIP_BG: Record<'ok' \| 'warn' \| 'alert', string> = \{\s*ok: 'bg-status-success\/15 text-status-success',\s*warn: 'bg-status-warning\/15 text-status-warning',\s*alert: 'bg-status-error\/15 text-status-error',\s*\};/,
    );
    expect(body).toMatch(
      /const TONE_LABEL: Record<'ok' \| 'warn' \| 'alert', string> = \{\s*ok: 'On track',\s*warn: 'Approaching limit',\s*alert: 'Over hard limit',\s*\};/,
    );
  });

  it('CostPanel: formatCostBreakdown(breakdown, {currency}) delegation + <section> aria-label `Cost breakdown for ${billingCycle}` + <header> with billing-cycle + tone chip + toneCopy + <dl role="list"> with <dt>row.label</dt> + <dd>row.formatted</dd> rows + Total row with border-t separator', () => {
    expect(body).toMatch(
      /const formatted = formatCostBreakdown\(props\.breakdown, \{ currency: props\.currency \}\);/,
    );
    expect(body).toMatch(
      /<section\s*className=\{`rounded border \$\{TONE_BORDER\[formatted\.tone\]\} bg-surface-raised p-4`\}\s*aria-label=\{`Cost breakdown for \$\{props\.billingCycle\}`\}\s*>/,
    );
    expect(body).toMatch(
      /<dl className="mt-4 grid gap-x-4 gap-y-2 text-sm" role="list">\s*\{formatted\.rows\.map\(\(row\) => \(\s*<div key=\{row\.label\} className="flex items-baseline justify-between gap-3">\s*<dt className="text-ink-secondary">\{row\.label\}<\/dt>\s*<dd className="font-mono text-ink-primary">\{row\.formatted\}<\/dd>\s*<\/div>\s*\)\)\}\s*<\/dl>/,
    );
    expect(body).toMatch(
      /<div className="mt-4 flex items-baseline justify-between gap-3 border-t border-surface-divider pt-3">\s*<span className="text-sm font-medium text-ink-primary">Total<\/span>\s*<span className="font-mono text-base font-semibold text-ink-primary">\s*\{formatted\.total\.formatted\}\s*<\/span>\s*<\/div>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
