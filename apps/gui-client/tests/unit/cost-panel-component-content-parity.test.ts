// W385.C — drift guard for gui-client CostPanel component source.
// Existing CostPanel.test.tsx covers render behavior; this guard
// pins the load-bearing tone-mapping + content claims:
//
//   • V-534.G framing pinned.
//   • formatCostBreakdown imported from lib/cost-panel (single
//     source of formatting truth — pure presentation here).
//   • 3 tone literals: ok / warn / alert.
//   • 3 tone borders (success-40 / warning-50 / error-60).
//   • 3 tone chip backgrounds (success-15 / warning-15 / error-15).
//   • 3 tone labels: "On track" / "Approaching limit" / "Over hard
//     limit" (load-bearing customer-facing copy).
//   • Default currency: EUR.
//   • aria-label="Cost breakdown for ${billingCycle}".
//   • section-label "Billing cycle" + h3 + chip + toneCopy +
//     formatted rows + Total row.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENT = resolve(REPO_ROOT, 'apps/gui-client/src/components/CostPanel.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W385.C gui-client CostPanel content parity', () => {
  const body = read(COMPONENT);

  it('V-534.G framing pinned (pure presentation, caller supplies pre-formatted breakdown)', () => {
    expect(body).toMatch(/V-534\.G — cost-panel React component/);
    expect(body).toMatch(
      /Pure\s*\/\/\s*presentation; no data fetching here — caller supplies the\s*\/\/\s*pre-formatted breakdown/,
    );
  });

  it('imports formatCostBreakdown from lib/cost-panel (single source of formatting truth)', () => {
    expect(body).toMatch(
      /import \{ formatCostBreakdown, type CostBreakdownInput \} from '\.\.\/lib\/cost-panel';/,
    );
  });

  it('Props interface: 3 fields (breakdown / billingCycle / optional currency EUR|USD)', () => {
    expect(body).toMatch(/breakdown: CostBreakdownInput;/);
    expect(body).toMatch(/billingCycle: string;/);
    expect(body).toMatch(/currency\?: 'EUR' \| 'USD';/);
    expect(body).toMatch(/\/\*\* Currency to format in\. Default EUR\. \*\//);
  });

  it('breakdown source-of-truth comment: /v1/account/cost (V-541.D) or admin route', () => {
    expect(body).toMatch(
      /The raw breakdown from \/v1\/account\/cost \(V-541\.D\) or admin route\./,
    );
  });

  it('3 tone literals (ok / warn / alert) — TONE_BORDER / TONE_CHIP_BG / TONE_LABEL keyed identically', () => {
    expect(body).toMatch(/TONE_BORDER: Record<'ok' \| 'warn' \| 'alert', string>/);
    expect(body).toMatch(/TONE_CHIP_BG: Record<'ok' \| 'warn' \| 'alert', string>/);
    expect(body).toMatch(/TONE_LABEL: Record<'ok' \| 'warn' \| 'alert', string>/);
  });

  it('TONE_BORDER colors: ok=success-40 / warn=warning-50 / alert=error-60', () => {
    expect(body).toMatch(/ok: 'border-status-success\/40',/);
    expect(body).toMatch(/warn: 'border-status-warning\/50',/);
    expect(body).toMatch(/alert: 'border-status-error\/60',/);
  });

  it('TONE_CHIP_BG colors: ok=success-15 / warn=warning-15 / alert=error-15 + matching text colors', () => {
    expect(body).toMatch(/ok: 'bg-status-success\/15 text-status-success',/);
    expect(body).toMatch(/warn: 'bg-status-warning\/15 text-status-warning',/);
    expect(body).toMatch(/alert: 'bg-status-error\/15 text-status-error',/);
  });

  it('TONE_LABEL customer-facing copy: "On track" / "Approaching limit" / "Over hard limit"', () => {
    expect(body).toMatch(/ok: 'On track',/);
    expect(body).toMatch(/warn: 'Approaching limit',/);
    expect(body).toMatch(/alert: 'Over hard limit',/);
  });

  it('aria-label dynamic: "Cost breakdown for ${billingCycle}"', () => {
    expect(body).toMatch(/aria-label=\{`Cost breakdown for \$\{props\.billingCycle\}`\}/);
  });

  it('section-label "Billing cycle" + h3 with billingCycle prop', () => {
    expect(body).toMatch(/<p className="section-label text-ink-muted">Billing cycle<\/p>/);
    expect(body).toMatch(
      /<h3 className="mt-0\.5 text-base font-semibold text-ink-primary">\{props\.billingCycle\}<\/h3>/,
    );
  });

  it('rows iterated as <dl role="list"> with dt label + dd font-mono formatted value', () => {
    expect(body).toMatch(/<dl className="mt-4 grid gap-x-4 gap-y-2 text-sm" role="list">/);
    expect(body).toMatch(/<dt className="text-ink-secondary">\{row\.label\}<\/dt>/);
    expect(body).toMatch(/<dd className="font-mono text-ink-primary">\{row\.formatted\}<\/dd>/);
    expect(body).toMatch(/formatted\.rows\.map\(\(row\)/);
  });

  it('Total row pinned (border-top + bold + font-mono value from formatted.total.formatted)', () => {
    expect(body).toMatch(
      /<div className="mt-4 flex items-baseline justify-between gap-3 border-t border-surface-divider pt-3">[\s\S]+?Total[\s\S]+?\{formatted\.total\.formatted\}/,
    );
  });

  it('toneCopy rendered below header (per-tone customer-facing explanation)', () => {
    expect(body).toMatch(
      /<p className="mt-3 text-xs text-ink-secondary">\{formatted\.toneCopy\}<\/p>/,
    );
  });

  it('component file + lib/cost-panel exist at canonical paths', () => {
    expect(existsSync(COMPONENT)).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/src/lib/cost-panel.ts'))).toBe(true);
  });
});
