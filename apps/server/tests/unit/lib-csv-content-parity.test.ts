// W393.B — drift guard for apps/server/src/lib/csv.ts.
// V-666.V minimal RFC 4180 CSV encoder. Used by admin exports
// (crypto-orders today, audit-log dumps in future). Kept generic so
// adopters don't re-derive escaping. Drift here either corrupts
// exported spreadsheets (embedded quote/comma/newline mis-escaped)
// or silently changes the trailing-CRLF convention spreadsheets
// expect.
//
//   • V-666.V framing pinned.
//   • RFC 4180 rule recap (4 rules):
//       - Fields with comma, double-quote, CR, or LF → wrapped in
//         double quotes.
//       - Embedded "" inside a quoted field.
//       - Each row ends with CRLF.
//       - null/undefined → empty cell.
//   • CsvCell type union (string | number | boolean | null |
//     undefined).
//   • escapeCsvCell: stringify → wrap if `/[",\r\n]/` matches.
//   • formatCsvRow: cells.map(escape).join(',') — no trailing CRLF.
//   • buildCsv: header + rows, joined with '\r\n', trailing '\r\n'.
//   • Boolean stringification: 'true' / 'false' explicit (NOT toString
//     which would also work but isn't what the code uses).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W393.B apps/server/src/lib/csv.ts content parity', () => {
  const body = read(LIB);

  it('V-666.V framing pinned + admin-export consumer note', () => {
    expect(body).toMatch(/V-666\.V — minimal RFC 4180 CSV encoder for admin exports\./);
    expect(body).toMatch(
      /Used today by the admin crypto-orders export; kept generic so other\s*\/\/\s*admin endpoints \(audit log dumps, etc\.\) can adopt the same helper\s*\/\/\s*without re-deriving the escaping rules/,
    );
  });

  it('RFC 4180 rules block pinned: quote-wrap on special chars + doubled-quote escape + CRLF row + null→empty', () => {
    expect(body).toMatch(/RFC 4180 rules implemented:/);
    expect(body).toMatch(
      /- Fields containing comma, double-quote, CR, or LF are wrapped in\s*\/\/\s*double quotes\./,
    );
    expect(body).toMatch(/- Embedded double quotes are doubled \(""? inside a quoted field\)\./);
    expect(body).toMatch(/- Each row ends with CRLF\./);
    expect(body).toMatch(/- Values of type null \/ undefined render as an empty cell\./);
    expect(body).toMatch(/- Numbers \+ booleans stringify the obvious way\./);
  });

  it('CsvCell type: string | number | boolean | null | undefined union', () => {
    expect(body).toMatch(/export type CsvCell = string \| number \| boolean \| null \| undefined;/);
  });

  it('escapeCsvCell: null/undefined → "" sentinel; ternary on string/number/boolean stringification', () => {
    expect(body).toMatch(/export function escapeCsvCell\(value: CsvCell\): string/);
    expect(body).toMatch(/if \(value === null \|\| value === undefined\) return '';/);
    expect(body).toMatch(
      /let str =\s*typeof value === 'string'\s*\?\s*value\s*:\s*typeof value === 'number'\s*\?\s*value\.toString\(\)\s*:\s*value\s*\?\s*'true'\s*:\s*'false';/,
    );
  });

  it('escapeCsvCell: /[",\\r\\n]/ char-class triggers double-quote wrap + embedded "" doubling', () => {
    expect(body).toMatch(/if \(\/\[",\\r\\n\]\/\.test\(str\)\) \{/);
    expect(body).toMatch(/return `"\$\{str\.replace\(\/"\/g, '""'\)\}"`;/);
  });

  it('formatCsvRow: cells.map(escape).join(","), no trailing CRLF', () => {
    expect(body).toMatch(/Join one row of cells with commas — does NOT append a trailing CRLF\./);
    expect(body).toMatch(
      /export function formatCsvRow\(row: readonly CsvCell\[\]\): string \{\s*return row\.map\(escapeCsvCell\)\.join\(','\);\s*\}/,
    );
  });

  it('buildCsv: header row + iterable rows, joined with "\\r\\n", trailing "\\r\\n"', () => {
    expect(body).toMatch(
      /Build a complete CSV document from a header row \+ a row generator\.\s*\*\s*The output ends with a single trailing CRLF \(typical for spreadsheets\)/,
    );
    expect(body).toMatch(
      /export function buildCsv\(args: \{\s*header: readonly string\[\];\s*rows: Iterable<readonly CsvCell\[\]>;\s*\}\): string \{/,
    );
    expect(body).toMatch(/const lines: string\[\] = \[formatCsvRow\(args\.header\)\];/);
    expect(body).toMatch(
      /for \(const row of args\.rows\) \{\s*lines\.push\(formatCsvRow\(row\)\);\s*\}/,
    );
    expect(body).toMatch(/return lines\.join\('\\r\\n'\) \+ '\\r\\n';/);
  });

  it('imports: NONE (no external deps — pure encoding helper)', () => {
    expect(body).not.toMatch(/^import /m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
