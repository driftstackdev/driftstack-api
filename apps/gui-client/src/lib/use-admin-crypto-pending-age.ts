// V-534.AO — useAdminCryptoPendingAge hook.
//
// Wraps GET /v1/admin/crypto-orders/pending-age (V-666.AC). Admin-only
// — requires the `driftstack_internal_admin` scope. Returns the four
// age buckets + total pending value by currency.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

export interface AdminPendingAgeBuckets {
  under_1h: number;
  h1_to_6h: number;
  h6_to_24h: number;
  over_24h: number;
}

export interface AdminPendingAgeData {
  buckets: AdminPendingAgeBuckets;
  pending_value_cents: Record<string, number>;
  total: number;
  truncated: boolean;
  scanned: number;
}

export type AdminPendingAgeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminPendingAgeData }
  | { kind: 'error'; message: string };

export interface UseAdminCryptoPendingAgeOpts {
  manual?: boolean;
}

export interface UseAdminCryptoPendingAgeResult {
  state: AdminPendingAgeState;
  refetch: () => Promise<void>;
}

export function useAdminCryptoPendingAge(
  opts: UseAdminCryptoPendingAgeOpts = {},
): UseAdminCryptoPendingAgeResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminPendingAgeState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const fetcher = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetchWithDeadline(`${baseUrl}/v1/admin/crypto-orders/pending-age`, {
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
      const body = await readBoundedApiJson<AdminPendingAgeData>(res);
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Pending-age metrics timed out. Check your connection and try again.'
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
  }, [settings.apiKey, settings.baseUrl]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [settings.apiKey, settings.baseUrl],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
