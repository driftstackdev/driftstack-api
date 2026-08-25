// W480.C — drift guard for apps/gui-client/src/views/CryptoOrdersDailyBreakdownView.tsx.
// V-534.AH admin daily-breakdown view. Drift here either drops
// the STATUS_COLUMNS 6-status order (the pivot table loses a
// status column — admin can't see e.g. 'partial' counts in
// the daily breakdown, undercounts revenue at-risk) or breaks
// the pivot sort (oldest-first vs newest-first — admin opens
// the view and sees yesterday's data instead of today's).
//
//   • V-534.AH framing pinned: 'admin daily-breakdown view for
//     crypto orders.' + 'Companion to V-534.AG admin list.
//     Renders the (date, status, count) rows returned by
//     /v1/admin/crypto-orders/daily as a pivoted table (rows =
//     dates, columns = statuses). Days with no orders are
//     omitted by the server; we keep that posture client-side
//     and skip the zero-fill — caller can widen `days` if they
//     want a denser view.'
//   • STATUS_COLUMNS 6-status array (pending, confirming, paid,
//     failed, partial, cancelled) — matches V-534.T/.U union.
//   • DAYS_OPTIONS [7, 14, 30, 60, 90] window picker.
//   • PivotRow interface + pivot() helper: Map<string, PivotRow>
//     bucketing + sort newest-first (a.date < b.date ? 1 : -1).
//   • Days picker default 7 + Number.parseInt(value, 10);
//     truncated warning + empty-state + non-empty table with
//     '—' em-dash for 0 counts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersDailyBreakdownView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W480.C apps/gui-client/src/views/CryptoOrdersDailyBreakdownView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AH framing pinned: 'V-534.AH — admin daily-breakdown view for crypto orders.' + 'Companion to V-534.AG admin list. Renders the (date, status, count) rows returned by /v1/admin/crypto-orders/daily as a pivoted table (rows = dates, columns = statuses). Days with no orders are omitted by the server; we keep that posture client-side and skip the zero-fill — caller can widen `days` if they want a denser view.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AH — admin daily-breakdown view for crypto orders\./);
    expect(body).toMatch(
      /\/\/ Companion to V-534\.AG admin list\. Renders the \(date, status, count\)\s*\/\/ rows returned by \/v1\/admin\/crypto-orders\/daily as a pivoted table\s*\/\/ \(rows = dates, columns = statuses\)\. Days with no orders are\s*\/\/ omitted by the server; we keep that posture client-side and skip\s*\/\/ the zero-fill — caller can widen `days` if they want a denser view\./,
    );
  });

  it("STATUS_COLUMNS 6-status array pinned: ['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'] — pinned so the pivot table doesn't lose a status column (admin would undercount e.g. revenue at-risk in 'partial' state)", () => {
    expect(body).toMatch(
      /const STATUS_COLUMNS: AdminDailyStatus\[\] = \[\s*'pending',\s*'confirming',\s*'paid',\s*'failed',\s*'partial',\s*'cancelled',\s*\];/,
    );
  });

  it('DAYS_OPTIONS picker 5-value [7, 14, 30, 60, 90] (quarter-bounded) + days state default 7 + onChange Number.parseInt(e.target.value, 10) — pinned so the dropdown stays at the 7/14/30/60/90 series and Number.parseInt uses explicit radix 10 (not implicit Number coercion which trips on leading-zero strings)', () => {
    expect(body).toMatch(/const DAYS_OPTIONS = \[7, 14, 30, 60, 90\];/);
    expect(body).toMatch(/const \[days, setDays\] = useState<number>\(7\);/);
    expect(body).toMatch(
      /onChange=\{\(e\) => setDays\(Number\.parseInt\(e\.target\.value, 10\)\)\}/,
    );
  });

  it("PivotRow interface + pivot() helper: Map<string, PivotRow> bucketing initialized with all 6 statuses zeroed + row.counts[r.status] += r.count + row.total += r.count + sort newest-first comparator (a.date < b.date ? 1 : -1) — pinned so admin sees today's data first, not yesterday's", () => {
    expect(body).toMatch(
      /interface PivotRow \{\s*date: string;\s*counts: Record<AdminDailyStatus, number>;\s*total: number;\s*\}/,
    );
    expect(body).toMatch(
      /function pivot\(rows: AdminDailyRow\[\]\): PivotRow\[\] \{\s*const byDate = new Map<string, PivotRow>\(\);\s*for \(const r of rows\) \{\s*let row = byDate\.get\(r\.date\);\s*if \(!row\) \{\s*row = \{\s*date: r\.date,\s*counts: \{\s*pending: 0,\s*confirming: 0,\s*paid: 0,\s*failed: 0,\s*partial: 0,\s*cancelled: 0,\s*\},\s*total: 0,\s*\};\s*byDate\.set\(r\.date, row\);\s*\}\s*row\.counts\[r\.status\] \+= r\.count;\s*row\.total \+= r\.count;\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Newest day first\.\s*return Array\.from\(byDate\.values\(\)\)\.sort\(\(a, b\) => \(a\.date < b\.date \? 1 : -1\)\);/,
    );
  });

  it("Header: 'Crypto orders — daily breakdown' h2 + Days <label><select> picker + Refresh button disabled while loading; useMemo pivot only when state.kind === 'ready' (else empty array); ErrorBanner retry-on-dismiss=>refetch; truncated warning + empty-state 'No orders in the selected window.' + non-empty pivoted table", () => {
    expect(body).toMatch(
      /<h2 className="text-lg font-semibold">Crypto orders — daily breakdown<\/h2>/,
    );
    expect(body).toMatch(
      /const pivoted = useMemo\(\(\) => \(state\.kind === 'ready' \? pivot\(state\.data\.rows\) : \[\]\), \[state\]\);/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*<ErrorBanner message=\{state\.message\} onDismiss=\{\(\) => void refetch\(\)\} \/>\s*\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'ready' && state\.data\.truncated && \(\s*<p className="text-xs text-status-warning">\s*Window was truncated server-side\. Some older days may be missing — widen the analytics\s*pipeline if this becomes routine\.\s*<\/p>\s*\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'ready' && pivoted\.length === 0 && \(\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">\s*No orders in the selected window\.\s*<\/div>\s*\)\}/,
    );
  });

  it("Pivoted table: <thead> with Date + STATUS_COLUMNS.map column headers (capitalize) + Total; <tbody>: per-row date font-mono text-xs + STATUS_COLUMNS.map cells with '—' em-dash for 0 counts + total font-semibold — pinned so a 0-count cell renders the em-dash placeholder, not a literal '0' which clutters the at-a-glance read", () => {
    expect(body).toMatch(
      /<thead className="text-left text-ink-secondary">\s*<tr>\s*<th className="py-2 pr-4 font-medium">Date<\/th>\s*\{STATUS_COLUMNS\.map\(\(s\) => \(\s*<th key=\{s\} className="py-2 pr-4 font-medium capitalize">\s*\{s\}\s*<\/th>\s*\)\)\}\s*<th className="py-2 pr-4 font-medium">Total<\/th>\s*<\/tr>\s*<\/thead>/,
    );
    expect(body).toMatch(
      /\{pivoted\.map\(\(row\) => \(\s*<tr key=\{row\.date\} className="border-t border-surface-divider">\s*<td className="py-2 pr-4 font-mono text-xs">\{row\.date\}<\/td>\s*\{STATUS_COLUMNS\.map\(\(s\) => \(\s*<td key=\{s\} className="py-2 pr-4 text-ink-secondary">\s*\{row\.counts\[s\] === 0 \? '—' : row\.counts\[s\]\}\s*<\/td>\s*\)\)\}\s*<td className="py-2 pr-4 font-semibold">\{row\.total\}<\/td>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
