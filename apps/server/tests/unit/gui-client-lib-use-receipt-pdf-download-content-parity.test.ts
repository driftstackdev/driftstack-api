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
//   • Download flow: trailing-slash strip + encodeURIComponent +
//     accept FORMAT_ACCEPT[format] + blob + objectUrl + synthesized
//     anchor click + revokeObjectURL + setState idle.
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

  it("download signature: format default 'pdf'; no-apiKey → failed{message:'No API key configured.'}; setState downloading; URL with encodeURIComponent(orderId) + .${format} suffix + accept: FORMAT_ACCEPT[format] (per-format Accept header)", () => {
    expect(body).toMatch(
      /async \(orderId: string, format: ReceiptDownloadFormat = 'pdf'\): Promise<void> => \{\s*\n?\s*if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'failed', format, message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*setState\(\{ kind: 'downloading', format \}\);/,
    );
    expect(body).toMatch(
      /const res = await fetch\(\s*\n?\s*`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt\.\$\{format\}`,\s*\n?\s*\{\s*\n?\s*method: 'GET',\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: FORMAT_ACCEPT\[format\],\s*\n?\s*\},\s*\n?\s*\},\s*\n?\s*\);/,
    );
  });

  it('Blob-download flow: !res.ok → failed{message: readApiErrorMessage}; res.ok → blob() + URL.createObjectURL + synthesized anchor with download attribute `receipt-${orderId}.${format}` + click + remove + URL.revokeObjectURL + setState idle; catch → failed{message: instance-of-Error fallback}', () => {
    expect(body).toMatch(
      /const blob = await res\.blob\(\);\s*\n?\s*const objectUrl = URL\.createObjectURL\(blob\);\s*\n?\s*const a = document\.createElement\('a'\);\s*\n?\s*a\.href = objectUrl;\s*\n?\s*a\.download = `receipt-\$\{orderId\}\.\$\{format\}`;\s*\n?\s*a\.style\.display = 'none';\s*\n?\s*document\.body\.appendChild\(a\);\s*\n?\s*a\.click\(\);\s*\n?\s*document\.body\.removeChild\(a\);\s*\n?\s*URL\.revokeObjectURL\(objectUrl\);\s*\n?\s*setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /\} catch \(err\) \{\s*\n?\s*setState\(\{\s*\n?\s*kind: 'failed',\s*\n?\s*format,\s*\n?\s*message: err instanceof Error \? err\.message : String\(err\),\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('reset useCallback empty deps + return { state, download, reset }; download useCallback deps [settings.apiKey, settings.baseUrl]', () => {
    expect(body).toMatch(/\[settings\.apiKey, settings\.baseUrl\],\s*\n?\s*\);/);
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{\s*\n?\s*setState\(\{ kind: 'idle' \}\);\s*\n?\s*\}, \[\]\);\s*\n?\s*return \{ state, download, reset \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
