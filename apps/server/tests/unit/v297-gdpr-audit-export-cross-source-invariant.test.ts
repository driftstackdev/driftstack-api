// W903 — V-297 GDPR Article 20 audit-log export cross-source
// invariant. Two-hundred-twenty-ninth in the drift-guard series.
// Pins the V-297 audit-log export shape:
//
//   ExportAccountAuditLogQuery (1 field):
//     - format: z.enum(['csv', 'json']).optional().default('json').
//
//   ExportAccountAuditLogResponse (5 fields, format=json only):
//     - generated_at: ISO.
//     - account_id.
//     - row_count: int nonnegative.
//     - truncated: boolean — true if hit 10K server-side ceiling.
//     - data: array of AccountAuditEntry.
//
//   format=csv returns text/csv (NOT surfaced through SDK methods;
//   customers wanting CSV browser download hit the endpoint directly).
//
//   10,000-row server-side ceiling: truncated=true when older entries
//   were dropped; customers needing full history should narrow date
//   window OR use paginated /v1/account/audit-log read endpoint.
//
// stays in lockstep across api-types Zod canonical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W903 V-297 GDPR Article 20 audit export cross-source invariant', () => {
  // ─── V-297 anchor + Article 20 framing ───────────────────────

  it("CRITICAL packages/api-types/src/accounts.ts pins V-297 anchor — 'V-297 — bulk export envelope for GDPR Article 20 portability'. The Article 20 framing is what makes this a compliance feature.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-297 — bulk export envelope for GDPR Article 20 portability/);
  });

  // ─── ExportAccountAuditLogQuery format enum ─────────────────

  it("CRITICAL ExportAccountAuditLogQuerySchema has 1 field — format: z.enum(['csv', 'json']).optional().default('json'). The 2-format enum + JSON default lets customers download CSV in browser without specifying format explicitly.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /ExportAccountAuditLogQuerySchema = z\.object\(\{\s*\n\s*format: z\.enum\(\['csv', 'json'\]\)\.optional\(\)\.default\('json'\),\s*\n\s*\}\);/,
    );
  });

  // ─── csv vs json contract framing ───────────────────────────

  it("CRITICAL V-297 doc pins the format-split contract — 'format=json returns this shape; format=csv returns text/csv (not surfaced through the typed SDK methods — customers wanting CSV download in a browser hit the endpoint directly)'. The 2-format contract is what supports both API + browser flows.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/`format=json` returns this shape; `format=csv` returns text\/csv/);
    expect(p).toMatch(
      /not surfaced through the typed SDK methods — customers wanting\s*\n\/\/ CSV download in a browser hit the endpoint directly/,
    );
  });

  // ─── ExportAccountAuditLogResponse 5-field shape ─────────────

  it('CRITICAL ExportAccountAuditLogResponseSchema has 5 fields — generated_at + account_id + row_count + truncated + data. The 5-field envelope wraps audit entries with metadata (generated_at, row_count, truncated).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /ExportAccountAuditLogResponseSchema = z\.object\(\{\s*\n\s*generated_at: Iso8601Schema,\s*\n\s*account_id: z\.string\(\),\s*\n\s*row_count: z\.number\(\)\.int\(\)\.nonnegative\(\),/,
    );
    expect(p).toMatch(/truncated: z\.boolean\(\)/);
    expect(p).toMatch(/data: z\.array\(AccountAuditEntrySchema\)/);
  });

  // ─── 10K-row truncation ceiling framing ──────────────────────

  it("CRITICAL truncated field comment pins 10K-row ceiling + fallback — 'True when the row count hit the 10,000-row server-side ceiling and older entries were not included. Customers needing the full history should narrow the date window or use the paginated /v1/account/audit-log read endpoint'. The 10K cap + fallback hint is the V-297 compliance-vs-DoS balance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/True when the row count hit the 10,000-row server-side ceiling/);
    expect(p).toMatch(
      /Customers needing the full\s*\n\s*\*\s*history should narrow the date window or use the paginated/,
    );
    expect(p).toMatch(/\/v1\/account\/audit-log read endpoint/);
  });

  // ─── format defaults to json (browser-CSV is opt-in) ─────────

  it("CRITICAL format defaults to 'json' (NOT csv). The JSON default is what SDK consumers get without specifying format; CSV is the browser-friendly opt-in. Drift to defaulting csv would force SDK consumers to parse text.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/\.default\('json'\)/);
    expect(p, "format default MUST NOT be 'csv'").not.toMatch(/\.default\('csv'\)/);
  });

  // ─── Types re-exported ───────────────────────────────────────

  it('CRITICAL ExportAccountAuditLogQuery + ExportAccountAuditLogResponse types re-export from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export type ExportAccountAuditLogQuery = z\.infer<typeof ExportAccountAuditLogQuerySchema>;/,
    );
    expect(p).toMatch(
      /export type ExportAccountAuditLogResponse = z\.infer<typeof ExportAccountAuditLogResponseSchema>;/,
    );
  });

  // ─── 2-format cardinality ────────────────────────────────────

  it('CRITICAL format = EXACTLY 2 values (csv + json). The 2-format model is the GDPR Article 20 portability surface — drift to a 3rd format (xml, parquet, etc.) without coordinated SDK + dashboard would create unparseable export downloads.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/format: z\.enum\(\['csv', 'json'\]\)/);
  });

  // ─── Article 20 framing connects to AccountAuditAction ───────

  it('CRITICAL the V-297 export reads from AccountAuditEntry (the 27-value V-216 customer audit-log surface). The shared AuditEntry shape means the export is a bulk-read of the same audit-log surface customers see paginated at /v1/account/audit-log.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/data: z\.array\(AccountAuditEntrySchema\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/v297-gdpr-audit-export-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
