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
//     the blob-fetch + synthesized anchor click pattern is required
//     either way.'
//   • ReceiptDownloadFormat 2-value union ('pdf'|'txt').
//   • FORMAT_ACCEPT Record: pdf → 'application/pdf' + txt → 'text/plain'.
//   • State: idle | downloading | failed{message}.
//   • UseReceiptPdfDownloadResult: download(orderId, format='pdf')
//     + reset() with same V-534.AX-style action-hook reset pattern.
//   • Download flow: single-flight + shared deadline + sequence gating,
//     trailing-slash strip + encodeURIComponent + per-format Accept,
//     blob + synthesized anchor click + unconditional resource cleanup.
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

  it("V-534.BM + V-534.BN dual-framing pinned: 'V-534.BM — useReceiptPdfDownload hook.' + 'V-534.BN — extended to also handle the plain-text variant (/receipt.txt, V-666.P). Both endpoints are auth-gated, so the blob-fetch + synthesized anchor click pattern is required either way.' + 'Fetches /v1/billing/crypto-orders/:id/receipt.{pdf,txt} with the auth header attached and triggers a browser download via a synthesized anchor click.'", () => {
    expect(body).toMatch(/\/\/ V-534\.BM — useReceiptPdfDownload hook\./);
    expect(body).toMatch(
      /\/\/ V-534\.BN — extended to also handle the plain-text variant\s*\n?\s*\/\/\s+\(\/receipt\.txt, V-666\.P\)\. Both endpoints are auth-gated,\s*\n?\s*\/\/\s+so the blob-fetch \+ synthesized anchor click pattern is\s*\n?\s*\/\/\s+required either way\./,
    );
    expect(body).toMatch(
      /\/\/ Fetches \/v1\/billing\/crypto-orders\/:id\/receipt\.\{pdf,txt\} with the\s*\n?\s*\/\/ auth header attached and triggers a browser download via a\s*\n?\s*\/\/ synthesized anchor click\./,
    );
  });

  it("ReceiptDownloadFormat 2-value union ('pdf'|'txt') + FORMAT_ACCEPT Record (pdf → 'application/pdf', txt → 'text/plain') — pinned so the .txt variant doesn't silently fall back to PDF bytes", () => {
    expect(body).toMatch(/export type ReceiptDownloadFormat = 'pdf' \| 'txt';/);
    expect(body).toMatch(
      /const FORMAT_ACCEPT: Record<ReceiptDownloadFormat, string> = \{\s*\n?\s*pdf: 'application\/pdf',\s*\n?\s*txt: 'text\/plain',\s*\n?\s*\};/,
    );
  });

  it('ReceiptPdfDownloadState retains format in active/failure variants', () => {
    expect(body).toMatch(
      /export type ReceiptPdfDownloadState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'downloading'; format: ReceiptDownloadFormat \}\s*\n?\s*\| \{ kind: 'failed'; format: ReceiptDownloadFormat; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseReceiptPdfDownloadResult \{\s*\n?\s*state: ReceiptPdfDownloadState;\s*\n?\s*download: \(orderId: string, format\?: ReceiptDownloadFormat\) => Promise<void>;\s*\n?\s*reset: \(\) => void;\s*\n?\s*\}/,
    );
  });

  it("download signature: format default 'pdf'; single-flight; no-apiKey → failed; active request gets a controller and downloading state", () => {
    expect(body).toMatch(
      /async \(orderId: string, format: ReceiptDownloadFormat = 'pdf'\): Promise<void> => \{\s*\n?\s*if \(inFlightRef\.current\) return;\s*\n?\s*if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'failed', format, message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*inFlightRef\.current = true;\s*\n?\s*const sequence = \+\+sequenceRef\.current;\s*\n?\s*const controller = new AbortController\(\);\s*\n?\s*requestRef\.current = controller;\s*\n?\s*setState\(\{ kind: 'downloading', format \}\);/,
    );
  });

  it('uses the shared deadline with abort signal, URL-safe order id, and per-format Accept header', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*\n?\s*`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt\.\$\{format\}`,\s*\n?\s*\{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: FORMAT_ACCEPT\[format\],/,
    );
  });

  it('sequence-gates response side effects and always removes the anchor and revokes its object URL', () => {
    expect(body).toMatch(
      /const blob = await res\.blob\(\);\s*\n?\s*if \(sequence !== sequenceRef\.current\) return;\s*\n?\s*objectUrl = URL\.createObjectURL\(blob\);\s*\n?\s*anchor = document\.createElement\('a'\);[\s\S]*?anchor\.download = `receipt-\$\{orderId\}\.\$\{format\}`;[\s\S]*?anchor\.click\(\);\s*\n?\s*if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /\} finally \{[\s\S]*?anchor\.parentNode\.removeChild\(anchor\);[\s\S]*?URL\.revokeObjectURL\(objectUrl\);[\s\S]*?if \(requestRef\.current === controller\) \{\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;/,
    );
  });

  it('reset and unmount abort and invalidate active work; download dependencies stay complete', () => {
    expect(body).toMatch(/\[settings\.apiKey, settings\.baseUrl\],\s*\n?\s*\);/);
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);\s*\n?\s*requestRef\.current = null;\s*\n?\s*inFlightRef\.current = false;\s*\n?\s*setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\n?\s*\(\) => \(\) => \{\s*\n?\s*sequenceRef\.current \+= 1;\s*\n?\s*requestRef\.current\?\.abort\(\);[\s\S]*?\},\s*\n?\s*\[\],\s*\n?\s*\);\s*\n?\s*return \{ state, download, reset \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
