// V-534.BM — useReceiptPdfDownload hook.
// V-534.BN — extended to also handle the plain-text variant
//            (/receipt.txt, V-666.P). Both endpoints are auth-gated,
//            so the blob-fetch + synthesized anchor click pattern is
//            required either way.
//
// Fetches /v1/billing/crypto-orders/:id/receipt.{pdf,txt} with the
// auth header attached and triggers a browser download via a
// synthesized anchor click.

import { useCallback, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';

export type ReceiptDownloadFormat = 'pdf' | 'txt';

const FORMAT_ACCEPT: Record<ReceiptDownloadFormat, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
};

export type ReceiptPdfDownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; format: ReceiptDownloadFormat }
  | { kind: 'failed'; format: ReceiptDownloadFormat; message: string };

export interface UseReceiptPdfDownloadResult {
  state: ReceiptPdfDownloadState;
  download: (orderId: string, format?: ReceiptDownloadFormat) => Promise<void>;
  reset: () => void;
}

export function useReceiptPdfDownload(): UseReceiptPdfDownloadResult {
  const { settings } = useSettings();
  const [state, setState] = useState<ReceiptPdfDownloadState>({ kind: 'idle' });

  const download = useCallback(
    async (orderId: string, format: ReceiptDownloadFormat = 'pdf'): Promise<void> => {
      if (!settings.apiKey) {
        setState({ kind: 'failed', format, message: 'No API key configured.' });
        return;
      }
      setState({ kind: 'downloading', format });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(
          `${baseUrl}/v1/billing/crypto-orders/${encodeURIComponent(orderId)}/receipt.${format}`,
          {
            method: 'GET',
            headers: {
              authorization: `Bearer ${settings.apiKey}`,
              accept: FORMAT_ACCEPT[format],
            },
          },
        );
        if (!res.ok) {
          setState({ kind: 'failed', format, message: await readApiErrorMessage(res) });
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `receipt-${orderId}.${format}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
        setState({ kind: 'idle' });
      } catch (err) {
        setState({
          kind: 'failed',
          format,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return { state, download, reset };
}
