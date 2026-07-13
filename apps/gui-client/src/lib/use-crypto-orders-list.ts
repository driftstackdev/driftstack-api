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
import { fetchWithDeadline } from './fetch-with-deadline';
import { humanizeError } from './humanize-error';
import { readBoundedApiJson } from './read-bounded-json';
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

  const refreshRequestRef = useRef<AbortController | null>(null);
  const pageRequestRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const pageInFlightRef = useRef(false);
  const sequenceRef = useRef(0);

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
    if (refreshInFlightRef.current) return;
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    pageInFlightRef.current = false;
    refreshInFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    refreshRequestRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithDeadline(buildUrl(null).toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) setState({ kind: 'error', message });
        return;
      }
      const body = await readBoundedApiJson<ListApiResponse>(res);
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'ready',
          data: { orders: body.orders, nextCursor: body.next_cursor ?? null },
        });
      }
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Order history timed out. Check your connection and try again.'
              : humanizeError(err, "Couldn't load order history. Try again."),
        });
      }
    } finally {
      if (refreshRequestRef.current === controller) {
        refreshRequestRef.current = null;
        refreshInFlightRef.current = false;
      }
    }
  }, [settings.apiKey, buildUrl]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (state.kind !== 'ready') return;
    if (state.data.nextCursor === null) return;
    if (refreshInFlightRef.current || pageInFlightRef.current) return;
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    const baseline = state.data;
    pageInFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    pageRequestRef.current = controller;
    setState({ kind: 'loading_more', data: baseline });
    try {
      const res = await fetchWithDeadline(buildUrl(baseline.nextCursor).toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) setState({ kind: 'error', message });
        return;
      }
      const body = await readBoundedApiJson<ListApiResponse>(res);
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'ready',
          data: {
            orders: [...baseline.orders, ...body.orders],
            nextCursor: body.next_cursor ?? null,
          },
        });
      }
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'More orders timed out. Check your connection and try again.'
              : humanizeError(err, "Couldn't load more orders. Try again."),
        });
      }
    } finally {
      if (pageRequestRef.current === controller) {
        pageRequestRef.current = null;
        pageInFlightRef.current = false;
      }
    }
  }, [state, settings.apiKey, buildUrl]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      refreshRequestRef.current?.abort();
      pageRequestRef.current?.abort();
      refreshRequestRef.current = null;
      pageRequestRef.current = null;
      refreshInFlightRef.current = false;
      pageInFlightRef.current = false;
    },
    [settings.apiKey, buildUrl],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher, loadMore };
}
