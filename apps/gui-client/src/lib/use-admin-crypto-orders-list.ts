// V-534.AG — useAdminCryptoOrdersList hook.
//
// Wraps GET /v1/admin/crypto-orders (V-666.D + V-666.T). Admin-only
// surface — caller must have an API key with the
// `driftstack_internal_admin` scope; non-admin keys get a 403 which
// surfaces as an error state. Supports the V-666.T status + search
// filters via opts; refetch picks up the latest opts.

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';
import type { CryptoOrderData } from './use-crypto-order';

export interface AdminCryptoOrder extends CryptoOrderData {
  account_id: string | null;
}

export interface AdminCryptoOrdersListData {
  orders: AdminCryptoOrder[];
}

export type AdminCryptoOrdersListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminCryptoOrdersListData }
  | { kind: 'error'; message: string };

export interface UseAdminCryptoOrdersListOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
  /** Page size override; server caps at 200. */
  limit?: number;
  /** Filter to one status (V-666.T). */
  status?: AdminCryptoOrder['status'] | 'cancelled' | null;
  /** Free-text search across order_id / product / customer_note (V-666.T). */
  search?: string | null;
  /** Filter to a specific account_id. */
  accountId?: string | null;
}

export interface UseAdminCryptoOrdersListResult {
  state: AdminCryptoOrdersListState;
  refetch: () => Promise<void>;
}

export function useAdminCryptoOrdersList(
  opts: UseAdminCryptoOrdersListOpts = {},
): UseAdminCryptoOrdersListResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminCryptoOrdersListState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );

  const limit = opts.limit;
  const status = opts.status ?? null;
  const search = opts.search ?? null;
  const accountId = opts.accountId ?? null;

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const url = new URL(`${baseUrl}/v1/admin/crypto-orders`);
      if (limit !== undefined) url.searchParams.set('limit', limit.toString());
      if (status !== null) url.searchParams.set('status', status);
      if (search !== null && search.trim().length > 0) {
        url.searchParams.set('search', search.trim());
      }
      if (accountId !== null && accountId.trim().length > 0) {
        url.searchParams.set('account_id', accountId.trim());
      }
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        setState({ kind: 'error', message: `HTTP ${res.status.toString()}` });
        return;
      }
      const body = (await res.json()) as AdminCryptoOrdersListData;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, limit, status, search, accountId]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
