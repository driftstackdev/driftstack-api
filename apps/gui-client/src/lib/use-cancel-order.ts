// V-534.Y — useCancelOrder hook.
//
// Action hook (not a fetch-on-mount hook) that wraps
// POST /v1/billing/crypto-orders/:id/cancel (V-666.J). Returns a state
// machine: idle → submitting → succeeded | failed. Caller invokes
// `cancel(orderId)` to fire the request. `reset()` returns to idle so
// the same hook instance can be reused across multiple orders.

import { useCallback, useState } from 'react';
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

  const cancel = useCallback(
    async (orderId: string): Promise<void> => {
      if (!settings.apiKey) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: 'No API key configured.',
        });
        return;
      }
      setState({ kind: 'submitting', orderId });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/billing/crypto-orders/${orderId}/cancel`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
          },
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status.toString()}`;
          try {
            const body = (await res.json()) as { detail?: string };
            if (typeof body.detail === 'string' && body.detail.length > 0) {
              detail = body.detail;
            }
          } catch {
            /* keep the HTTP status fallback */
          }
          setState({ kind: 'failed', orderId, status: res.status, message: detail });
          return;
        }
        const body = (await res.json()) as CryptoOrderData;
        setState({ kind: 'succeeded', order: body });
      } catch (err) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return { state, cancel, reset };
}
