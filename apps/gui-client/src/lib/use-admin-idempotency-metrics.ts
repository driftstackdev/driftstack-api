// V-534.BA — useAdminIdempotencyMetrics hook.
//
// Wraps GET /v1/admin/crypto-orders/idempotency-metrics (V-666.AP).
// Admin-only — requires the `driftstack_internal_admin` scope. Cheap
// to scrape (no full-table walk), so the dashboard polls it alongside
// the stats card on every refresh.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { humanizeError } from './humanize-error';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

export interface AdminIdempotencyMetricsData {
  replays: number;
  first_writes: number;
  /** V-666.AR — count of replays where the request body differed from the stored one. */
  body_mismatches?: number;
}

export type AdminIdempotencyMetricsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminIdempotencyMetricsData }
  | { kind: 'error'; message: string };

export interface UseAdminIdempotencyMetricsOpts {
  manual?: boolean;
}

export interface UseAdminIdempotencyMetricsResult {
  state: AdminIdempotencyMetricsState;
  refetch: () => Promise<void>;
}

export function useAdminIdempotencyMetrics(
  opts: UseAdminIdempotencyMetricsOpts = {},
): UseAdminIdempotencyMetricsResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminIdempotencyMetricsState>(
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
      const res = await fetchWithDeadline(`${baseUrl}/v1/admin/crypto-orders/idempotency-metrics`, {
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
      const body = await readBoundedApiJson<AdminIdempotencyMetricsData>(res);
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Idempotency metrics timed out. Check your connection and try again.'
              : humanizeError(err, "Couldn't load idempotency metrics. Try again."),
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
