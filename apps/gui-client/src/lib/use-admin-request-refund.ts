// V-534.AK — useAdminRequestRefund hook.
//
// Action hook wrapping POST /v1/admin/crypto-orders/:id/request-refund
// (V-666.X) + POST /v1/admin/crypto-orders/:id/cancel-refund-request
// (V-666.Y). Returns a state machine and two action methods. The
// dashboard's confirmation modal owns the reason input; this hook
// just fires the request.

import { useCallback, useState } from 'react';
import { useSettings } from './SettingsContext';
import type { AdminCryptoOrder } from './use-admin-crypto-orders-list';

export type AdminRequestRefundState =
  | { kind: 'idle' }
  | { kind: 'submitting'; orderId: string }
  | { kind: 'succeeded'; orderId: string; order: AdminCryptoOrder }
  | { kind: 'failed'; orderId: string; status: number; message: string };

export interface UseAdminRequestRefundResult {
  state: AdminRequestRefundState;
  request: (orderId: string, reason: string) => Promise<void>;
  cancel: (orderId: string) => Promise<void>;
  reset: () => void;
}

export function useAdminRequestRefund(): UseAdminRequestRefundResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminRequestRefundState>({ kind: 'idle' });

  const post = useCallback(
    async (orderId: string, path: string, body: unknown): Promise<void> => {
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
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status.toString()}`;
          try {
            const errBody = (await res.json()) as { detail?: string };
            if (typeof errBody.detail === 'string' && errBody.detail.length > 0) {
              detail = errBody.detail;
            }
          } catch {
            /* keep the HTTP-status fallback */
          }
          setState({ kind: 'failed', orderId, status: res.status, message: detail });
          return;
        }
        const updated = (await res.json()) as AdminCryptoOrder;
        setState({ kind: 'succeeded', orderId, order: updated });
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

  const request = useCallback(
    async (orderId: string, reason: string): Promise<void> => {
      await post(orderId, `/v1/admin/crypto-orders/${orderId}/request-refund`, {
        reason,
      });
    },
    [post],
  );

  const cancel = useCallback(
    async (orderId: string): Promise<void> => {
      await post(orderId, `/v1/admin/crypto-orders/${orderId}/cancel-refund-request`, {});
    },
    [post],
  );

  const reset = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return { state, request, cancel, reset };
}
