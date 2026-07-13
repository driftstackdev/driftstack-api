// V-534.BM — useReceiptPdfDownload hook.
// V-534.BN — extended to also handle the plain-text variant
//            (/receipt.txt, V-666.P). Both endpoints are auth-gated,
//            so the blob-fetch + synthesized anchor click pattern is
//            required either way.
//
// Fetches /v1/billing/crypto-orders/:id/receipt.{pdf,txt} with the
// auth header attached and triggers a browser download via a
// synthesized anchor click.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
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
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const download = useCallback(
    async (orderId: string, format: ReceiptDownloadFormat = 'pdf'): Promise<void> => {
      if (inFlightRef.current) return;
      if (!settings.apiKey) {
        setState({ kind: 'failed', format, message: 'No API key configured.' });
        return;
      }
      inFlightRef.current = true;
      const sequence = ++sequenceRef.current;
      const controller = new AbortController();
      requestRef.current = controller;
      setState({ kind: 'downloading', format });
      let objectUrl: string | null = null;
      let anchor: HTMLAnchorElement | null = null;
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetchWithDeadline(
          `${baseUrl}/v1/billing/crypto-orders/${encodeURIComponent(orderId)}/receipt.${format}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${settings.apiKey}`,
              accept: FORMAT_ACCEPT[format],
            },
          },
        );
        if (!res.ok) {
          const message = await readApiErrorMessage(res);
          if (sequence === sequenceRef.current) setState({ kind: 'failed', format, message });
          return;
        }
        const blob = await res.blob();
        if (sequence !== sequenceRef.current) return;
        objectUrl = URL.createObjectURL(blob);
        anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `receipt-${orderId}.${format}`;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        if (sequence === sequenceRef.current) setState({ kind: 'idle' });
      } catch (err) {
        if (sequence === sequenceRef.current) {
          setState({
            kind: 'failed',
            format,
            message:
              err instanceof DOMException && err.name === 'AbortError'
                ? 'Receipt download timed out. Check your connection and try again.'
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
        }
      } finally {
        if (anchor?.parentNode !== null && anchor?.parentNode !== undefined) {
          anchor.parentNode.removeChild(anchor);
        }
        if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        if (requestRef.current === controller) {
          requestRef.current = null;
          inFlightRef.current = false;
        }
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback((): void => {
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    inFlightRef.current = false;
    setState({ kind: 'idle' });
  }, []);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [],
  );

  return { state, download, reset };
}
