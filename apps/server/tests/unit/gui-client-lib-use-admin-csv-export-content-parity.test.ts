// W471.C — drift guard for apps/gui-client/src/lib/use-admin-csv-export.ts.
// V-534.AX admin CSV export hook. Drift here either bypasses the
// bounded native-safe save helper (WKWebView can swallow synthesized
// downloads) or breaks the Bearer header (putting the admin token in
// a URL would expose it in browser history + referer headers).
//
//   • V-534.AX framing pinned: 'admin CSV export hook.' + 'Wraps
//     GET /v1/admin/crypto-orders.csv (V-666.AC). The endpoint
//     requires `Authorization: Bearer` so a plain anchor link
//     won't work. The bounded response is saved through the shared
//     Tauri filesystem/browser fallback so native downloads work.'
//   • State-machine framing 'idle | downloading | failed.
//     Successful downloads snap back to idle so the button is
//     immediately usable again.'
//   • AdminCsvExportState 3-variant (idle | downloading | failed
//     {message}).
//   • UseAdminCsvExportOpts 5-field with V-666.BY createdAfter/
//     createdBefore ISO 8601 bounds (inclusive lower / exclusive
//     upper).
//   • Query-string builder: status + search.trim() + accountId.
//     trim() + createdAfter.trim() + createdBefore.trim() with
//     length>0 guards.
//   • Download flow: readBoundedDownloadBlob + buildFilename +
//     downloadBlob + explicit save-failure state.
//   • buildFilename: `crypto-orders-${y}-${m}-${d}.csv` UTC with
//     padStart 4/2/2 + UTCMonth+1.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-csv-export.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W471.C apps/gui-client/src/lib/use-admin-csv-export.ts content parity', () => {
  const body = read(LIB);

  it('V-534.AX framing pins authenticated bounded saving through the shared native/browser fallback', () => {
    expect(body).toMatch(/\/\/ V-534\.AX — admin CSV export hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\.csv \(V-666\.AC\)\. The endpoint requires\s*\n?\s*\/\/ `Authorization: Bearer` so a plain anchor link won't work\. The bounded\s*\n?\s*\/\/ response is saved through the shared Tauri filesystem\/browser fallback,\s*\n?\s*\/\/ which avoids WKWebView's silently swallowed synthesized downloads\./,
    );
  });

  it("State-machine framing pinned: 'State machine: idle | downloading | failed. Successful downloads snap back to idle so the button is immediately usable again.'", () => {
    expect(body).toMatch(
      /\/\/ State machine: idle \| downloading \| failed\. Successful downloads\s*\n?\s*\/\/ snap back to idle so the button is immediately usable again\./,
    );
  });

  it("AdminCsvExportState 3-variant (idle | downloading | failed{message}) + UseAdminCsvExportOpts 5-field with V-666.BY createdAfter 'ISO 8601 lower bound (inclusive)' + createdBefore 'ISO 8601 upper bound (exclusive)'", () => {
    expect(body).toContain('export type AdminCsvExportState =');
    expect(body).toContain("{ kind: 'idle' }");
    expect(body).toContain("{ kind: 'downloading' }");
    expect(body).toContain("{ kind: 'failed'; message: string }");
    expect(body).toMatch(
      /\/\*\* V-666\.BY — ISO 8601 lower bound \(inclusive\)\. \*\/\s*\n?\s*createdAfter\?: string \| null;\s*\n?\s*\/\*\* V-666\.BY — ISO 8601 upper bound \(exclusive\)\. \*\/\s*\n?\s*createdBefore\?: string \| null;/,
    );
  });

  it("UseAdminCsvExportResult 3-method (state + download + reset); useAdminCsvExport: 5 opts ?? null defaults + no-apiKey → failed{message:'No API key configured.'}", () => {
    expect(body).toMatch(
      /export interface UseAdminCsvExportResult \{\s*\n?\s*state: AdminCsvExportState;\s*\n?\s*download: \(\) => Promise<void>;\s*\n?\s*reset: \(\) => void;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const status = opts\.status \?\? null;\s*\n?\s*const search = opts\.search \?\? null;\s*\n?\s*const accountId = opts\.accountId \?\? null;\s*\n?\s*const createdAfter = opts\.createdAfter \?\? null;\s*\n?\s*const createdBefore = opts\.createdBefore \?\? null;/,
    );
  });

  it("Query-string builder: new URL + status !== null .set('status', status); search.trim().length > 0 .set('search', search.trim()); accountId .set('account_id', accountId.trim()) (snake_case server field); createdAfter .set('created_after', ...); createdBefore .set('created_before', ...)", () => {
    expect(body).toMatch(
      /const url = new URL\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders\.csv`\);\s*\n?\s*if \(status !== null\) url\.searchParams\.set\('status', status\);\s*\n?\s*if \(search !== null && search\.trim\(\)\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('search', search\.trim\(\)\);\s*\n?\s*\}\s*\n?\s*if \(accountId !== null && accountId\.trim\(\)\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('account_id', accountId\.trim\(\)\);\s*\n?\s*\}\s*\n?\s*if \(createdAfter !== null && createdAfter\.trim\(\)\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('created_after', createdAfter\.trim\(\)\);\s*\n?\s*\}\s*\n?\s*if \(createdBefore !== null && createdBefore\.trim\(\)\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('created_before', createdBefore\.trim\(\)\);\s*\n?\s*\}/,
    );
  });

  it('Download flow remains authenticated and filtered while transport is deadline-bounded and lifecycle-safe', () => {
    expect(body).toMatch(/setState\(\{ kind: 'downloading' \}\);/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(url\.toString\(\), \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,/,
    );
    expect(body).toContain('authorization: `Bearer ${settings.apiKey}`');
    expect(body).toContain("accept: 'text/csv',");
    expect(body).toContain('if (inFlightRef.current) return;');
    expect(body).toContain('if (sequence !== sequenceRef.current) return;');
    expect(body).toContain("import { downloadBlob, readBoundedDownloadBlob } from './download';");
    expect(body).toContain('const blob = await readBoundedDownloadBlob(res);');
    expect(body).toContain('const saved = await downloadBlob(filename, blob);');
    expect(body).toContain(
      "message: 'The CSV export could not be saved. Check Downloads access and try again.',",
    );
    expect(body).not.toContain('URL.createObjectURL');
    expect(body).not.toContain("document.createElement('a')");
    expect(body).toContain('requestRef.current?.abort();');
  });

  it('useCallback deps: [settings.apiKey, settings.baseUrl, status, search, accountId, createdAfter, createdBefore]; buildFilename: `crypto-orders-${y}-${m}-${d}.csv` UTC + getUTCFullYear padStart(4) + getUTCMonth()+1 padStart(2) + getUTCDate padStart(2)', () => {
    expect(body).toMatch(
      /\}, \[settings\.apiKey, settings\.baseUrl, status, search, accountId, createdAfter, createdBefore\]\);/,
    );
    expect(body).toMatch(
      /function buildFilename\(now: Date\): string \{\s*\n?\s*const y = now\.getUTCFullYear\(\)\.toString\(\)\.padStart\(4, '0'\);\s*\n?\s*const m = \(now\.getUTCMonth\(\) \+ 1\)\.toString\(\)\.padStart\(2, '0'\);\s*\n?\s*const d = now\.getUTCDate\(\)\.toString\(\)\.padStart\(2, '0'\);\s*\n?\s*return `crypto-orders-\$\{y\}-\$\{m\}-\$\{d\}\.csv`;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
