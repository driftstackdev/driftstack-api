// V-534.W — useCryptoOrdersList hook.
//
// Wraps GET /v1/billing/crypto-orders (V-666.G) for the GUI history
// view. Returns the caller account's own orders, newest first. Auto-
// fetches on mount; manual mode + refetch() supported.
//
// V-534.BT — cursor pagination (V-666.BU). When the server returns a
// non-null `next_cursor`, the caller can invoke `loadMore` to append
// the next page in place. Changing any filter resets pagination.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';
import type { CryptoOrderData } from './use-crypto-order';

export interface CryptoOrdersListData {
  orders: CryptoOrderData[];
  /** V-666.BU — opaque cursor for the next page, or null on the terminal page. */
  nextCursor: string | null;
}

interface ListApiResponse {
  orders: CryptoOrderData[];
  next_cursor?: string | null;
}

export type CryptoOrdersListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: CryptoOrdersListData }
  | { kind: 'loading_more'; data: CryptoOrdersListData }
  | { kind: 'error'; message: string };

export interface UseCryptoOrdersListOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
  /** Page size override; server caps at 100. Default unset = server default (50). */
  limit?: number;
  /** V-666.BR — server-side single-status filter. Omit for all statuses. */
  status?: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  /** V-666.BX — ISO 8601 lower bound on created_at (inclusive). */
  createdAfter?: string;
  /** V-666.BX — ISO 8601 upper bound on created_at (exclusive). */
  createdBefore?: string;
}

export interface UseCryptoOrdersListResult {
  state: CryptoOrdersListState;
  refetch: () => Promise<void>;
  /** V-534.BT — load + append the next page using the server-supplied cursor. */
  loadMore: () => Promise<void>;
}

export function useCryptoOrdersList(opts: UseCryptoOrdersListOpts = {}): UseCryptoOrdersListResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoOrdersListState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );

  // Race guard: monotonically-increasing request generation. Every fetch/loadMore
  // captures the generation it started at and bumps this ref; a slow older response
  // that resolves after a newer request has begun is stale and must not setState,
  // else out-of-order responses clobber the newer (e.g. filtered) data.
  const requestGenRef = useRef(0);

  const buildUrl = useCallback(
    (cursor: string | null): URL => {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const url = new URL(`${baseUrl}/v1/billing/crypto-orders`);
      if (opts.limit !== undefined) url.searchParams.set('limit', opts.limit.toString());
      if (opts.status !== undefined) url.searchParams.set('status', opts.status);
      if (opts.createdAfter !== undefined && opts.createdAfter.length > 0) {
        url.searchParams.set('created_after', opts.createdAfter);
      }
      if (opts.createdBefore !== undefined && opts.createdBefore.length > 0) {
        url.searchParams.set('created_before', opts.createdBefore);
      }
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      return url;
    },
    [settings.baseUrl, opts.limit, opts.status, opts.createdAfter, opts.createdBefore],
  );

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    // Claim a fresh generation; any earlier in-flight response is now stale.
    const gen = ++requestGenRef.current;
    setState({ kind: 'loading' });
    try {
      const res = await fetch(buildUrl(null).toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (gen !== requestGenRef.current) return; // superseded by a newer request
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as ListApiResponse;
      if (gen !== requestGenRef.current) return; // superseded by a newer request
      setState({
        kind: 'ready',
        data: { orders: body.orders, nextCursor: body.next_cursor ?? null },
      });
    } catch (err) {
      if (gen !== requestGenRef.current) return; // superseded by a newer request
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
    // Claim a fresh generation; a subsequent filter refetch (or this call) supersedes.
    const gen = ++requestGenRef.current;
    setState({ kind: 'loading_more', data: baseline });
    try {
      const res = await fetch(buildUrl(baseline.nextCursor).toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (gen !== requestGenRef.current) return; // superseded by a newer request
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as ListApiResponse;
      if (gen !== requestGenRef.current) return; // superseded by a newer request
      setState({
        kind: 'ready',
        data: {
          orders: [...baseline.orders, ...body.orders],
          nextCursor: body.next_cursor ?? null,
        },
      });
    } catch (err) {
      if (gen !== requestGenRef.current) return; // superseded by a newer request
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
