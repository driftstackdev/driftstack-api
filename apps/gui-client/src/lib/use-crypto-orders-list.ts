// V-534.W — useCryptoOrdersList hook.
//
// Wraps GET /v1/billing/crypto-orders (V-666.G) for the GUI history
// view. Returns the caller account's own orders, newest first. Auto-
// fetches on mount; manual mode + refetch() supported.

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';
import type { CryptoOrderData } from './use-crypto-order';

export interface CryptoOrdersListData {
  orders: CryptoOrderData[];
}

export type CryptoOrdersListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: CryptoOrdersListData }
  | { kind: 'error'; message: string };

export interface UseCryptoOrdersListOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
  /** Page size override; server caps at 100. Default unset = server default (50). */
  limit?: number;
}

export interface UseCryptoOrdersListResult {
  state: CryptoOrdersListState;
  refetch: () => Promise<void>;
}

export function useCryptoOrdersList(opts: UseCryptoOrdersListOpts = {}): UseCryptoOrdersListResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoOrdersListState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const url = new URL(`${baseUrl}/v1/billing/crypto-orders`);
      if (opts.limit !== undefined) {
        url.searchParams.set('limit', opts.limit.toString());
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
      const body = (await res.json()) as CryptoOrdersListData;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, opts.limit]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
