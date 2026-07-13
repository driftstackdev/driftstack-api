// W465.C — drift guard for apps/gui-client/src/lib/use-admin-crypto-pending-age.ts.
// V-534.AO useAdminCryptoPendingAge hook. Drift here either drops
// a bucket field from the AdminPendingAgeBuckets type (admin
// pending-age panel renders 0 for the missing window because the
// server returns the full 4-bucket shape and TS narrowing loses
// the partial) or changes pending_value_cents from Record<string,
// number> to a fixed currency map (server adds USDT support but
// the hook can't surface it without a code change).
//
//   • V-534.AO framing pinned + 'Wraps GET /v1/admin/crypto-orders/
//     pending-age (V-666.AC). Admin-only — requires the
//     `driftstack_internal_admin` scope. Returns the four age
//     buckets + total pending value by currency.'
//   • AdminPendingAgeBuckets 4-field (under_1h + h1_to_6h +
//     h6_to_24h + over_24h all numbers).
//   • AdminPendingAgeData: 5-field (buckets + pending_value_cents
//     Record<string, number> + total + truncated + scanned).
//   • Same state-machine + fetcher + useEffect pattern as
//     V-534.Q/H + URL `/v1/admin/crypto-orders/pending-age` exact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-crypto-pending-age.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W465.C apps/gui-client/src/lib/use-admin-crypto-pending-age.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AO framing pinned: 'V-534.AO — useAdminCryptoPendingAge hook.' + 'Wraps GET /v1/admin/crypto-orders/pending-age (V-666.AC). Admin-only — requires the `driftstack_internal_admin` scope. Returns the four age buckets + total pending value by currency.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AO — useAdminCryptoPendingAge hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/pending-age \(V-666\.AC\)\. Admin-only\s*\n?\s*\/\/ — requires the `driftstack_internal_admin` scope\. Returns the four\s*\n?\s*\/\/ age buckets \+ total pending value by currency\./,
    );
  });

  it('AdminPendingAgeBuckets 4-field (under_1h + h1_to_6h + h6_to_24h + over_24h all numbers — names pinned exact)', () => {
    expect(body).toMatch(
      /export interface AdminPendingAgeBuckets \{\s*\n?\s*under_1h: number;\s*\n?\s*h1_to_6h: number;\s*\n?\s*h6_to_24h: number;\s*\n?\s*over_24h: number;\s*\n?\s*\}/,
    );
  });

  it('AdminPendingAgeData 5-field: buckets + pending_value_cents Record<string, number> (currency-keyed, NOT fixed enum) + total + truncated + scanned', () => {
    expect(body).toMatch(
      /export interface AdminPendingAgeData \{\s*\n?\s*buckets: AdminPendingAgeBuckets;\s*\n?\s*pending_value_cents: Record<string, number>;\s*\n?\s*total: number;\s*\n?\s*truncated: boolean;\s*\n?\s*scanned: number;\s*\n?\s*\}/,
    );
  });

  it('AdminPendingAgeState 4-variant union (idle | loading | ready{data} | error{message}); UseAdminCryptoPendingAgeOpts: bare manual? (no JSDoc); UseAdminCryptoPendingAgeResult { state + refetch }', () => {
    expect(body).toMatch(
      /export type AdminPendingAgeState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: AdminPendingAgeData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseAdminCryptoPendingAgeOpts \{\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface UseAdminCryptoPendingAgeResult \{\s*\n?\s*state: AdminPendingAgeState;\s*\n?\s*refetch: \(\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it("Same state-machine pattern: manual?-aware initial state + no-apiKey 'No API key configured.' + trailing-slash strip + URL `/v1/admin/crypto-orders/pending-age` exact (no query string) + Bearer + accept JSON", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminPendingAgeState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/pending-age`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
  });

  it('Tail: HTTP/ready writes are sequence-gated, active work is dependency/unmount-aborted, and manual gate/dependencies remain exact', () => {
    expect(body).toMatch(
      /const message = await readApiErrorMessage\(res\);\s*\n?\s*if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'error', message \}\);[\s\S]*?if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(/\}, \[settings\.apiKey, settings\.baseUrl\]\);/);
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
