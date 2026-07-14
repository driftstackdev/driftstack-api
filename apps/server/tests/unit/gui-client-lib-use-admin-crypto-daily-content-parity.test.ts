// W466.A — drift guard for apps/gui-client/src/lib/use-admin-crypto-daily.ts.
// V-534.AH useAdminCryptoDaily hook. Drift here either drops the
// AdminDailyStatus 6-value union (a new server status leaks
// through as `any` and the consuming view's switch-coverage gets
// silently incomplete) or breaks the URL-builder pattern
// (new URL(...) with searchParams.set instead of manual query-
// string concat) which is what makes opts.days encoding safe.
//
//   • V-534.AH framing pinned + 'Wraps GET /v1/admin/crypto-
//     orders/daily (V-666.O). Admin-only — requires the
//     `driftstack_internal_admin` scope. Returns one row per
//     (date, status) combination; the consuming view fills gaps
//     + stacks statuses for display.'
//   • AdminDailyStatus 6-value union ('pending'|'confirming'|
//     'paid'|'failed'|'partial'|'cancelled').
//   • AdminDailyRow 3-field (date 'YYYY-MM-DD (UTC)' comment +
//     status + count).
//   • AdminDailyData 3-field (days + rows + truncated).
//   • UseAdminCryptoDailyOpts: days? 'Lookback window in days
//     (default unset — server defaults to 7, max 90).' + manual?
//   • URL-builder: new URL(`${baseUrl}/v1/admin/crypto-orders/
//     daily`) + days !== undefined → searchParams.set('days',
//     days.toString()).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-crypto-daily.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W466.A apps/gui-client/src/lib/use-admin-crypto-daily.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AH framing pinned: 'V-534.AH — useAdminCryptoDaily hook.' + 'Wraps GET /v1/admin/crypto-orders/daily (V-666.O). Admin-only — requires the `driftstack_internal_admin` scope. Returns one row per (date, status) combination; the consuming view fills gaps + stacks statuses for display.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AH — useAdminCryptoDaily hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/daily \(V-666\.O\)\. Admin-only —\s*\n?\s*\/\/ requires the `driftstack_internal_admin` scope\. Returns one row per\s*\n?\s*\/\/ \(date, status\) combination; the consuming view fills gaps \+ stacks\s*\n?\s*\/\/ statuses for display\./,
    );
  });

  it("AdminDailyStatus 6-value union ('pending'|'confirming'|'paid'|'failed'|'partial'|'cancelled') matches server payment-status surface", () => {
    expect(body).toMatch(
      /export type AdminDailyStatus =\s*\n?\s*\| 'pending'\s*\n?\s*\| 'confirming'\s*\n?\s*\| 'paid'\s*\n?\s*\| 'failed'\s*\n?\s*\| 'partial'\s*\n?\s*\| 'cancelled';/,
    );
  });

  it("AdminDailyRow 3-field (date string 'YYYY-MM-DD (UTC)' comment + status AdminDailyStatus + count number); AdminDailyData 3-field (days + rows AdminDailyRow[] + truncated)", () => {
    expect(body).toMatch(
      /export interface AdminDailyRow \{\s*\n?\s*date: string; \/\/ YYYY-MM-DD \(UTC\)\s*\n?\s*status: AdminDailyStatus;\s*\n?\s*count: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface AdminDailyData \{\s*\n?\s*days: number;\s*\n?\s*rows: AdminDailyRow\[\];\s*\n?\s*truncated: boolean;\s*\n?\s*\}/,
    );
  });

  it("UseAdminCryptoDailyOpts: days? 'Lookback window in days (default unset — server defaults to 7, max 90).' + manual? 'Disable auto-fetch on mount.'", () => {
    expect(body).toMatch(
      /export interface UseAdminCryptoDailyOpts \{\s*\n?\s*\/\*\* Lookback window in days \(default unset — server defaults to 7, max 90\)\. \*\/\s*\n?\s*days\?: number;\s*\n?\s*\/\*\* Disable auto-fetch on mount\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
  });

  it("URL-builder pattern: new URL(`${baseUrl}/v1/admin/crypto-orders/daily`) + days !== undefined → url.searchParams.set('days', days.toString()) (NOT manual query-string concat)", () => {
    expect(body).toMatch(
      /const url = new URL\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/daily`\);\s*\n?\s*if \(days !== undefined\) url\.searchParams\.set\('days', days\.toString\(\)\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(url\.toString\(\), \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
    expect(body).toMatch(/import \{ readBoundedApiJson \} from '\.\/read-bounded-json';/);
    expect(body).toMatch(/const body = await readBoundedApiJson<AdminDailyData>\(res\);/);
    expect(body).not.toMatch(/await res\.json\(\)/);
  });

  it('State-machine behavior remains while reads are single-flight, sequence-gated, and aborted on key/base/days changes or unmount', () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminDailyState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(/\}, \[settings\.apiKey, settings\.baseUrl, days\]\);/);
    expect(body).toMatch(
      /useEffect\(\s*\n?\s*\(\) => \(\) => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;\s*\n?\s*\},\s*\n?\s*\[settings\.apiKey, settings\.baseUrl, days\],/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
