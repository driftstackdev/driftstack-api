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

function adminCryptoStatsStatuses(source: string): string[] {
  const declaration = source.match(/export type AdminCryptoStatsStatus\s*=([\s\S]*?);/)?.[1] ?? '';
  return [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('W471.A apps/gui-client/src/lib/use-admin-crypto-stats.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AI framing pinned: 'V-534.AI — useAdminCryptoStats hook.' + 'Wraps GET /v1/admin/crypto-orders/stats (V-666.N + V-666.W). Admin-only — requires the `driftstack_internal_admin` scope.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AI — useAdminCryptoStats hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/stats \(V-666\.N \+ V-666\.W\)\. Admin-\s*\/\/ only — requires the `driftstack_internal_admin` scope\./,
    );
  });

  it("AdminCryptoStatsStatus 6-value union ('pending'|'confirming'|'paid'|'failed'|'partial'|'cancelled')", () => {
    const expected = ['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'];
    expect(adminCryptoStatsStatuses(body)).toEqual(expected);

    const missingStatus = body.replace("  | 'cancelled';", ';');
    const extraStatus = body.replace("  | 'cancelled';", "  | 'cancelled'\n  | 'refunded';");
    expect(missingStatus).not.toBe(body);
    expect(extraStatus).not.toBe(body);
    expect(adminCryptoStatsStatuses(missingStatus)).not.toEqual(expected);
    expect(adminCryptoStatsStatuses(extraStatus)).not.toEqual(expected);
  });

  it("AdminCryptoStatsData 8-field: total + by_status Record<AdminCryptoStatsStatus, number> + paid_revenue_cents Record<string, number> + avg_time_to_paid_ms nullable + paid_sample + paid_revenue_by_product optional (V-666.AE 'paid revenue keyed by product → currency → cents.') + paid_count_by_product optional (V-666.AE 'paid-order count keyed by product.') + truncated + scanned", () => {
    expect(body).toMatch(
      /export interface AdminCryptoStatsData \{\s*total: number;\s*by_status: Record<AdminCryptoStatsStatus, number>;\s*paid_revenue_cents: Record<string, number>;\s*avg_time_to_paid_ms: number \| null;\s*paid_sample: number;\s*\/\*\* V-666\.AE — paid revenue keyed by product → currency → cents\. \*\/\s*paid_revenue_by_product\?: Record<string, Record<string, number>>;\s*\/\*\* V-666\.AE — paid-order count keyed by product\. \*\/\s*paid_count_by_product\?: Record<string, number>;\s*truncated: boolean;\s*scanned: number;\s*\}/,
    );
  });

  it('State machine retains manual behavior and exact endpoint while reads are deadline-bounded, single-flight, sequence-gated, and lifecycle-aborted', () => {
    expect(body).toMatch(
      /export type AdminCryptoStatsState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'ready'; data: AdminCryptoStatsData \}\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/stats`, \{\s*method: 'GET',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*accept: 'application\/json',/,
    );
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);\s*requestRef\.current = null;\s*inFlightRef\.current = false;\s*\},\s*\[settings\.apiKey, settings\.baseUrl\],/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*if \(opts\.manual === true\) return;\s*void fetcher\(\);\s*\}, \[fetcher, opts\.manual\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
