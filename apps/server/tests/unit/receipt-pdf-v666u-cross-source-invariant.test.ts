// W977 — V-666.U receipt-pdf cross-source invariant. Three-hundred-
// third in the drift-guard series. Pins the apps/server/src/lib/
// receipt-pdf.ts hand-rolled PDF 1.4 builder:
//
//   V-666.U anchor — 'V-666.U — receipt PDF builder'.
//
//   Hand-rolled-no-dep framing — 'Hand-rolled minimal PDF 1.4
//   generator: header + 4 objects (catalog, pages, page, font), a
//   single content stream with the receipt text, and a cross-
//   reference table. The output is a single self-contained PDF byte-
//   buffer with no external dependencies — keeps the server image
//   lean (no pdfkit / puppeteer-headless)'.
//
//   Receipt-mirror framing — 'The receipt body mirrors the plain-
//   text receipt served at /v1/billing/crypto-orders/:id/receipt.txt
//   (V-666.P), so the two formats stay in sync'.
//
//   ReceiptPdfInput shape — 9 fields: order_id + issued_at + status
//     + product + price_cents + price_currency + payment_id (string |
//     null) + paid_at (string | null) + created_at.
//
//   Bare-formatting framing — 'this is a server-generated artefact
//   for archiving + emailing, not a designed invoice'.
//
//   PDF page params — A4 (595×842 pt) + 11pt Helvetica + 14pt line
//     height + startY 800 (~10pt below top).
//
//   5 PDF objects in order:
//     - 1: /Catalog /Pages 2 0 R.
//     - 2: /Pages /Kids [3 0 R] /Count 1.
//     - 3: /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources
//          /Font /F1 4 0 R /Contents 5 0 R.
//     - 4: /Font /Type1 /Helvetica.
//     - 5: stream with text-ops (BT + /F1 11 Tf + Td + Tj per line +
//          ET).
//
//   PDF header line '%PDF-1.4\n%\xff\xff\xff\xff\n' — the 0xFF
//     binary-comment marker tells viewers the file contains binary
//     data.
//
//   xref + trailer:
//     - xref starts with 'xref' + '0 N' + initial '0000000000 65535
//       f' free-list entry + per-object '%010d 00000 n ' lines.
//     - trailer ends with '<< /Size N /Root 1 0 R >>' + 'startxref' +
//       xref offset + '%%EOF'.
//
//   escapePdfString PDF §7.3.4.2 5-char escape ladder — \\\\ + \\( +
//     \\) + \\r + \\n.
//
//   8-line receipt body — 'Driftstack receipt' + blank +
//     Order: + Issued: + Status: + Product: + Amount: <price 2-dec>
//     <currency> + optionally Paid at: + optionally Payment id: +
//     Created:.
//
// stays in lockstep across apps/server/src/lib/receipt-pdf.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReceiptPdfBytes, escapePdfString } from '../../src/lib/receipt-pdf.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W977 V-666.U receipt-pdf cross-source invariant', () => {
  // ─── V-666.U anchor ──────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/receipt-pdf.ts header pins V-666.U anchor — 'V-666.U — receipt PDF builder'. The V-666.U anchor is the policy provenance for the hand-rolled receipt-PDF builder.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/V-666\.U — receipt PDF builder\./);
  });

  // ─── Hand-rolled-no-dep framing ──────────────────────────────

  it("CRITICAL hand-rolled-no-dep framing — 'Hand-rolled minimal PDF 1.4 generator: header + 4 objects (catalog, pages, page, font), a single content stream with the receipt text, and a cross-reference table. The output is a single self-contained PDF byte-buffer with no external dependencies — keeps the server image lean (no pdfkit / puppeteer-headless)'. The no-pdfkit + no-puppeteer-headless image-lean design is the V-666.U dep-policy contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/Hand-rolled minimal PDF 1\.4 generator: header \+ 4 objects \(catalog,/);
    expect(p).toMatch(/pages, page, font\), a single content stream with the receipt text,/);
    expect(p).toMatch(/and a cross-reference table\. The output is a single self-contained/);
    expect(p).toMatch(/PDF byte-buffer with no external dependencies — keeps the server/);
    expect(p).toMatch(/image lean \(no pdfkit \/ puppeteer-headless\)\./);
  });

  // ─── Receipt-mirror V-666.P framing ──────────────────────────

  it("CRITICAL receipt-mirror framing — 'The receipt body mirrors the plain-text receipt served at /v1/billing/crypto-orders/:id/receipt.txt (V-666.P), so the two formats stay in sync'. The V-666.U + V-666.P cross-format-sync design is the receipt-consistency contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/The receipt body mirrors the plain-text receipt served at/);
    expect(p).toMatch(/`\/v1\/billing\/crypto-orders\/:id\/receipt\.txt` \(V-666\.P\), so the two/);
    expect(p).toMatch(/formats stay in sync\./);
  });

  // ─── ReceiptPdfInput 9-field shape ───────────────────────────

  it('CRITICAL ReceiptPdfInput has 9 fields — order_id + issued_at + status + product + price_cents + price_currency + payment_id (string | null) + paid_at (string | null) + created_at. The 9-field shape mirrors the V-666.P receipt-row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/export interface ReceiptPdfInput \{/);
    expect(p).toMatch(/order_id: string;/);
    expect(p).toMatch(/issued_at: string;/);
    expect(p).toMatch(/status: string;/);
    expect(p).toMatch(/product: string;/);
    expect(p).toMatch(/price_cents: number;/);
    expect(p).toMatch(/price_currency: string;/);
    expect(p).toMatch(/payment_id: string \| null;/);
    expect(p).toMatch(/paid_at: string \| null;/);
    expect(p).toMatch(/created_at: string;/);
  });

  // ─── Bare-formatting framing ─────────────────────────────────

  it("CRITICAL bare-formatting framing — 'the visual formatting is intentionally bare: this is a server-generated artefact for archiving + emailing, not a designed invoice'. The bare-not-designed design is the V-666.U minimal-output rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/the visual/);
    expect(p).toMatch(/formatting is intentionally bare: this is a server-generated/);
    expect(p).toMatch(/artefact for archiving \+ emailing, not a designed invoice\./);
  });

  // ─── PDF page params ─────────────────────────────────────────

  it('CRITICAL PDF page params — startY 800 + 14pt line spacing + 11pt /F1 Helvetica + 72pt left margin. The 72/800/14/11 quad is the V-666.U visual layout.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/const startY = 800;/);
    expect(p).toMatch(/const lineHeight = 14;/);
    expect(p).toMatch(/'\/F1 11 Tf',/);
    expect(p).toMatch(/`72 \$\{startY\.toString\(\)\} Td`/);
  });

  it("CRITICAL Y-axis bottom-up framing — '72pt margin top, 14pt line spacing. PDF y-axis starts at the bottom-left'. The bottom-left-origin note prevents the future-self mistake of inverting Y.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/72pt margin top,/);
    expect(p).toMatch(/14pt line spacing\. PDF y-axis starts at the bottom-left\./);
  });

  // ─── 5 PDF objects ───────────────────────────────────────────

  it('CRITICAL object 1 = /Catalog /Pages 2 0 R. The Catalog→Pages reference is the document-root indirection.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/'1 0 obj\\n<< \/Type \/Catalog \/Pages 2 0 R >>\\nendobj\\n',/);
  });

  it('CRITICAL object 2 = /Pages /Kids [3 0 R] /Count 1. Single-page Kids array.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/'2 0 obj\\n<< \/Type \/Pages \/Kids \[3 0 R\] \/Count 1 >>\\nendobj\\n',/);
  });

  it('CRITICAL object 3 = /Page /Parent 2 0 R + /MediaBox [0 0 595 842] (A4 in pt) + /Font /F1 4 0 R + /Contents 5 0 R. The A4 dimensions + Font + Contents references make the page renderable.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/\/MediaBox \[0 0 595 842\]/);
    expect(p).toMatch(/\/Resources << \/Font << \/F1 4 0 R >> >>/);
    expect(p).toMatch(/\/Contents 5 0 R/);
  });

  it('CRITICAL object 4 = /Font /Type1 /Helvetica. The PDF-builtin Helvetica avoids needing to embed a font program.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(
      /'4 0 obj\\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica >>\\nendobj\\n',/,
    );
  });

  it('CRITICAL object 5 = content stream with /Length + BT/Tf/Td/Tj/ET text ops. The 5-op text-stream renders one Tj per line with -lineHeight Td gaps.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(
      /`5 0 obj\\n<< \/Length \$\{Buffer\.byteLength\(stream, 'binary'\)\.toString\(\)\} >>/,
    );
    expect(p).toMatch(/\\nstream\\n\$\{stream\}\\nendstream\\nendobj\\n`,/);
    expect(p).toMatch(
      /const textOps: string\[\] = \['BT', '\/F1 11 Tf', `72 \$\{startY\.toString\(\)\} Td`\];/,
    );
    expect(p).toMatch(/textOps\.push\('ET'\);/);
    expect(p).toMatch(/textOps\.push\(`\(\$\{line\}\) Tj`\);/);
  });

  // ─── PDF header binary-marker ────────────────────────────────

  it("CRITICAL PDF header line — '%PDF-1.4\\n%\\xff\\xff\\xff\\xff\\n'. The 0xFF binary-comment marker is the PDF spec recommended way to signal the file contains binary content.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/const header = '%PDF-1\.4\\n%\\xff\\xff\\xff\\xff\\n';/);
  });

  // ─── xref + trailer ──────────────────────────────────────────

  it("CRITICAL xref table — 'xref' + '0 N' size-line + '0000000000 65535 f ' initial free-list + per-object '%010d 00000 n ' offset lines. The 10-digit-zero-padded offset is the PDF spec fixed format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/const xrefLines: string\[\] = \[/);
    expect(p).toMatch(/'xref',/);
    expect(p).toMatch(/`0 \$\{\(objects\.length \+ 1\)\.toString\(\)\}`,/);
    expect(p).toMatch(/'0000000000 65535 f ',/);
    expect(p).toMatch(
      /xrefLines\.push\(`\$\{off\.toString\(\)\.padStart\(10, '0'\)\} 00000 n `\);/,
    );
  });

  it("CRITICAL trailer — '<< /Size N /Root 1 0 R >>' + 'startxref' + xref offset + '%%EOF'. The 4-element trailer is the PDF-spec file-terminator.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(
      /const trailer = `trailer\\n<< \/Size \$\{\(objects\.length \+ 1\)\.toString\(\)\} \/Root 1 0 R >>\\nstartxref\\n\$\{xrefOffset\.toString\(\)\}\\n%%EOF\\n`;/,
    );
  });

  // ─── escapePdfString 5-char ladder ───────────────────────────

  it("CRITICAL escapePdfString PDF §7.3.4.2 framing — 'PDF spec §7.3.4.2: backslash, paren-open, paren-close, and non-ASCII control chars need escaping'. The 5-char escape contract is the PDF literal-string safety.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/PDF spec §7\.3\.4\.2: backslash, paren-open, paren-close,/);
    expect(p).toMatch(/and non-ASCII control chars need escaping\./);
  });

  it("CRITICAL escapePdfString 5-step replace chain — '\\\\' (must come first) + '(' + ')' + '\\r' + '\\n'. The order matters: replacing backslash first prevents double-escape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts'));
    expect(p).toMatch(/export function escapePdfString\(input: string\): string \{/);
    expect(p).toMatch(/\.replace\(\/\\\\\/g, '\\\\\\\\'\)/);
    expect(p).toMatch(/\.replace\(\/\\\(\/g, '\\\\\('\)/);
    expect(p).toMatch(/\.replace\(\/\\\)\/g, '\\\\\)'\)/);
    expect(p).toMatch(/\.replace\(\/\\r\/g, '\\\\r'\)/);
    expect(p).toMatch(/\.replace\(\/\\n\/g, '\\\\n'\);/);
  });

  // ─── Runtime escapePdfString ─────────────────────────────────

  it("CRITICAL runtime — escapePdfString backslash → '\\\\\\\\'.", () => {
    expect(escapePdfString('a\\b')).toBe('a\\\\b');
  });

  it("CRITICAL runtime — escapePdfString paren-open → '\\\\(' + paren-close → '\\\\)'.", () => {
    expect(escapePdfString('(hi)')).toBe('\\(hi\\)');
  });

  it("CRITICAL runtime — escapePdfString \\r → '\\\\r' + \\n → '\\\\n'.", () => {
    expect(escapePdfString('a\nb\rc')).toBe('a\\nb\\rc');
  });

  it("CRITICAL runtime — escapePdfString order — backslash before paren — escapePdfString('\\\\(') → '\\\\\\\\\\\\(' (double-escaped backslash + escaped paren).", () => {
    expect(escapePdfString('\\(')).toBe('\\\\\\(');
  });

  // ─── Runtime buildReceiptPdfBytes ────────────────────────────

  it('CRITICAL runtime buildReceiptPdfBytes returns a Buffer starting with %PDF-1.4 header + ending with %%EOF.', () => {
    const buf = buildReceiptPdfBytes({
      order_id: 'ord_1',
      issued_at: '2026-05-15T10:00:00Z',
      status: 'paid',
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'EUR',
      payment_id: 'pay_1',
      paid_at: '2026-05-15T10:01:00Z',
      created_at: '2026-05-15T09:59:00Z',
    });
    expect(buf).toBeInstanceOf(Buffer);
    const head = buf.subarray(0, 8).toString('binary');
    expect(head).toBe('%PDF-1.4');
    const tail = buf.subarray(buf.length - 6, buf.length).toString('binary');
    expect(tail).toBe('%%EOF\n');
  });

  it("CRITICAL runtime — buildReceiptPdfBytes embeds the receipt 'Amount: 2.99 EUR' (cents → 2-dec dollars). The /100 + toFixed(2) is what makes 299 → '2.99'.", () => {
    const buf = buildReceiptPdfBytes({
      order_id: 'ord_X',
      issued_at: 'i',
      status: 's',
      product: 'p',
      price_cents: 299,
      price_currency: 'EUR',
      payment_id: null,
      paid_at: null,
      created_at: 'c',
    });
    expect(buf.toString('binary')).toContain('Amount: 2.99 EUR');
  });

  it('CRITICAL runtime — buildReceiptPdfBytes omits Paid at + Payment id lines when null. The null-guard prevents leaking pending/cancelled order body lines.', () => {
    const buf = buildReceiptPdfBytes({
      order_id: 'ord_Y',
      issued_at: 'i',
      status: 'pending',
      product: 'p',
      price_cents: 1000,
      price_currency: 'EUR',
      payment_id: null,
      paid_at: null,
      created_at: 'c',
    });
    const text = buf.toString('binary');
    expect(text).not.toContain('Paid at:');
    expect(text).not.toContain('Payment id:');
  });

  it('CRITICAL runtime — buildReceiptPdfBytes includes Paid at + Payment id when both present. The 2-line conditional surface lets paid receipts carry payment-id + paid-at evidence.', () => {
    const buf = buildReceiptPdfBytes({
      order_id: 'ord_Z',
      issued_at: 'i',
      status: 'paid',
      product: 'p',
      price_cents: 1000,
      price_currency: 'EUR',
      payment_id: 'pi_123',
      paid_at: '2026-05-15T10:01:00Z',
      created_at: 'c',
    });
    const text = buf.toString('binary');
    expect(text).toContain('Paid at: 2026-05-15T10:01:00Z');
    expect(text).toContain('Payment id: pi_123');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/receipt-pdf-v666u-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
