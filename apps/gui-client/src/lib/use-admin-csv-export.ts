// V-534.AX — admin CSV export hook.
//
// Wraps GET /v1/admin/crypto-orders.csv (V-666.AC). The endpoint requires
// `Authorization: Bearer` so a plain anchor link won't work — we fetch
// the response as a blob, mint an object URL, and trigger a download
// via a synthesized anchor click. The blob URL is revoked immediately
// after the click to avoid leaking it for the rest of the session.
//
// State machine: idle | downloading | failed. Successful downloads
// snap back to idle so the button is immediately usable again.

import { useCallback, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
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

  const status = opts.status ?? null;
  const search = opts.search ?? null;
  const accountId = opts.accountId ?? null;
  const createdAfter = opts.createdAfter ?? null;
  const createdBefore = opts.createdBefore ?? null;

  const download = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'failed', message: 'No API key configured.' });
      return;
    }
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
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'text/csv',
        },
      });
      if (!res.ok) {
        setState({ kind: 'failed', message: await readApiErrorMessage(res) });
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const filename = buildFilename(new Date());
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      setState({ kind: 'idle' });
    } catch (err) {
      setState({
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, status, search, accountId, createdAfter, createdBefore]);

  const reset = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return { state, download, reset };
}

function buildFilename(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `crypto-orders-${y}-${m}-${d}.csv`;
}
