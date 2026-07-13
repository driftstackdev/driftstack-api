// W471.A — drift guard for apps/gui-client/src/lib/use-admin-crypto-stats.ts.
// V-534.AI useAdminCryptoStats hook. Drift here either drops the
// V-666.AE per-product breakdown optionals (admin stats dashboard
// loses the per-product revenue+count surfaces, falling back to
// only the aggregate paid_revenue_cents) or breaks the 6-status
// AdminCryptoStatsStatus union (a new server status leaks
// through as `any` and by_status counts go silent).
//
//   • V-534.AI framing pinned: 'useAdminCryptoStats hook.' +
//     'Wraps GET /v1/admin/crypto-orders/stats (V-666.N + V-666.W).
//     Admin-only — requires the `driftstack_internal_admin` scope.'
//   • AdminCryptoStatsStatus 6-value union ('pending'|'confirming'
//     |'paid'|'failed'|'partial'|'cancelled') — same shape as
//     AdminDailyStatus (V-534.AH).
//   • AdminCryptoStatsData 8-field: total + by_status Record +
//     paid_revenue_cents Record + avg_time_to_paid_ms nullable
//     + paid_sample + paid_revenue_by_product optional (V-666.AE
//     'paid revenue keyed by product → currency → cents.') +
//     paid_count_by_product optional (V-666.AE 'paid-order count
//     keyed by product.') + truncated + scanned.
//   • Same V-534 state-machine pattern as Q/H/AH/AO/BA + URL
//     `/v1/admin/crypto-orders/stats` exact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-crypto-stats.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W471.A apps/gui-client/src/lib/use-admin-crypto-stats.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AI framing pinned: 'V-534.AI — useAdminCryptoStats hook.' + 'Wraps GET /v1/admin/crypto-orders/stats (V-666.N + V-666.W). Admin-only — requires the `driftstack_internal_admin` scope.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AI — useAdminCryptoStats hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/stats \(V-666\.N \+ V-666\.W\)\. Admin-\s*\n?\s*\/\/ only — requires the `driftstack_internal_admin` scope\./,
    );
  });

  it("AdminCryptoStatsStatus 6-value union ('pending'|'confirming'|'paid'|'failed'|'partial'|'cancelled')", () => {
    expect(body).toMatch(
      /export type AdminCryptoStatsStatus =\s*\n?\s*'?pending'?\s*\| '?confirming'?\s*\| '?paid'?\s*\| '?failed'?\s*\| '?partial'?\s*\| '?cancelled'?;/,
    );
  });

  it("AdminCryptoStatsData 8-field: total + by_status Record<AdminCryptoStatsStatus, number> + paid_revenue_cents Record<string, number> + avg_time_to_paid_ms nullable + paid_sample + paid_revenue_by_product optional (V-666.AE 'paid revenue keyed by product → currency → cents.') + paid_count_by_product optional (V-666.AE 'paid-order count keyed by product.') + truncated + scanned", () => {
    expect(body).toMatch(
      /export interface AdminCryptoStatsData \{\s*\n?\s*total: number;\s*\n?\s*by_status: Record<AdminCryptoStatsStatus, number>;\s*\n?\s*paid_revenue_cents: Record<string, number>;\s*\n?\s*avg_time_to_paid_ms: number \| null;\s*\n?\s*paid_sample: number;\s*\n?\s*\/\*\* V-666\.AE — paid revenue keyed by product → currency → cents\. \*\/\s*\n?\s*paid_revenue_by_product\?: Record<string, Record<string, number>>;\s*\n?\s*\/\*\* V-666\.AE — paid-order count keyed by product\. \*\/\s*\n?\s*paid_count_by_product\?: Record<string, number>;\s*\n?\s*truncated: boolean;\s*\n?\s*scanned: number;\s*\n?\s*\}/,
    );
  });

  it('State machine retains manual behavior and exact endpoint while reads are deadline-bounded, single-flight, sequence-gated, and lifecycle-aborted', () => {
    expect(body).toMatch(
      /export type AdminCryptoStatsState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: AdminCryptoStatsData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/stats`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\n?\s*\(\) => \(\) => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;\s*\n?\s*\},\s*\n?\s*\[settings\.apiKey, settings\.baseUrl\],/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
