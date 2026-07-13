// V-534.Y — useCancelOrder hook.
//
// Action hook (not a fetch-on-mount hook) that wraps
// POST /v1/billing/crypto-orders/:id/cancel (V-666.J). Returns a state
// machine: idle → submitting → succeeded | failed. Caller invokes
// `cancel(orderId)` to fire the request. `reset()` returns to idle so
// the same hook instance can be reused across multiple orders.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { humanizeError } from './humanize-error';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';
import type { CryptoOrderData } from './use-crypto-order';

export type CancelOrderState =
  | { kind: 'idle' }
  | { kind: 'submitting'; orderId: string }
  | { kind: 'succeeded'; order: CryptoOrderData }
  | { kind: 'failed'; orderId: string; status: number; message: string };

export interface UseCancelOrderResult {
  state: CancelOrderState;
  cancel: (orderId: string) => Promise<void>;
  reset: () => void;
}

export function useCancelOrder(): UseCancelOrderResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CancelOrderState>({ kind: 'idle' });
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const cancel = useCallback(
    async (orderId: string): Promise<void> => {
      if (inFlightRef.current) return;
      if (!settings.apiKey) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: 'No API key configured.',
        });
        return;
      }
      inFlightRef.current = true;
      const sequence = ++sequenceRef.current;
      const controller = new AbortController();
      requestRef.current = controller;
      setState({ kind: 'submitting', orderId });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetchWithDeadline(
          `${baseUrl}/v1/billing/crypto-orders/${orderId}/cancel`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${settings.apiKey}`,
              accept: 'application/json',
            },
          },
        );
        if (!res.ok) {
          const message = await readApiErrorMessage(res);
          if (sequence === sequenceRef.current) {
            setState({ kind: 'failed', orderId, status: res.status, message });
          }
          return;
        }
        const body = await readBoundedApiJson<CryptoOrderData>(res);
        if (sequence === sequenceRef.current) setState({ kind: 'succeeded', order: body });
      } catch (err) {
        if (sequence === sequenceRef.current) {
          setState({
            kind: 'failed',
            orderId,
            status: 0,
            message:
              err instanceof DOMException && err.name === 'AbortError'
                ? 'Cancellation timed out. Check your connection and try again.'
                : humanizeError(err, "Couldn't cancel the order. Try again."),
          });
        }
      } finally {
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

  return { state, cancel, reset };
}
