// W972 — V-666.V csv RFC 4180 cross-source invariant. Two-hundred-
// ninety-eighth in the drift-guard series. Pins the apps/server/src/
// lib/csv.ts admin-export RFC 4180 encoder:
//
//   V-666.V anchor — 'V-666.V — minimal RFC 4180 CSV encoder for
//   admin exports'.
//
//   Reuse framing — 'Used today by the admin crypto-orders export;
//   kept generic so other admin endpoints (audit log dumps, etc.)
//   can adopt the same helper without re-deriving the escaping
//   rules'.
//
//   RFC 4180 4-rule inventory:
//     - Fields containing comma, double-quote, CR, or LF are wrapped
//       in double quotes.
//     - Embedded double quotes are doubled ("" inside a quoted field).
//     - Each row ends with CRLF.
//     - Values of type null / undefined render as an empty cell.
//     - Numbers + booleans stringify the obvious way.
//
//   CsvCell type union: string | number | boolean | null | undefined.
//
//   escapeCsvCell quote-trigger regex /[",\r\n]/ — matches any of
//     the 4 escape-trigger characters.
//
//   Boolean stringification: true → 'true', false → 'false'.
//
//   formatCsvRow does NOT append trailing CRLF — buildCsv handles
//     joining with CRLF + single trailing CRLF.
//
//   buildCsv ends with single trailing CRLF — 'typical for
//     spreadsheets'.
//
// stays in lockstep across apps/server/src/lib/csv.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCsv, escapeCsvCell, formatCsvRow } from '../../src/lib/csv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W972 V-666.V csv RFC 4180 cross-source invariant', () => {
  // ─── V-666.V anchor ──────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/csv.ts header pins V-666.V anchor — 'V-666.V — minimal RFC 4180 CSV encoder for admin exports'. The V-666.V anchor is the policy provenance for the admin-CSV-encoder primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/V-666\.V — minimal RFC 4180 CSV encoder for admin exports\./);
  });

  // ─── Reuse framing ───────────────────────────────────────────

  it("CRITICAL reuse framing — 'Used today by the admin crypto-orders export; kept generic so other admin endpoints (audit log dumps, etc.) can adopt the same helper without re-deriving the escaping rules'. The generic-shared-helper + don't-re-derive-rules design is the V-666.V reuse contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/Used today by the admin crypto-orders export; kept generic so other/);
    expect(p).toMatch(/admin endpoints \(audit log dumps, etc\.\) can adopt the same helper/);
    expect(p).toMatch(/without re-deriving the escaping rules\./);
  });

  // ─── RFC 4180 4-rule inventory ───────────────────────────────

  it('CRITICAL RFC 4180 rule inventory framing — \'Fields containing comma, double-quote, CR, or LF are wrapped in double quotes. Embedded double quotes are doubled ("" inside a quoted field). Each row ends with CRLF. Values of type null / undefined render as an empty cell. Numbers + booleans stringify the obvious way\'. The 5-rule inventory is the V-666.V escaping contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/- Fields containing comma, double-quote, CR, or LF are wrapped in/);
    expect(p).toMatch(/double quotes\./);
    expect(p).toMatch(/- Embedded double quotes are doubled \(""/);
    expect(p).toMatch(/inside a quoted field\)\./);
    expect(p).toMatch(/- Each row ends with CRLF\./);
    expect(p).toMatch(/- Values of type null \/ undefined render as an empty cell\./);
    expect(p).toMatch(/- Numbers \+ booleans stringify the obvious way\./);
  });

  // ─── CsvCell type union ──────────────────────────────────────

  it("CRITICAL CsvCell type union — 'string | number | boolean | null | undefined'. The 5-member union covers the admin-export-row primitives.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/export type CsvCell = string \| number \| boolean \| null \| undefined;/);
  });

  // ─── escapeCsvCell quote-trigger regex ───────────────────────

  it('CRITICAL escapeCsvCell quote-trigger regex /[",\\r\\n]/ — matches any of the 4 escape-trigger characters (double-quote, comma, CR, LF). The 4-char escape set matches the RFC 4180 rule.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/if \(\/\[",\\r\\n\]\/\.test\(str\)\) \{/);
    expect(p).toMatch(/return `"\$\{str\.replace\(\/"\/g, '""'\)\}"`;/);
  });

  // ─── Boolean stringification ─────────────────────────────────

  it("CRITICAL boolean stringification — 'value ? true : false' (lowercase). The lowercase boolean encoding matches the JS / spreadsheet convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/\? 'true'\s*\n\s*:\s*'false';/);
  });

  // ─── formatCsvRow does NOT append trailing CRLF ──────────────

  it("CRITICAL formatCsvRow framing — 'Join one row of cells with commas — does NOT append a trailing CRLF'. The no-trailing-CRLF design keeps the row-joiner reusable + the trailing-CRLF semantics owned by buildCsv.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(
      /\/\*\* Join one row of cells with commas — does NOT append a trailing CRLF\. \*\//,
    );
    expect(p).toMatch(/export function formatCsvRow\(row: readonly CsvCell\[\]\): string \{/);
    expect(p).toMatch(/return row\.map\(escapeCsvCell\)\.join\(','\);/);
  });

  // ─── buildCsv trailing-CRLF ──────────────────────────────────

  it("CRITICAL buildCsv ends with single trailing CRLF — 'return lines.join(\\r\\n) + \\r\\n'. The single-trailing-CRLF design is the spreadsheet-compatibility convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/return lines\.join\('\\r\\n'\) \+ '\\r\\n';/);
  });

  it("CRITICAL buildCsv framing — 'Build a complete CSV document from a header row + a row generator. The output ends with a single trailing CRLF (typical for spreadsheets)'. The header + row-generator + single-trailing-CRLF design is the customer-facing CSV contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/csv.ts'));
    expect(p).toMatch(/Build a complete CSV document from a header row \+ a row generator\./);
    expect(p).toMatch(/The output ends with a single trailing CRLF \(typical for spreadsheets\)\./);
  });

  // ─── Runtime escape matrix ───────────────────────────────────

  it('CRITICAL runtime — escapeCsvCell on plain string returns the string unchanged.', () => {
    expect(escapeCsvCell('hello')).toBe('hello');
  });

  it('CRITICAL runtime — null + undefined render as empty cell.', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it("CRITICAL runtime — number stringifies as the obvious decimal — 42 → '42', -3.5 → '-3.5'.", () => {
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(-3.5)).toBe('-3.5');
  });

  it("CRITICAL runtime — boolean stringifies as 'true' / 'false' lowercase.", () => {
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(false)).toBe('false');
  });

  it('CRITICAL runtime — string with comma is wrapped in quotes.', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
  });

  it('CRITICAL runtime — string with embedded double-quote is doubled inside quote-wrapping (RFC 4180): \'he"llo\' → \'"he""llo"\'.', () => {
    expect(escapeCsvCell('he"llo')).toBe('"he""llo"');
  });

  it('CRITICAL runtime — CR / LF / CRLF in cell triggers quote-wrap.', () => {
    expect(escapeCsvCell('a\rb')).toBe('"a\rb"');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
    expect(escapeCsvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('CRITICAL runtime — formatCsvRow joins with commas and does NOT add trailing CRLF.', () => {
    expect(formatCsvRow(['a', 1, true, null, 'x,y'])).toBe('a,1,true,,"x,y"');
  });

  it('CRITICAL runtime — buildCsv with 0 rows yields just the header + trailing CRLF.', () => {
    expect(buildCsv({ header: ['id', 'name'], rows: [] })).toBe('id,name\r\n');
  });

  it('CRITICAL runtime — buildCsv with N rows yields header + N rows joined by CRLF + single trailing CRLF.', () => {
    const out = buildCsv({
      header: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'Bob, the second'],
      ],
    });
    expect(out).toBe('id,name\r\n1,Alice\r\n2,"Bob, the second"\r\n');
  });

  it('CRITICAL runtime — buildCsv with an iterable row-generator (not array) works the same. The Iterable type is what lets crypto-orders export stream pg-cursor rows without buffering.', () => {
    function* gen(): IterableIterator<readonly (string | number)[]> {
      yield [1, 'a'];
      yield [2, 'b'];
    }
    expect(buildCsv({ header: ['n', 's'], rows: gen() })).toBe('n,s\r\n1,a\r\n2,b\r\n');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/csv-v666v-rfc4180-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
