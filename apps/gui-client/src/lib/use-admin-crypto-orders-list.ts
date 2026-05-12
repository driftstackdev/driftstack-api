// V-534.AG — useAdminCryptoOrdersList hook.
//
// Wraps GET /v1/admin/crypto-orders (V-666.D + V-666.T). Admin-only
// surface — caller must have an API key with the
// `driftstack_internal_admin` scope; non-admin keys get a 403 which
// surfaces as an error state. Supports the V-666.T status + search
// filters via opts; refetch picks up the latest opts.
//
// V-534.AW — cursor pagination (V-666.AM). When the server returns
// a non-null `next_cursor`, the caller can invoke `loadMore` to
// append the next page in place. Changing any filter resets the
// pagination state (the next fetch starts from the first page).

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';
import type { CryptoOrderData } from './use-crypto-order';

export interface AdminCryptoOrder extends CryptoOrderData {
  account_id: string | null;
  /** Customer-side bookkeeping note (also surfaced to the customer). */
  customer_note?: string | null;
  /** V-666.AA — admin-only internal note. Not visible to the customer. */
  internal_note?: string | null;
}

export interface AdminCryptoOrdersListData {
  orders: AdminCryptoOrder[];
  /** V-666.AM — opaque cursor for the next page, or null on the terminal page. */
  nextCursor: string | null;
}

interface ListApiResponse {
  orders: AdminCryptoOrder[];
  next_cursor?: string | null;
}

export type AdminCryptoOrdersListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminCryptoOrdersListData }
  | { kind: 'loading_more'; data: AdminCryptoOrdersListData }
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
  /** V-666.AS — exact-match payment_id filter. */
  paymentId?: string | null;
  /** V-666.BY — ISO 8601 lower bound on created_at (inclusive). */
  createdAfter?: string | null;
  /** V-666.BY — ISO 8601 upper bound on created_at (exclusive). */
  createdBefore?: string | null;
}

export interface UseAdminCryptoOrdersListResult {
  state: AdminCryptoOrdersListState;
  refetch: () => Promise<void>;
  /** V-534.AW — load + append the next page using the server-supplied cursor. */
  loadMore: () => Promise<void>;
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
  const paymentId = opts.paymentId ?? null;
  const createdAfter = opts.createdAfter ?? null;
  const createdBefore = opts.createdBefore ?? null;

  const buildUrl = useCallback(
    (cursor: string | null): URL => {
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
      if (paymentId !== null && paymentId.trim().length > 0) {
        url.searchParams.set('payment_id', paymentId.trim());
      }
      if (createdAfter !== null && createdAfter.trim().length > 0) {
        url.searchParams.set('created_after', createdAfter.trim());
      }
      if (createdBefore !== null && createdBefore.trim().length > 0) {
        url.searchParams.set('created_before', createdBefore.trim());
      }
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      return url;
    },
    [settings.baseUrl, limit, status, search, accountId, paymentId, createdAfter, createdBefore],
  );

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const res = await fetch(buildUrl(null).toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as ListApiResponse;
      setState({
        kind: 'ready',
        data: { orders: body.orders, nextCursor: body.next_cursor ?? null },
      });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, buildUrl]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (state.kind !== 'ready') return;
    if (state.data.nextCursor === null) return;
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    const baseline = state.data;
    setState({ kind: 'loading_more', data: baseline });
    try {
      const res = await fetch(buildUrl(baseline.nextCursor).toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as ListApiResponse;
      setState({
        kind: 'ready',
        data: {
          orders: [...baseline.orders, ...body.orders],
          nextCursor: body.next_cursor ?? null,
        },
      });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [state, settings.apiKey, buildUrl]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher, loadMore };
}
