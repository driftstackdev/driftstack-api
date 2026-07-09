// W478.C — drift guard for apps/gui-client/src/views/BillingCostView.tsx.
// V-534.I billing cost view. Drift here either drops the 4-
// month buildBillingCycleOptions loop (the picker no longer
// includes the 3 preceding months and customers can only ever
// view the current cycle — historical cycle inspection broken)
// or breaks the UTC date math (a customer near midnight UTC
// in a non-UTC tz sees the wrong cycle in the picker because
// local-tz Date methods slip the month boundary).
//
//   • V-534.I framing pinned: 'billing cost view.' + 'Wires
//     the V-534.G CostPanel component to the V-534.H
//     useAccountCost hook. Provides a billing-cycle picker
//     (current month + last three months) and renders
//     loading/error/ready states.'
//   • buildBillingCycleOptions: 4-iter loop (i=0..3) +
//     Date.UTC(getUTCFullYear, getUTCMonth-i, 1) +
//     getUTCMonth()+1 padStart(2,'0') YYYY-MM format.
//   • nowFn?: testing seam Default new Date(); useMemo on now
//     dependency.
//   • State-machine render: loading + idle + error + ready →
//     CostPanel breakdown + billing_cycle pass-through.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/BillingCostView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W478.C apps/gui-client/src/views/BillingCostView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.I framing pinned: 'V-534.I — billing cost view.' + 'Wires the V-534.G CostPanel component to the V-534.H useAccountCost hook. Provides a billing-cycle picker (current month + last three months) and renders loading/error/ready states.'", () => {
    expect(body).toMatch(/\/\/ V-534\.I — billing cost view\./);
    expect(body).toMatch(
      /\/\/ Wires the V-534\.G CostPanel component to the V-534\.H useAccountCost\s*\n?\s*\/\/ hook\. Provides a billing-cycle picker \(current month \+ last three\s*\n?\s*\/\/ months\) and renders loading\/error\/ready states\./,
    );
  });

  it("buildBillingCycleOptions: JSDoc framing 'Build the picker options: current YYYY-MM plus the three preceding months. Pre-computed so the picker is deterministic — formatting stays in the view, not the hook.' + 4-iter loop (i<4) + Date.UTC(getUTCFullYear, getUTCMonth-i, 1) constructor + getUTCFullYear toString() + (getUTCMonth+1) padStart(2,'0') + `${yyyy}-${mm}` template", () => {
    expect(body).toMatch(
      /\* Build the picker options: current YYYY-MM plus the three preceding\s*\n?\s*\*\s+months\. Pre-computed so the picker is deterministic — formatting\s*\n?\s*\*\s+stays in the view, not the hook\./,
    );
    expect(body).toMatch(
      /function buildBillingCycleOptions\(now: Date\): string\[\] \{\s*\n?\s*const out: string\[\] = \[\];\s*\n?\s*for \(let i = 0; i < 4; i \+= 1\) \{\s*\n?\s*const d = new Date\(Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\) - i, 1\)\);\s*\n?\s*const yyyy = d\.getUTCFullYear\(\)\.toString\(\);\s*\n?\s*const mm = String\(d\.getUTCMonth\(\) \+ 1\)\.padStart\(2, '0'\);\s*\n?\s*out\.push\(`\$\{yyyy\}-\$\{mm\}`\);\s*\n?\s*\}\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it("BillingCostViewProps: nowFn? 'Test seam — defaults to `new Date()`.' + opts default {}; useMemo(buildBillingCycleOptions(now), [now]) + useState<string>(cycles[0] ?? '') initial selection from cycles[0] + useAccountCost({billingCycle: selectedCycle}) wiring", () => {
    expect(body).toMatch(
      /export interface BillingCostViewProps \{\s*\n?\s*\/\*\* Test seam — defaults to `new Date\(\)`\. \*\/\s*\n?\s*nowFn\?: \(\) => Date;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function BillingCostView\(props: BillingCostViewProps = \{\}\): JSX\.Element \{\s*\n?\s*const now = props\.nowFn \? props\.nowFn\(\) : new Date\(\);\s*\n?\s*const cycles = useMemo\(\(\) => buildBillingCycleOptions\(now\), \[now\]\);\s*\n?\s*const \[selectedCycle, setSelectedCycle\] = useState<string>\(cycles\[0\] \?\? ''\);\s*\n?\s*const \{ state, refetch \} = useAccountCost\(\{ billingCycle: selectedCycle \}\);/,
    );
  });

  it("Render: section aria-labelledby + 'Usage & cost' h2 + <label> for billing-cycle-picker + <select> with cycles.map options + refresh button onClick=void refetch()", () => {
    expect(body).toMatch(/<h2[\s\S]*?id="billing-cost-heading"[\s\S]*?Usage & cost[\s\S]*?<\/h2>/);
    expect(body).toMatch(
      /<label htmlFor="billing-cycle-picker" className="text-sm text-ink-secondary">\s*\n?\s*Billing cycle\s*\n?\s*<\/label>/,
    );
    expect(body).toMatch(
      /<select\s*\n?\s*id="billing-cycle-picker"\s*\n?\s*value=\{selectedCycle\}\s*\n?\s*onChange=\{\(e\) => setSelectedCycle\(e\.target\.value\)\}/,
    );
    expect(body).toMatch(
      /\{cycles\.map\(\(c\) => \(\s*\n?\s*<option key=\{c\} value=\{c\}>\s*\n?\s*\{formatBillingCycleLabel\(c\)\}\s*\n?\s*<\/option>\s*\n?\s*\)\)\}/,
    );
  });

  it("State-machine render: loading → SkeletonRows label='Loading cost breakdown…' + idle 'Select a billing cycle to load the breakdown.' + error 'Could not load cost data: ${message}' role='alert' + ready → <CostPanel breakdown={state.data.breakdown} billingCycle={state.data.billing_cycle} /> (snake_case server field passed as billingCycle camelCase prop)", () => {
    // Loading uses the shared SkeletonRows primitive (consistent with the other
    // list views) rather than a bare text line; the copy survives via its label.
    expect(body).toContain("state.kind === 'loading'");
    expect(body).toContain('<SkeletonRows rows={4} label="Loading cost breakdown…" />');
    expect(body).toMatch(
      /\{state\.kind === 'idle' && \(\s*\n?\s*<p className="text-sm text-ink-secondary">Select a billing cycle to load the breakdown\.<\/p>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*\n?\s*<div\s*\n?\s*role="alert"\s*\n?\s*className="rounded border border-status-error\/60 bg-status-error\/10 p-3 text-sm text-status-error"\s*\n?\s*>\s*\n?\s*Could not load cost data: \{state\.message\}\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'ready' && \(\s*\n?\s*<CostPanel breakdown=\{state\.data\.breakdown\} billingCycle=\{state\.data\.billing_cycle\} \/>\s*\n?\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
