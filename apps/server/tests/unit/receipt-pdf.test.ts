// V-666.U — unit tests for the receipt PDF builder.
//
// Surface under test:
//   - output starts with the PDF-1.4 header
//   - output ends with %%EOF
//   - output contains a single xref section + a trailer with a valid
//     startxref offset that points at the literal "xref" marker
//   - receipt text fields land inside the content stream
//   - paid_at + payment_id lines are emitted only when non-null
//   - escapePdfString handles the four special chars

import { describe, expect, it } from 'vitest';
import { buildReceiptPdfBytes, escapePdfString } from '../../src/lib/receipt-pdf.js';

const SAMPLE = {
  order_id: 'ord_42',
  issued_at: '2026-05-11T10:00:00.000Z',
  status: 'paid',
  product: 'team_growth',
  price_cents: 14900,
  price_currency: 'EUR',
  payment_id: 'np_x',
  paid_at: '2026-05-11T09:55:00.000Z',
  created_at: '2026-05-11T09:00:00.000Z',
};

describe('V-666.U buildReceiptPdfBytes — structural integrity', () => {
  it('starts with the PDF-1.4 magic header', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const head = bytes.slice(0, 8).toString('binary');
    expect(head).toBe('%PDF-1.4');
  });

  it('ends with %%EOF', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const tail = bytes.slice(bytes.length - 6).toString('binary');
    expect(tail.endsWith('%%EOF\n')).toBe(true);
  });

  it('contains exactly one "xref" marker + a trailer dictionary', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const text = bytes.toString('binary');
    const xrefMatches = text.match(/\nxref\n/g) ?? [];
    expect(xrefMatches).toHaveLength(1);
    expect(text).toContain('trailer');
    expect(text).toContain('/Root 1 0 R');
  });

  it('startxref offset points at the xref marker', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const text = bytes.toString('binary');
    const startMatch = /\nstartxref\n(\d+)\n/.exec(text);
    expect(startMatch).not.toBeNull();
    const offset = Number.parseInt(startMatch![1]!, 10);
    const window = text.slice(offset, offset + 4);
    expect(window).toBe('xref');
  });

  it('declares Catalog + Pages + Page + Font objects', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const text = bytes.toString('binary');
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page ');
    expect(text).toContain('/Type /Font');
  });
});

describe('V-666.U buildReceiptPdfBytes — content', () => {
  it('embeds the order_id, product, and formatted amount in the stream', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const text = bytes.toString('binary');
    expect(text).toContain('ord_42');
    expect(text).toContain('team_growth');
    expect(text).toContain('149.00 EUR');
  });

  it('includes paid_at + payment_id lines when present', () => {
    const bytes = buildReceiptPdfBytes(SAMPLE);
    const text = bytes.toString('binary');
    expect(text).toContain('Paid at: 2026-05-11T09:55:00.000Z');
    expect(text).toContain('Payment id: np_x');
  });

  it('omits paid_at + payment_id lines when null', () => {
    const bytes = buildReceiptPdfBytes({
      ...SAMPLE,
      status: 'pending',
      paid_at: null,
      payment_id: null,
    });
    const text = bytes.toString('binary');
    expect(text).not.toContain('Paid at:');
    expect(text).not.toContain('Payment id:');
    // The other fields still appear.
    expect(text).toContain('ord_42');
  });
});

describe('V-666.U escapePdfString', () => {
  it('escapes backslash + parentheses + CR + LF', () => {
    expect(escapePdfString('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
    expect(escapePdfString('one\ntwo')).toBe('one\\ntwo');
    expect(escapePdfString('left\rright')).toBe('left\\rright');
  });

  it('leaves ordinary ASCII alone', () => {
    expect(escapePdfString('Hello world 123 - .')).toBe('Hello world 123 - .');
  });
});
