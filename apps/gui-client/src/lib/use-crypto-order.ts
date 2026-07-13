// V-534.T — useCryptoOrder polling hook.
//
// Polls GET /v1/billing/crypto-orders/:id for the given order id and
// transitions the state machine each tick. Polling stops automatically
// once the order reaches a terminal status (paid / failed / cancelled).
// Callers can pass `pollIntervalMs` to override the default cadence.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

export interface CryptoOrderEvent {
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  at: string;
  /** V-666.AU — customer-facing source tag. 'swept' is mapped to 'expired' server-side. */
  source: 'create' | 'ipn' | 'cancel' | 'expired';
}

export interface CryptoOrderData {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  /** V-666.AU — append-only state-transition timeline. Optional on
   *  the wire so older server builds still parse. */
  events?: CryptoOrderEvent[];
  /** V-666.AV — informational pay-window deadline (ISO 8601). Set
   *  for pending orders; null otherwise. */
  expires_at?: string | null;
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

const TERMINAL_STATUSES = new Set(['paid', 'failed', 'cancelled']);
// Stop polling on a terminal status OR 'partial' — a partial payment needs
// customer action (pay the rest), so polling won't progress it.
const STOP_POLLING_STATUSES = new Set([...TERMINAL_STATUSES, 'partial']);
// Stop the poll after this many consecutive fetch failures so a persistently
// failing endpoint (offline / 500s / rate-limit) doesn't hammer it forever.
const MAX_CONSECUTIVE_ERRORS = 5;
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
  const failCountRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const fetcher = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    if (orderId === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetchWithDeadline(`${baseUrl}/v1/billing/crypto-orders/${orderId}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) {
          failCountRef.current += 1;
          setState({ kind: 'error', message });
        }
        return;
      }
      const body = await readBoundedApiJson<CryptoOrderData>(res);
      if (sequence === sequenceRef.current) {
        failCountRef.current = 0;
        lastStatusRef.current = body.status;
        setState({ kind: 'ready', data: body });
      }
    } catch (err) {
      if (sequence === sequenceRef.current) {
        failCountRef.current += 1;
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Order status timed out. Check your connection and try again.'
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
  }, [orderId, settings.apiKey, settings.baseUrl]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
      lastStatusRef.current = null;
      failCountRef.current = 0;
    },
    [orderId, settings.apiKey, settings.baseUrl],
  );

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
      if (
        (lastStatusRef.current !== null && STOP_POLLING_STATUSES.has(lastStatusRef.current)) ||
        failCountRef.current >= MAX_CONSECUTIVE_ERRORS
      ) {
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
