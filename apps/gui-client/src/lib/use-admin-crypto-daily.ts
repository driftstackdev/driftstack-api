// V-534.AH — useAdminCryptoDaily hook.
//
// Wraps GET /v1/admin/crypto-orders/daily (V-666.O). Admin-only —
// requires the `driftstack_internal_admin` scope. Returns one row per
// (date, status) combination; the consuming view fills gaps + stacks
// statuses for display.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

export type AdminDailyStatus =
  | 'pending'
  | 'confirming'
  | 'paid'
  | 'failed'
  | 'partial'
  | 'cancelled';

export interface AdminDailyRow {
  date: string; // YYYY-MM-DD (UTC)
  status: AdminDailyStatus;
  count: number;
}

export interface AdminDailyData {
  days: number;
  rows: AdminDailyRow[];
  truncated: boolean;
}

export type AdminDailyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminDailyData }
  | { kind: 'error'; message: string };

export interface UseAdminCryptoDailyOpts {
  /** Lookback window in days (default unset — server defaults to 7, max 90). */
  days?: number;
  /** Disable auto-fetch on mount. */
  manual?: boolean;
}

export interface UseAdminCryptoDailyResult {
  state: AdminDailyState;
  refetch: () => Promise<void>;
}

export function useAdminCryptoDaily(opts: UseAdminCryptoDailyOpts = {}): UseAdminCryptoDailyResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminDailyState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );

  const days = opts.days;
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
      const url = new URL(`${baseUrl}/v1/admin/crypto-orders/daily`);
      if (days !== undefined) url.searchParams.set('days', days.toString());
      const res = await fetchWithDeadline(url.toString(), {
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
      const body = await readBoundedApiJson<AdminDailyData>(res);
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Daily trends timed out. Check your connection and try again.'
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
  }, [settings.apiKey, settings.baseUrl, days]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [settings.apiKey, settings.baseUrl, days],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
