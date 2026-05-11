// V-666.U — receipt PDF builder.
//
// Hand-rolled minimal PDF 1.4 generator: header + 4 objects (catalog,
// pages, page, font), a single content stream with the receipt text,
// and a cross-reference table. The output is a single self-contained
// PDF byte-buffer with no external dependencies — keeps the server
// image lean (no pdfkit / puppeteer-headless).
//
// The receipt body mirrors the plain-text receipt served at
// `/v1/billing/crypto-orders/:id/receipt.txt` (V-666.P), so the two
// formats stay in sync.

import { Buffer } from 'node:buffer';

export interface ReceiptPdfInput {
  order_id: string;
  issued_at: string;
  status: string;
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  paid_at: string | null;
  created_at: string;
}

/**
 * Build a single-page A4 PDF containing the receipt. Returns the
 * complete byte stream ready to write to a response.
 *
 * The page contains the same lines as the text receipt — the visual
 * formatting is intentionally bare: this is a server-generated
 * artefact for archiving + emailing, not a designed invoice.
 */
export function buildReceiptPdfBytes(receipt: ReceiptPdfInput): Buffer {
  const lines: string[] = [
    'Driftstack receipt',
    '',
    `Order: ${receipt.order_id}`,
    `Issued: ${receipt.issued_at}`,
    `Status: ${receipt.status}`,
    `Product: ${receipt.product}`,
    `Amount: ${(receipt.price_cents / 100).toFixed(2)} ${receipt.price_currency}`,
  ];
  if (receipt.paid_at !== null) lines.push(`Paid at: ${receipt.paid_at}`);
  if (receipt.payment_id !== null) lines.push(`Payment id: ${receipt.payment_id}`);
  lines.push(`Created: ${receipt.created_at}`);

  // PDF text-stream: place each line down the page. 72pt margin top,
  // 14pt line spacing. PDF y-axis starts at the bottom-left.
  const startY = 800; // ~10pt below top of 842pt-tall A4 page
  const lineHeight = 14;
  const escaped = lines.map(escapePdfString);
  const textOps: string[] = ['BT', '/F1 11 Tf', `72 ${startY.toString()} Td`];
  escaped.forEach((line, idx) => {
    if (idx > 0) textOps.push(`0 -${lineHeight.toString()} Td`);
    textOps.push(`(${line}) Tj`);
  });
  textOps.push('ET');
  const stream = textOps.join('\n');

  // PDF objects. Build them as strings, then convert to bytes + track
  // offsets for the xref table.
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'binary').toString()} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  // Assemble: header + objects, capturing byte offsets for xref.
  const header = '%PDF-1.4\n%\xff\xff\xff\xff\n';
  const parts: Buffer[] = [Buffer.from(header, 'binary')];
  const offsets: number[] = [];
  let cursor = parts[0]!.byteLength;
  for (const obj of objects) {
    offsets.push(cursor);
    const buf = Buffer.from(obj, 'binary');
    parts.push(buf);
    cursor += buf.byteLength;
  }

  const xrefOffset = cursor;
  const xrefLines: string[] = [
    'xref',
    `0 ${(objects.length + 1).toString()}`,
    '0000000000 65535 f ',
  ];
  for (const off of offsets) {
    xrefLines.push(`${off.toString().padStart(10, '0')} 00000 n `);
  }
  const xref = xrefLines.join('\n') + '\n';
  parts.push(Buffer.from(xref, 'binary'));

  const trailer = `trailer\n<< /Size ${(objects.length + 1).toString()} /Root 1 0 R >>\nstartxref\n${xrefOffset.toString()}\n%%EOF\n`;
  parts.push(Buffer.from(trailer, 'binary'));

  return Buffer.concat(parts);
}

/**
 * Escape a string for safe inclusion inside a PDF literal string
 * `(...)`. PDF spec §7.3.4.2: backslash, paren-open, paren-close,
 * and non-ASCII control chars need escaping.
 */
export function escapePdfString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}
