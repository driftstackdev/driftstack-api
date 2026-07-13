// V-534.BD — useAdminOrderEvents hook.
//
// Wraps GET /v1/admin/crypto-orders/:order_id/events (V-666.AT).
// Fetches on mount and on orderId change. The detail drawer
// consumes this to render an inline timeline below the envelope.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { humanizeError } from './humanize-error';
import { readBoundedApiJson } from './read-bounded-json';
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
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const fetcher = useCallback(async (): Promise<void> => {
    if (orderId === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetchWithDeadline(
        `${baseUrl}/v1/admin/crypto-orders/${encodeURIComponent(orderId)}/events`,
        {
          method: 'GET',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) setState({ kind: 'error', message });
        return;
      }
      const body = await readBoundedApiJson<{ events?: AdminOrderEvent[] }>(res);
      if (sequence === sequenceRef.current) {
        setState({ kind: 'ready', events: Array.isArray(body.events) ? body.events : [] });
      }
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Order events timed out. Check your connection and try again.'
              : humanizeError(err, "Couldn't load order events. Try again."),
        });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        inFlightRef.current = false;
      }
    }
  }, [settings.apiKey, settings.baseUrl, orderId]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [settings.apiKey, settings.baseUrl, orderId],
  );

  useEffect(() => {
    void fetcher();
  }, [fetcher]);

  return { state, refetch: fetcher };
}
