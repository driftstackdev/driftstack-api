// W473.B — drift guard for apps/gui-client/src/lib/use-crypto-receipt.ts.
// V-534.AA useCryptoReceipt hook + formatReceiptForClipboard
// formatter. Drift here either breaks the CryptoReceiptData status
// 6-value union (a new server-side status arrives — e.g. 'partial'
// flipped to 'underpaid' — and the receipt view crashes on the
// untyped string) or breaks the formatReceiptForClipboard line
// shape (the "Paid at" + "Payment id" optional-line conditional is
// the reason an unpaid receipt copies clean rather than dumping
// "Paid at: null").
//
//   • V-534.AA framing pinned: 'useCryptoReceipt hook.' + 'Wraps
//     GET /v1/billing/crypto-orders/:id/receipt (V-666.M) for the
//     GUI receipt-view. Fetch-on-mount when an orderId is supplied;
//     idle when orderId is null. Refetch() supported for re-renders
//     after payment confirms.'
//   • CryptoReceiptData 9-field with status 6-value union (pending |
//     confirming | paid | failed | partial | cancelled).
//   • orderId === null short-circuit on initial state + fetcher
//     early-return + useEffect skip.
//   • Receipt reads are single-flight, deadline-bounded, sequence-gated,
//     dependency/unmount-aborted, and URL-encode the order id.
//   • formatReceiptForClipboard: vendor default 'Driftstack' + 7
//     base lines + paid_at !== null conditional 'Paid at' line +
//     payment_id !== null conditional 'Payment id' line + always
//     trailing 'Created:' line + join('\n') (LF only, not CRLF).
//   • Amount line formatting: (price_cents / 100).toFixed(2) +
//     space + price_currency.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-receipt.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W473.B apps/gui-client/src/lib/use-crypto-receipt.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AA framing pinned: 'V-534.AA — useCryptoReceipt hook.' + 'Wraps GET /v1/billing/crypto-orders/:id/receipt (V-666.M) for the GUI receipt-view. Fetch-on-mount when an orderId is supplied; idle when orderId is null. Refetch() supported for re-renders after payment confirms.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AA — useCryptoReceipt hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/billing\/crypto-orders\/:id\/receipt \(V-666\.M\) for the\s*\n?\s*\/\/ GUI receipt-view\. Fetch-on-mount when an orderId is supplied; idle\s*\n?\s*\/\/ when orderId is null\. Refetch\(\) supported for re-renders after\s*\n?\s*\/\/ payment confirms\./,
    );
  });

  it("CryptoReceiptData 9-field with status 6-value union ('pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled') + payment_id nullable + paid_at nullable — pinned so a new server status doesn't crash the receipt view", () => {
    expect(body).toMatch(
      /export interface CryptoReceiptData \{\s*\n?\s*order_id: string;\s*\n?\s*issued_at: string;\s*\n?\s*status: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*\n?\s*product: string;\s*\n?\s*price_cents: number;\s*\n?\s*price_currency: string;\s*\n?\s*payment_id: string \| null;\s*\n?\s*paid_at: string \| null;\s*\n?\s*created_at: string;\s*\n?\s*\}/,
    );
  });

  it('CryptoReceiptState 4-variant + UseCryptoReceiptOpts: just manual? + UseCryptoReceiptResult: state + refetch + useCryptoReceipt(orderId: string | null, opts = {})', () => {
    expect(body).toMatch(
      /export type CryptoReceiptState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: CryptoReceiptData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseCryptoReceiptOpts \{\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function useCryptoReceipt\(\s*\n?\s*orderId: string \| null,\s*\n?\s*opts: UseCryptoReceiptOpts = \{\},\s*\n?\s*\): UseCryptoReceiptResult \{/,
    );
  });

  it('orderId===null short-circuit: initial state guards on manual||orderId===null + fetcher early-return setState idle + useEffect skip', () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<CryptoReceiptState>\(\s*\n?\s*opts\.manual === true \|\| orderId === null \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /if \(orderId === null\) \{\s*\n?\s*setState\(\{ kind: 'idle' \}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*if \(orderId === null\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual, orderId\]\);/,
    );
  });

  it('single-flights reads and uses the shared deadline, abort signal, encoded order id, auth, and JSON Accept header', () => {
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*\n?\s*`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt`,\s*\n?\s*\{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',/,
    );
  });

  it('sequence-gates response state and aborts/invalidate active work on dependency change or unmount', () => {
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\n?\s*\(\) => \(\) => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;\s*\n?\s*\},\s*\n?\s*\[orderId, settings\.apiKey, settings\.baseUrl\],/,
    );
  });

  it("formatReceiptForClipboard exported pure formatter: vendor default 'Driftstack' + JSDoc framing 'multi-line plain-text receipt suitable for clipboard copy or PDF generation' + 7 base lines (vendor + blank + Order + Issued + Status + Product + Amount with (price_cents/100).toFixed(2) + price_currency)", () => {
    expect(body).toMatch(
      /\* Build a multi-line plain-text receipt suitable for clipboard copy\s*\n?\s*\*\s+or PDF generation\. Pure function; takes the receipt \+ a vendor\s*\n?\s*\*\s+label as input so the formatting decision lives next to the hook\s*\n?\s*\*\s+rather than the caller\./,
    );
    expect(body).toMatch(
      /export function formatReceiptForClipboard\(\s*\n?\s*receipt: CryptoReceiptData,\s*\n?\s*vendor = 'Driftstack',\s*\n?\s*\): string \{\s*\n?\s*const lines = \[\s*\n?\s*`\$\{vendor\} receipt`,\s*\n?\s*'',\s*\n?\s*`Order: \$\{receipt\.order_id\}`,\s*\n?\s*`Issued: \$\{receipt\.issued_at\}`,\s*\n?\s*`Status: \$\{receipt\.status\}`,\s*\n?\s*`Product: \$\{receipt\.product\}`,\s*\n?\s*`Amount: \$\{\(receipt\.price_cents \/ 100\)\.toFixed\(2\)\} \$\{receipt\.price_currency\}`,\s*\n?\s*\];/,
    );
  });

  it("formatReceiptForClipboard optional-line conditionals: paid_at !== null pushes 'Paid at' line + payment_id !== null pushes 'Payment id' line + always trailing 'Created:' line + join('\\n') (LF only, not CRLF) — pinned so an unpaid receipt copies clean rather than 'Paid at: null'", () => {
    expect(body).toMatch(
      /if \(receipt\.paid_at !== null\) lines\.push\(`Paid at: \$\{receipt\.paid_at\}`\);\s*\n?\s*if \(receipt\.payment_id !== null\) lines\.push\(`Payment id: \$\{receipt\.payment_id\}`\);\s*\n?\s*lines\.push\(`Created: \$\{receipt\.created_at\}`\);\s*\n?\s*return lines\.join\('\\n'\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
