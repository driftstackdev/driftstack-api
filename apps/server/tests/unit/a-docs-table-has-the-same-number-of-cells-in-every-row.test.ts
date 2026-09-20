// A TABLE ON A PUBLIC DOCS PAGE MUST BE A TABLE.
//
// Markdown tables are recognised by SHAPE: a row of cells, then a delimiter row
// of dashes, and the two must hold the SAME NUMBER OF CELLS. When they do not,
// the markdown parser this site is built with does not see a table at all — it
// emits the whole block as one paragraph, and the reader gets a wall of `|`
// characters where the reference was. A body row with MORE cells than the
// header is the other half of the same fault: the extra cell is dropped, so
// documentation that was written and reviewed is silently not published.
//
// ⛔ NOTHING ELSE IN THE SUITE LOOKS AT THIS. The content-parity tests assert
// that a page CONTAINS a string; a string inside a broken table is still
// contained. That is how a metric reference page shipped with its whole
// inventory table unrendered while every parity test stayed green.
//
// The rule is GFM's own: "The delimiter row must match the header row in the
// number of cells. If not, a table will not be recognized."

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Cells in one table row. A `|` inside a code span is literal text, not a cell
 * boundary — several of these pages document PromQL and regexes — and a
 * backslash escapes the next character, so both are honoured here rather than
 * counted as separators.
 */
function cellCount(line: string): number {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  let cells = 1;
  let inCode = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') escaped = true;
    else if (ch === '`') inCode = !inCode;
    else if (ch === '|' && !inCode) cells += 1;
  }
  return cells;
}

// One dash is a legal delimiter cell, so the bound is `-+` and not `-{2,}`:
// requiring two would have skipped the compact tables entirely and reported
// them as well-formed by never looking at them.
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isDelimiterRow(line: string): boolean {
  return line.includes('|') && DELIMITER.test(line.trim());
}

interface Table {
  file: string;
  line: number;
  headerCells: number;
  delimiterCells: number;
  rows: Array<{ line: number; cells: number }>;
}

/** Every table in one file, by the shape a markdown parser looks for. */
export function tablesIn(body: string, file = '<memory>'): Table[] {
  const lines = body.split('\n');
  const tables: Table[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const delimiter = lines[i] ?? '';
    if (!isDelimiterRow(delimiter)) continue;
    const header = lines[i - 1] ?? '';
    if (!header.includes('|')) continue;
    const headerCells = cellCount(header);
    const rows: Array<{ line: number; cells: number }> = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const row = lines[j] ?? '';
      if (!row.trim().startsWith('|')) break;
      rows.push({ line: j + 1, cells: cellCount(row) });
    }
    tables.push({
      file,
      line: i,
      headerCells,
      delimiterCells: cellCount(delimiter),
      rows,
    });
  }
  return tables;
}

describe('every table on a public docs page has the same number of cells in every row', () => {
  const files = markdownFiles(PAGES);
  const tables = files.flatMap((file) =>
    tablesIn(readFileSync(file, 'utf8'), relative(REPO_ROOT, file)),
  );

  it('the scan finds the pages and the tables — a walk that matched nothing would make every assertion below trivially true', () => {
    // Deliberately below the current counts (58 pages, 60+ tables) so the floor
    // is about the scan working, not about the docs never shrinking.
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(tables.reduce((n, t) => n + t.rows.length, 0)).toBeGreaterThanOrEqual(100);
  });

  it('CRITICAL the delimiter row holds exactly as many cells as its header — a mismatch makes the parser drop the table and print the raw pipes to the reader', () => {
    const mismatched = tables
      .filter((t) => t.headerCells !== t.delimiterCells)
      .map(
        (t) =>
          `${t.file}:${String(t.line + 1)} header=${String(t.headerCells)} delimiter=${String(t.delimiterCells)}`,
      );
    expect(mismatched).toEqual([]);
  });

  it('CRITICAL no body row carries more cells than its header — the extra cell is dropped, so prose that was written and reviewed is silently not published', () => {
    const ragged = tables
      .flatMap((t) =>
        t.rows
          .filter((r) => r.cells !== t.headerCells)
          .map(
            (r) =>
              `${t.file}:${String(r.line)} row=${String(r.cells)} header=${String(t.headerCells)}`,
          ),
      )
      .slice(0, 20);
    expect(ragged).toEqual([]);
  });

  it('NEGATIVE CONTROL the checker actually reports a mismatch — a parser that read every table as well-formed would pass the two arms above on any input', () => {
    const broken = tablesIn(['| A | B | C |', '| - | - | - | - |', '| 1 | 2 | 3 |', ''].join('\n'));
    expect(broken).toHaveLength(1);
    expect(broken[0]?.headerCells).toBe(3);
    expect(broken[0]?.delimiterCells).toBe(4);

    const raggedRow = tablesIn(['| A | B |', '| - | - |', '| 1 | 2 | 3 |', ''].join('\n'));
    expect(raggedRow[0]?.rows).toEqual([{ line: 3, cells: 3 }]);

    // And a well-formed one is NOT reported, so the control cuts both ways.
    const fine = tablesIn(['| A | B |', '| - | - |', '| 1 | 2 |', ''].join('\n'));
    expect(fine[0]?.headerCells).toBe(fine[0]?.delimiterCells);
    expect(fine[0]?.rows.every((r) => r.cells === 2)).toBe(true);
  });

  it('a pipe inside a code span is text, not a cell boundary — the metrics and rate-limit pages document PromQL and regexes that contain one', () => {
    expect(cellCount('| `a|b` | c |')).toBe(2);
    expect(cellCount('| a \\| b | c |')).toBe(2);
  });
});
