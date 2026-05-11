// V-534.T — useCryptoOrder polling hook.
//
// Polls GET /v1/billing/crypto-orders/:id for the given order id and
// transitions the state machine each tick. Polling stops automatically
// once the order reaches a terminal status (paid / failed). Callers
// can pass `pollIntervalMs` to override the default cadence.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from './SettingsContext';

export interface CryptoOrderData {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial';
  created_at: string;
  updated_at: string;
}

export type CryptoOrderState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: CryptoOrderData }
  | { kind: 'error'; message: string };

export interface UseCryptoOrderOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
  /** Polling cadence in ms. Default 5_000. Set 0 to disable polling. */
  pollIntervalMs?: number;
}

export interface UseCryptoOrderResult {
  state: CryptoOrderState;
  refetch: () => Promise<void>;
}

const TERMINAL_STATUSES = new Set(['paid', 'failed']);
const DEFAULT_POLL_MS = 5_000;

export function useCryptoOrder(
  orderId: string | null,
  opts: UseCryptoOrderOpts = {},
): UseCryptoOrderResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoOrderState>(
    opts.manual === true || orderId === null ? { kind: 'idle' } : { kind: 'loading' },
  );
  const lastStatusRef = useRef<string | null>(null);

  const fetcher = useCallback(async (): Promise<void> => {
    if (orderId === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/billing/crypto-orders/${orderId}`, {
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
      const body = (await res.json()) as CryptoOrderData;
      lastStatusRef.current = body.status;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [orderId, settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (opts.manual === true) return;
    if (orderId === null) return;
    void fetcher();
  }, [fetcher, opts.manual, orderId]);

  useEffect(() => {
    const interval = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (interval <= 0) return;
    if (opts.manual === true) return;
    if (orderId === null) return;
    const tick = setInterval(() => {
      if (lastStatusRef.current !== null && TERMINAL_STATUSES.has(lastStatusRef.current)) {
        clearInterval(tick);
        return;
      }
      void fetcher();
    }, interval);
    return () => {
      clearInterval(tick);
    };
  }, [fetcher, opts.manual, opts.pollIntervalMs, orderId]);

  return { state, refetch: fetcher };
}
