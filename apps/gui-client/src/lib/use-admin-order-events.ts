// V-534.BD — useAdminOrderEvents hook.
//
// Wraps GET /v1/admin/crypto-orders/:order_id/events (V-666.AT).
// Fetches on mount and on orderId change. The detail drawer
// consumes this to render an inline timeline below the envelope.

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';

export interface AdminOrderEvent {
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  at: string;
  source: 'create' | 'ipn' | 'cancel' | 'expired' | 'swept';
}

export type AdminOrderEventsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; events: AdminOrderEvent[] }
  | { kind: 'error'; message: string };

export interface UseAdminOrderEventsResult {
  state: AdminOrderEventsState;
  refetch: () => Promise<void>;
}

export function useAdminOrderEvents(orderId: string | null): UseAdminOrderEventsResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminOrderEventsState>(
    orderId === null ? { kind: 'idle' } : { kind: 'loading' },
  );

  const fetcher = useCallback(async (): Promise<void> => {
    if (orderId === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(
        `${baseUrl}/v1/admin/crypto-orders/${encodeURIComponent(orderId)}/events`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as { events?: AdminOrderEvent[] };
      setState({ kind: 'ready', events: Array.isArray(body.events) ? body.events : [] });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, orderId]);

  useEffect(() => {
    void fetcher();
  }, [fetcher]);

  return { state, refetch: fetcher };
}
