// W480.A — drift guard for apps/gui-client/src/views/CryptoReceiptView.tsx.
// V-534.AB receipt view + V-534.BM Download PDF action +
// V-534.BN Download .txt action. Drift here either drops the
// per-format button pair (customer loses .txt fallback for
// jurisdictions/screen readers that can't render PDFs cleanly)
// or breaks the copied-flag 2s reset (Copy button stays on
// 'Copied' permanently — looks like the button is broken, user
// can't tell if subsequent clicks actually wrote to clipboard).
//
//   • V-534.AB framing pinned: 'Crypto receipt view.' +
//     'Renders a receipt for a specific order id using
//     useCryptoReceipt (V-534.AA). Includes a "Copy to
//     clipboard" button that uses formatReceiptForClipboard.'
//   • V-534.BM framing pinned: 'adds a "Download PDF" button
//     that fetches /receipt.pdf (V-666.U) as a blob + triggers
//     an anchor click. The endpoint is auth-gated, so a plain
//     link wouldn't work.'
//   • V-534.BN framing pinned: 'adds a sibling "Download .txt"
//     button for the plain-text variant (V-666.P).'
//   • ReceiptBody subcomponent: copied flag + 2_000ms reset
//     via setTimeout; clipboard silent-catch for iframes /
//     locked-down envs.
//   • 3-button row: Download PDF + Download .txt + Copy to
//     clipboard; pdf.state===downloading disables both
//     download buttons + label switches to 'Downloading…'.
//   • paid_at !== null + payment_id !== null conditional rows.
//   • 4-state early returns: orderId null → empty state /
//     loading|idle → 'Loading receipt…' / error → ErrorBanner /
//     ready → ReceiptBody.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoReceiptView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W480.A apps/gui-client/src/views/CryptoReceiptView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AB/.BM/.BN triple-framing pinned: 'V-534.AB — Crypto receipt view.' + 'V-534.BM — adds a \"Download PDF\" button that fetches /receipt.pdf (V-666.U) as a blob + triggers an anchor click. The endpoint is auth-gated, so a plain link wouldn't work.' + 'V-534.BN — adds a sibling \"Download .txt\" button for the plain-text variant (V-666.P).' + 'Renders a receipt for a specific order id using useCryptoReceipt (V-534.AA). Includes a \"Copy to clipboard\" button that uses formatReceiptForClipboard. Empty / loading / error / ready states rendered consistently with the rest of the V-534.* view family.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AB — Crypto receipt view\./);
    expect(body).toMatch(
      /\/\/ V-534\.BM — adds a "Download PDF" button that fetches\s*\n?\s*\/\/\s+\/receipt\.pdf \(V-666\.U\) as a blob \+ triggers an anchor\s*\n?\s*\/\/\s+click\. The endpoint is auth-gated, so a plain link\s*\n?\s*\/\/\s+wouldn't work\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BN — adds a sibling "Download \.txt" button for the\s*\n?\s*\/\/\s+plain-text variant \(V-666\.P\)\./,
    );
    expect(body).toMatch(
      /\/\/ Renders a receipt for a specific order id using useCryptoReceipt\s*\n?\s*\/\/ \(V-534\.AA\)\. Includes a "Copy to clipboard" button that uses\s*\n?\s*\/\/ formatReceiptForClipboard\. Empty \/ loading \/ error \/ ready states\s*\n?\s*\/\/ rendered consistently with the rest of the V-534\.\* view family\./,
    );
  });

  it("CryptoReceiptViewProps: orderId 'The order id to render. Pass null to show the empty state.' nullable + ReceiptBody internal subcomponent receives {data: CryptoReceiptData}", () => {
    expect(body).toMatch(
      /interface CryptoReceiptViewProps \{\s*\n?\s*\/\*\* The order id to render\. Pass null to show the empty state\. \*\/\s*\n?\s*orderId: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function ReceiptBody\(\{ data \}: \{ data: CryptoReceiptData \}\): JSX\.Element \{/,
    );
  });

  it('Copy-to-clipboard flow is single-flight, timer-safe, and visibly retryable', () => {
    expect(body).toMatch(
      /const \[copyState, setCopyState\] = useState<'idle' \| 'copying' \| 'copied' \| 'failed'>\('idle'\);/,
    );
    expect(body).toMatch(
      /if \(copyState === 'copying'\) return;\s*\n?\s*setCopyState\('copying'\);[\s\S]*?await navigator\.clipboard\.writeText\(formatReceiptForClipboard\(data\)\);[\s\S]*?setCopyState\('copied'\);[\s\S]*?catch \{\s*\n?\s*setCopyState\('failed'\);/,
    );
    expect(body).toMatch(/window\.setTimeout\(\(\) => setCopyState\('idle'\), 2_000\)/);
    expect(body).toMatch(/Couldn’t copy the receipt\. Check clipboard permission and try again\./);
  });

  it("3-button row: 'Download PDF' onClick=>pdf.download(order_id, 'pdf') + 'Download .txt' onClick=>pdf.download(order_id, 'txt') + 'Copy to clipboard'/'Copied' toggle; both download buttons disabled while pdf.state.kind === 'downloading' + label switches to 'Downloading…'", () => {
    expect(body).toMatch(
      /onClick=\{\(\) => void pdf\.download\(data\.order_id, 'pdf'\)\}\s*\n?\s*disabled=\{pdf\.state\.kind === 'downloading'\}/,
    );
    expect(body).toMatch(
      /onClick=\{\(\) => void pdf\.download\(data\.order_id, 'txt'\)\}\s*\n?\s*disabled=\{pdf\.state\.kind === 'downloading'\}/,
    );
    expect(body).toMatch(/\{downloadingPdf \? 'Downloading PDF…' : 'Download PDF'\}/);
    expect(body).toMatch(/\{downloadingText \? 'Downloading text…' : 'Download \.txt'\}/);
    expect(body).toMatch(/copyState === 'failed'[\s\S]*?'Retry copy'/);
  });

  it("PDF-failure surface: pdf.state.kind === 'failed' → ErrorBanner with `PDF download failed: ${pdf.state.message}` message + onDismiss=>pdf.reset() (retry-on-dismiss); dl rows: Order/Status/Product/Amount(formatCents)/paid_at conditional (formatTimestamp)/payment_id conditional/Issued", () => {
    expect(body).toMatch(
      /\{pdf\.state\.kind === 'failed' && \(\s*\n?\s*<ErrorBanner\s*\n?\s*message=\{`\$\{pdf\.state\.format === 'pdf' \? 'PDF' : 'Text receipt'\} download failed: \$\{pdf\.state\.message\}`\}/,
    );
    expect(body).toMatch(/<dd>\{formatCents\(data\.price_cents, data\.price_currency\)\}<\/dd>/);
    expect(body).toMatch(
      /\{data\.paid_at !== null && \(\s*\n?\s*<>\s*\n?\s*<dt className="text-ink-secondary">Paid at<\/dt>\s*\n?\s*<dd>\{formatTimestamp\(data\.paid_at\)\}<\/dd>\s*\n?\s*<\/>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{data\.payment_id !== null && \(\s*\n?\s*<>\s*\n?\s*<dt className="text-ink-secondary">Payment id<\/dt>\s*\n?\s*<dd className="font-mono text-xs">\{data\.payment_id\}<\/dd>\s*\n?\s*<\/>\s*\n?\s*\)\}/,
    );
  });

  it("4-state early returns at view level: orderId === null → 'Pick an order to view its receipt.' + loading|idle → 'Loading receipt…' + error → <ErrorBanner message + onDismiss={() => void refetch()}> (Dismiss retries the receipt fetch instead of dead-ending the panel) + ready → <ReceiptBody data={state.data} />", () => {
    expect(body).toMatch(
      /if \(props\.orderId === null\) \{\s*\n?\s*return \(\s*\n?\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">\s*\n?\s*Pick an order to view its receipt\.\s*\n?\s*<\/div>\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(state\.kind === 'loading' \|\| state\.kind === 'idle'\) \{\s*\n?\s*return \(\s*\n?\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">\s*\n?\s*Loading receipt…\s*\n?\s*<\/div>\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(state\.kind === 'error'\) \{\s*\n?\s*\/\/ Dismiss retries the receipt fetch instead of dead-ending the panel\.\s*\n?\s*return <ErrorBanner message=\{state\.message\} onDismiss=\{\(\) => void refetch\(\)\} \/>;\s*\n?\s*\}\s*\n?\s*return <ReceiptBody data=\{state\.data\} \/>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
