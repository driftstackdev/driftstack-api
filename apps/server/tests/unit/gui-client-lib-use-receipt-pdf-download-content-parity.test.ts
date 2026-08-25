// W472.A — drift guard for apps/gui-client/src/lib/use-receipt-pdf-download.ts.
// V-534.BM/.BN receipt download action hook. Drift here either drops
// the FORMAT_ACCEPT map for the V-534.BN .txt variant (text-format
// download returns PDF bytes because the server fall-back triggers
// without an explicit Accept header) or breaks the
// encodeURIComponent(orderId) URL safety (an orderId containing '/'
// or other path-sensitive chars breaks the URL).
//
//   • V-534.BM + V-534.BN dual-framing pinned: 'useReceiptPdfDownload
//     hook.' + 'extended to also handle the plain-text variant
//     (/receipt.txt, V-666.P). Both endpoints are auth-gated, so
//     bounded authenticated download path is required either way.'
//   • ReceiptDownloadFormat 2-value union ('pdf'|'txt').
//   • FORMAT_ACCEPT Record: pdf → 'application/pdf' + txt → 'text/plain'.
//   • State: idle | downloading | failed{message}.
//   • UseReceiptPdfDownloadResult: download(orderId, format='pdf')
//     + reset() with same V-534.AX-style action-hook reset pattern.
//   • Download flow: single-flight + shared deadline + sequence gating,
//     trailing-slash strip + encodeURIComponent + per-format Accept,
//     bounded body + shared native/browser download helper.
//   • reset/unmount abort and invalidate the active request.
//   • Filename: `receipt-${orderId}.${format}`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-receipt-pdf-download.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W472.A apps/gui-client/src/lib/use-receipt-pdf-download.ts content parity', () => {
  const body = read(LIB);

  it('V-534.BM/.BN dual framing pins auth-gated PDF/text receipts plus bounded native-capable saves', () => {
    expect(body).toMatch(/\/\/ V-534\.BM — useReceiptPdfDownload hook\./);
    expect(body).toMatch(
      /\/\/ V-534\.BN — extended to also handle the plain-text variant\s*\/\/\s+\(\/receipt\.txt, V-666\.P\)\. Both endpoints are auth-gated,\s*\/\/\s+so the blob-fetch \+ synthesized anchor click pattern is\s*\/\/\s+required either way\./,
    );
    expect(body).toMatch(
      /\/\/ Fetches \/v1\/billing\/crypto-orders\/:id\/receipt\.\{pdf,txt\} with the\s*\/\/ auth header attached, bounds the body, then uses the shared Tauri\s*\/\/ filesystem\/browser fallback so desktop downloads are real writes\./,
    );
    expect(body).toMatch(/import \{ downloadBlob, readBoundedDownloadBlob \} from '\.\/download';/);
  });

  it("ReceiptDownloadFormat 2-value union ('pdf'|'txt') + FORMAT_ACCEPT Record (pdf → 'application/pdf', txt → 'text/plain') — pinned so the .txt variant doesn't silently fall back to PDF bytes", () => {
    expect(body).toMatch(/export type ReceiptDownloadFormat = 'pdf' \| 'txt';/);
    expect(body).toMatch(
      /const FORMAT_ACCEPT: Record<ReceiptDownloadFormat, string> = \{\s*pdf: 'application\/pdf',\s*txt: 'text\/plain',\s*\};/,
    );
  });

  it('ReceiptPdfDownloadState retains format in active/failure variants', () => {
    expect(body).toMatch(
      /export type ReceiptPdfDownloadState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'downloading'; format: ReceiptDownloadFormat \}\s*\| \{ kind: 'failed'; format: ReceiptDownloadFormat; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseReceiptPdfDownloadResult \{\s*state: ReceiptPdfDownloadState;\s*download: \(orderId: string, format\?: ReceiptDownloadFormat\) => Promise<void>;\s*reset: \(\) => void;\s*\}/,
    );
  });

  it("download signature: format default 'pdf'; single-flight; no-apiKey → failed; active request gets a controller and downloading state", () => {
    expect(body).toMatch(
      /async \(orderId: string, format: ReceiptDownloadFormat = 'pdf'\): Promise<void> => \{\s*if \(inFlightRef\.current\) return;\s*if \(!settings\.apiKey\) \{\s*setState\(\{ kind: 'failed', format, message: 'No API key configured\.' \}\);\s*return;\s*\}\s*inFlightRef\.current = true;\s*const sequence = \+\+sequenceRef\.current;\s*const controller = new AbortController\(\);\s*requestRef\.current = controller;\s*setState\(\{ kind: 'downloading', format \}\);/,
    );
  });

  it('uses the shared deadline with abort signal, URL-safe order id, and per-format Accept header', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt\.\$\{format\}`,\s*\{\s*method: 'GET',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*accept: FORMAT_ACCEPT\[format\],/,
    );
  });

  it('bounds the body, sequence-gates both save phases, delegates native/browser writing, and reports refused saves', () => {
    expect(body).toMatch(
      /const blob = await readBoundedDownloadBlob\(res\);\s*if \(sequence !== sequenceRef\.current\) return;\s*const saved = await downloadBlob\(`receipt-\$\{orderId\}\.\$\{format\}`, blob\);\s*if \(sequence !== sequenceRef\.current\) return;/,
    );
    expect(body).toMatch(
      /saved\s*\? \{ kind: 'idle' \}\s*: \{\s*kind: 'failed',\s*format,\s*message: 'The receipt could not be saved\. Check Downloads access and try again\.',/,
    );
    expect(body).not.toMatch(/await res\.blob\(\)/);
    expect(body).not.toMatch(/URL\.createObjectURL/);
    expect(body).toMatch(
      /\} finally \{\s*if \(requestRef\.current === controller\) \{\s*requestRef\.current = null;\s*inFlightRef\.current = false;/,
    );
  });

  it('reset and unmount abort and invalidate active work; download dependencies stay complete', () => {
    expect(body).toMatch(/\[settings\.apiKey, settings\.baseUrl\],\s*\);/);
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);\s*requestRef\.current = null;\s*inFlightRef\.current = false;\s*setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);[\s\S]*?\},\s*\[\],\s*\);\s*return \{ state, download, reset \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
