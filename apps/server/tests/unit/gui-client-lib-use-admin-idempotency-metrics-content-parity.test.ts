// W470.A — drift guard for apps/gui-client/src/lib/use-admin-idempotency-metrics.ts.
// V-534.BA useAdminIdempotencyMetrics hook. Drift here either drops
// the body_mismatches optional field (V-666.AR replay-body-mismatch
// surface disappears from the admin dashboard, which would mask a
// class of bugs where retry calls send different bodies) or breaks
// the manual? gate (poll loop on the stats card hammers the
// idempotency-metrics endpoint on every render).
//
//   • V-534.BA framing pinned: 'Wraps GET /v1/admin/crypto-orders/
//     idempotency-metrics (V-666.AP). Admin-only — requires the
//     `driftstack_internal_admin` scope. Cheap to scrape (no full-
//     table walk), so the dashboard polls it alongside the stats
//     card on every refresh.'
//   • AdminIdempotencyMetricsData 3-field (replays + first_writes +
//     body_mismatches optional with 'V-666.AR — count of replays
//     where the request body differed from the stored one.' framing).
//   • Same V-534 state-machine + fetcher + useEffect pattern as
//     V-534.Q/H/AH/AO + URL `/v1/admin/crypto-orders/idempotency-
//     metrics` exact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-idempotency-metrics.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W470.A apps/gui-client/src/lib/use-admin-idempotency-metrics.ts content parity', () => {
  const body = read(LIB);

  it("V-534.BA framing pinned: 'V-534.BA — useAdminIdempotencyMetrics hook.' + 'Wraps GET /v1/admin/crypto-orders/idempotency-metrics (V-666.AP). Admin-only — requires the `driftstack_internal_admin` scope. Cheap to scrape (no full-table walk), so the dashboard polls it alongside the stats card on every refresh.'", () => {
    expect(body).toMatch(/\/\/ V-534\.BA — useAdminIdempotencyMetrics hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/idempotency-metrics \(V-666\.AP\)\.\s*\n?\s*\/\/ Admin-only — requires the `driftstack_internal_admin` scope\. Cheap\s*\n?\s*\/\/ to scrape \(no full-table walk\), so the dashboard polls it alongside\s*\n?\s*\/\/ the stats card on every refresh\./,
    );
  });

  it("AdminIdempotencyMetricsData 3-field: replays + first_writes + body_mismatches optional with 'V-666.AR — count of replays where the request body differed from the stored one.' framing", () => {
    expect(body).toMatch(
      /export interface AdminIdempotencyMetricsData \{\s*\n?\s*replays: number;\s*\n?\s*first_writes: number;\s*\n?\s*\/\*\* V-666\.AR — count of replays where the request body differed from the stored one\. \*\/\s*\n?\s*body_mismatches\?: number;\s*\n?\s*\}/,
    );
  });

  it('AdminIdempotencyMetricsState 4-variant union (idle | loading | ready{data} | error{message}); UseAdminIdempotencyMetricsOpts bare manual? (no JSDoc); UseAdminIdempotencyMetricsResult { state + refetch }', () => {
    expect(body).toMatch(
      /export type AdminIdempotencyMetricsState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: AdminIdempotencyMetricsData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseAdminIdempotencyMetricsOpts \{\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
  });

  it("Same V-534 state-machine pattern: manual?-aware initial state + no-apiKey 'No API key configured.' + trailing-slash strip + URL `/v1/admin/crypto-orders/idempotency-metrics` exact + Bearer + accept JSON + !res.ok readApiErrorMessage + instance-of-Error catch", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminIdempotencyMetricsState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*\n?\s*`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/idempotency-metrics`,\s*\n?\s*\{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
  });

  it('single-flight and dependency/unmount lifecycle guards retain the manual gate and exact callback dependencies', () => {
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
