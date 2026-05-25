// V-553.B-33 — unit tests for the RFC 4180 CSV helper (V-666.V).

import { describe, expect, it } from 'vitest';
import { buildCsv, escapeCsvCell, formatCsvRow } from '../../src/lib/csv.js';

describe('V-553.B-33 escapeCsvCell', () => {
  it('returns plain strings as-is', () => {
    expect(escapeCsvCell('hello')).toBe('hello');
    expect(escapeCsvCell('hello world')).toBe('hello world');
  });

  it('renders null and undefined as empty cells', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('stringifies numbers and booleans', () => {
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(false)).toBe('false');
  });

  it('quotes cells containing commas', () => {
    expect(escapeCsvCell('hello, world')).toBe('"hello, world"');
  });

  it('escapes double quotes by doubling them inside a quoted field', () => {
    expect(escapeCsvCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes cells containing CR or LF', () => {
    expect(escapeCsvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(escapeCsvCell('one\rtwo')).toBe('"one\rtwo"');
    expect(escapeCsvCell('one\r\ntwo')).toBe('"one\r\ntwo"');
  });

  it('neutralises string cells that a spreadsheet would treat as a formula (CWE-1236)', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-cmd')).toBe("'-cmd");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // Combined with quote-wrapping when the cell also needs it.
    expect(escapeCsvCell('=HYPERLINK("http://x","a")')).toBe('"\'=HYPERLINK(""http://x"",""a"")"');
  });

  it('does NOT prefix negative numbers (guard is string-only)', () => {
    expect(escapeCsvCell(-3.5)).toBe('-3.5');
    expect(escapeCsvCell(-42)).toBe('-42');
  });
});

describe('V-553.B-33 formatCsvRow', () => {
  it('joins cells with commas', () => {
    expect(formatCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('does not append a trailing newline', () => {
    expect(formatCsvRow(['a'])).toBe('a');
  });

  it('renders mixed-type rows correctly', () => {
    expect(formatCsvRow(['ord_1', 2500, null, 'EUR'])).toBe('ord_1,2500,,EUR');
  });

  it('quotes only the cells that need it', () => {
    expect(formatCsvRow(['safe', 'has,comma', 'safe'])).toBe('safe,"has,comma",safe');
  });
});

describe('V-553.B-33 buildCsv', () => {
  it('emits header + rows separated by CRLF + trailing CRLF', () => {
    const csv = buildCsv({
      header: ['order_id', 'amount'],
      rows: [
        ['ord_1', 2500],
        ['ord_2', 14900],
      ],
    });
    expect(csv).toBe('order_id,amount\r\nord_1,2500\r\nord_2,14900\r\n');
  });

  it('emits just the header + trailing CRLF for an empty row generator', () => {
    const csv = buildCsv({ header: ['a', 'b'], rows: [] });
    expect(csv).toBe('a,b\r\n');
  });

  it('escapes header cells that need quoting', () => {
    const csv = buildCsv({ header: ['key,with,commas'], rows: [] });
    expect(csv).toBe('"key,with,commas"\r\n');
  });

  it('accepts an iterable rows source (generator)', () => {
    function* gen(): Generator<readonly (string | number)[]> {
      yield ['ord_1', 100];
      yield ['ord_2', 200];
    }
    const csv = buildCsv({ header: ['id', 'cents'], rows: gen() });
    expect(csv).toBe('id,cents\r\nord_1,100\r\nord_2,200\r\n');
  });
});
