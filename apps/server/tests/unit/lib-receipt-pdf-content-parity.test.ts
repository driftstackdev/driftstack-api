// W389.B — drift guard for apps/server/src/lib/receipt-pdf.ts.
// V-666.U hand-rolled PDF 1.4 receipt builder. No pdfkit / puppeteer
// dependency — keeps the server image lean. Output mirrors the
// plain-text receipt at /v1/billing/crypto-orders/:id/receipt.txt
// (V-666.P) so the two formats stay in sync.
//
//   • PDF 1.4 framing + 4-objects+content-stream+xref structure.
//   • "No pdfkit / puppeteer-headless" lean-image rationale pinned.
//   • V-666.P sync framing.
//   • ReceiptPdfInput 9-field shape.
//   • Page geometry: 595×842 A4, 72pt margin, 14pt line spacing,
//     startY=800, Helvetica 11pt.
//   • Header "%PDF-1.4\n%\xff\xff\xff\xff\n" (4 high-bit bytes hinting
//     binary file to readers).
//   • escapePdfString: PDF spec §7.3.4.2 — escapes \ ( ) \r \n.
//   • Object 1 = Catalog → 2; obj 2 = Pages → [3]; obj 3 = Page
//     (A4 MediaBox + F1→4); obj 4 = Helvetica Type1 font; obj 5 =
//     content stream.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/receipt-pdf.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W389.B apps/server/src/lib/receipt-pdf.ts content parity', () => {
  const body = read(LIB);

  it('V-666.U framing + hand-rolled PDF 1.4 rationale pinned', () => {
    expect(body).toMatch(/V-666\.U — receipt PDF builder\./);
    expect(body).toMatch(
      /Hand-rolled minimal PDF 1\.4 generator: header \+ 4 objects \(catalog,\s*\/\/\s*pages, page, font\), a single content stream with the receipt text,\s*\/\/\s*and a cross-reference table/,
    );
  });

  it('"no pdfkit / puppeteer-headless" lean-image rationale pinned', () => {
    expect(body).toMatch(
      /keeps the server\s*\/\/\s*image lean \(no pdfkit \/ puppeteer-headless\)/,
    );
  });

  it('V-666.P text-receipt sync framing pinned', () => {
    expect(body).toMatch(
      /The receipt body mirrors the plain-text receipt served at\s*\/\/\s*`\/v1\/billing\/crypto-orders\/:id\/receipt\.txt` \(V-666\.P\), so the two\s*\/\/\s*formats stay in sync/,
    );
  });

  it('ReceiptPdfInput: 9-field interface (order_id / issued_at / status / product / price_cents / price_currency / payment_id / paid_at / created_at)', () => {
    expect(body).toMatch(/export interface ReceiptPdfInput \{/);
    expect(body).toMatch(/order_id: string;/);
    expect(body).toMatch(/issued_at: string;/);
    expect(body).toMatch(/status: string;/);
    expect(body).toMatch(/product: string;/);
    expect(body).toMatch(/price_cents: number;/);
    expect(body).toMatch(/price_currency: string;/);
    expect(body).toMatch(/payment_id: string \| null;/);
    expect(body).toMatch(/paid_at: string \| null;/);
    expect(body).toMatch(/created_at: string;/);
  });

  it('buildReceiptPdfBytes: returns Buffer (single-page A4)', () => {
    expect(body).toMatch(
      /Build a single-page A4 PDF containing the receipt\. Returns the\s*\*\s*complete byte stream ready to write to a response/,
    );
    expect(body).toMatch(
      /export function buildReceiptPdfBytes\(receipt: ReceiptPdfInput\): Buffer/,
    );
  });

  it('receipt body lines: "Driftstack receipt" header + Order / Issued / Status / Product / Amount', () => {
    expect(body).toMatch(/'Driftstack receipt',/);
    expect(body).toMatch(/`Order: \$\{receipt\.order_id\}`,/);
    expect(body).toMatch(/`Issued: \$\{receipt\.issued_at\}`,/);
    expect(body).toMatch(/`Status: \$\{receipt\.status\}`,/);
    expect(body).toMatch(/`Product: \$\{receipt\.product\}`,/);
    expect(body).toMatch(
      /`Amount: \$\{\(receipt\.price_cents \/ 100\)\.toFixed\(2\)\} \$\{receipt\.price_currency\}`,/,
    );
  });

  it('conditional lines: paid_at / payment_id only pushed when non-null', () => {
    expect(body).toMatch(
      /if \(receipt\.paid_at !== null\) lines\.push\(`Paid at: \$\{receipt\.paid_at\}`\);/,
    );
    expect(body).toMatch(
      /if \(receipt\.payment_id !== null\) lines\.push\(`Payment id: \$\{receipt\.payment_id\}`\);/,
    );
    expect(body).toMatch(/lines\.push\(`Created: \$\{receipt\.created_at\}`\);/);
  });

  it('page geometry: startY=800, lineHeight=14, A4 MediaBox 595×842, Helvetica 11pt', () => {
    expect(body).toMatch(/const startY = 800; \/\/ ~10pt below top of 842pt-tall A4 page/);
    expect(body).toMatch(/const lineHeight = 14;/);
    expect(body).toMatch(/'\/F1 11 Tf',/);
    expect(body).toMatch(/`72 \$\{startY\.toString\(\)\} Td`/);
    expect(body).toMatch(/MediaBox \[0 0 595 842\]/);
  });

  it('text-stream operators: BT … ET wrapping, 0 -14 Td between lines, (line) Tj', () => {
    expect(body).toMatch(
      /const textOps: string\[\] = \['BT', '\/F1 11 Tf', `72 \$\{startY\.toString\(\)\} Td`\];/,
    );
    expect(body).toMatch(/if \(idx > 0\) textOps\.push\(`0 -\$\{lineHeight\.toString\(\)\} Td`\);/);
    expect(body).toMatch(/textOps\.push\(`\(\$\{line\}\) Tj`\);/);
    expect(body).toMatch(/textOps\.push\('ET'\);/);
  });

  it('4 + content-stream PDF objects: Catalog→Pages→Page→Font + Contents', () => {
    expect(body).toMatch(/'1 0 obj\\n<< \/Type \/Catalog \/Pages 2 0 R >>\\nendobj\\n',/);
    expect(body).toMatch(
      /'2 0 obj\\n<< \/Type \/Pages \/Kids \[3 0 R\] \/Count 1 >>\\nendobj\\n',/,
    );
    expect(body).toMatch(
      /3 0 obj\\n<< \/Type \/Page \/Parent 2 0 R \/MediaBox \[0 0 595 842\] \/Resources << \/Font << \/F1 4 0 R >> >> \/Contents 5 0 R >>\\nendobj\\n/,
    );
    expect(body).toMatch(
      /'4 0 obj\\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica >>\\nendobj\\n',/,
    );
    expect(body).toMatch(
      /5 0 obj\\n<< \/Length \$\{Buffer\.byteLength\(stream, 'binary'\)\.toString\(\)\} >>\\nstream\\n\$\{stream\}\\nendstream\\nendobj\\n/,
    );
  });

  it('PDF header: %PDF-1.4 + 4-byte 0xff binary-file hint', () => {
    expect(body).toMatch(/const header = '%PDF-1\.4\\n%\\xff\\xff\\xff\\xff\\n';/);
  });

  it('xref table: starts at "xref" line, "0 <N+1>", "0000000000 65535 f " free-entry, 10-digit zero-padded offsets', () => {
    expect(body).toMatch(/const xrefOffset = cursor;/);
    expect(body).toMatch(/'xref',/);
    expect(body).toMatch(/`0 \$\{\(objects\.length \+ 1\)\.toString\(\)\}`,/);
    expect(body).toMatch(/'0000000000 65535 f ',/);
    expect(body).toMatch(
      /xrefLines\.push\(`\$\{off\.toString\(\)\.padStart\(10, '0'\)\} 00000 n `\);/,
    );
  });

  it('trailer: /Size + /Root 1 0 R + startxref + %%EOF', () => {
    expect(body).toMatch(
      /const trailer = `trailer\\n<< \/Size \$\{\(objects\.length \+ 1\)\.toString\(\)\} \/Root 1 0 R >>\\nstartxref\\n\$\{xrefOffset\.toString\(\)\}\\n%%EOF\\n`;/,
    );
  });

  it('return Buffer.concat(parts) — single self-contained byte stream', () => {
    expect(body).toMatch(/return Buffer\.concat\(parts\);/);
  });

  it('escapePdfString: PDF spec §7.3.4.2 — escapes \\\\ + ( + ) + \\r + \\n', () => {
    expect(body).toMatch(
      /Escape a string for safe inclusion inside a PDF literal string\s*\*\s*`\(\.\.\.\)`\. PDF spec §7\.3\.4\.2: backslash, paren-open, paren-close,\s*\*\s*and non-ASCII control chars need escaping/,
    );
    expect(body).toMatch(/export function escapePdfString\(input: string\): string \{/);
    // Use substring matches: nested regex-literal escapes for backslashes
    // are hard to write without bugs. The actual source chains 5 .replace
    // calls in the exact order \\ → \( → \) → \r → \n.
    expect(body).toContain(".replace(/\\\\/g, '\\\\\\\\')");
    expect(body).toContain(".replace(/\\(/g, '\\\\(')");
    expect(body).toContain(".replace(/\\)/g, '\\\\)')");
    expect(body).toContain(".replace(/\\r/g, '\\\\r')");
    expect(body).toContain(".replace(/\\n/g, '\\\\n');");
  });

  it('imports: Buffer from node:buffer (no external deps)', () => {
    expect(body).toMatch(/import \{ Buffer \} from 'node:buffer';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
