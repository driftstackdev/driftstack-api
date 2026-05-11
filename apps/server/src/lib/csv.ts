// V-666.V — minimal RFC 4180 CSV encoder for admin exports.
//
// Used today by the admin crypto-orders export; kept generic so other
// admin endpoints (audit log dumps, etc.) can adopt the same helper
// without re-deriving the escaping rules.
//
// RFC 4180 rules implemented:
//   - Fields containing comma, double-quote, CR, or LF are wrapped in
//     double quotes.
//   - Embedded double quotes are doubled ("" inside a quoted field).
//   - Each row ends with CRLF.
//   - Values of type null / undefined render as an empty cell.
//   - Numbers + booleans stringify the obvious way.

export type CsvCell = string | number | boolean | null | undefined;

/** Escape a single cell. Returns the cell ready for joining with commas. */
export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const str =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? value.toString()
        : value
          ? 'true'
          : 'false';
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Join one row of cells with commas — does NOT append a trailing CRLF. */
export function formatCsvRow(row: readonly CsvCell[]): string {
  return row.map(escapeCsvCell).join(',');
}

/**
 * Build a complete CSV document from a header row + a row generator.
 * The output ends with a single trailing CRLF (typical for spreadsheets).
 */
export function buildCsv(args: {
  header: readonly string[];
  rows: Iterable<readonly CsvCell[]>;
}): string {
  const lines: string[] = [formatCsvRow(args.header)];
  for (const row of args.rows) {
    lines.push(formatCsvRow(row));
  }
  return lines.join('\r\n') + '\r\n';
}
