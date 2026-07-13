// V-534.AX — admin CSV export hook.
//
// Wraps GET /v1/admin/crypto-orders.csv (V-666.AC). The endpoint requires
// `Authorization: Bearer` so a plain anchor link won't work. The bounded
// response is saved through the shared Tauri filesystem/browser fallback,
// which avoids WKWebView's silently swallowed synthesized downloads.
//
// State machine: idle | downloading | failed. Successful downloads
// snap back to idle so the button is immediately usable again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { downloadBlob, readBoundedDownloadBlob } from './download';
import { fetchWithDeadline } from './fetch-with-deadline';
import { useSettings } from './SettingsContext';
import type { AdminCryptoOrder } from './use-admin-crypto-orders-list';

export type AdminCsvExportState =
  | { kind: 'idle' }
  | { kind: 'downloading' }
  | { kind: 'failed'; message: string };

export interface UseAdminCsvExportOpts {
  status?: AdminCryptoOrder['status'] | 'cancelled' | null;
  search?: string | null;
  accountId?: string | null;
  /** V-666.BY — ISO 8601 lower bound (inclusive). */
  createdAfter?: string | null;
  /** V-666.BY — ISO 8601 upper bound (exclusive). */
  createdBefore?: string | null;
}

export interface UseAdminCsvExportResult {
  state: AdminCsvExportState;
  download: () => Promise<void>;
  reset: () => void;
}

export function useAdminCsvExport(opts: UseAdminCsvExportOpts = {}): UseAdminCsvExportResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminCsvExportState>({ kind: 'idle' });
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const status = opts.status ?? null;
  const search = opts.search ?? null;
  const accountId = opts.accountId ?? null;
  const createdAfter = opts.createdAfter ?? null;
  const createdBefore = opts.createdBefore ?? null;

  const download = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    if (!settings.apiKey) {
      setState({ kind: 'failed', message: 'No API key configured.' });
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const baseUrl = settings.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/v1/admin/crypto-orders.csv`);
    if (status !== null) url.searchParams.set('status', status);
    if (search !== null && search.trim().length > 0) {
      url.searchParams.set('search', search.trim());
    }
    if (accountId !== null && accountId.trim().length > 0) {
      url.searchParams.set('account_id', accountId.trim());
    }
    if (createdAfter !== null && createdAfter.trim().length > 0) {
      url.searchParams.set('created_after', createdAfter.trim());
    }
    if (createdBefore !== null && createdBefore.trim().length > 0) {
      url.searchParams.set('created_before', createdBefore.trim());
    }

    setState({ kind: 'downloading' });
    try {
      const res = await fetchWithDeadline(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'text/csv',
        },
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) setState({ kind: 'failed', message });
        return;
      }
      const blob = await readBoundedDownloadBlob(res);
      if (sequence !== sequenceRef.current) return;
      const filename = buildFilename(new Date());
      const saved = await downloadBlob(filename, blob);
      if (sequence !== sequenceRef.current) return;
      setState(
        saved
          ? { kind: 'idle' }
          : {
              kind: 'failed',
              message: 'The CSV export could not be saved. Check Downloads access and try again.',
            },
      );
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'failed',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'CSV export timed out. Check your connection and try again.'
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        inFlightRef.current = false;
      }
    }
  }, [settings.apiKey, settings.baseUrl, status, search, accountId, createdAfter, createdBefore]);

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
    [settings.apiKey, settings.baseUrl, status, search, accountId, createdAfter, createdBefore],
  );

  return { state, download, reset };
}

function buildFilename(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `crypto-orders-${y}-${m}-${d}.csv`;
}
