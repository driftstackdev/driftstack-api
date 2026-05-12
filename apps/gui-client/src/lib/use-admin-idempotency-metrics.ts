// V-534.BA — useAdminIdempotencyMetrics hook.
//
// Wraps GET /v1/admin/crypto-orders/idempotency-metrics (V-666.AP).
// Admin-only — requires the `driftstack_internal_admin` scope. Cheap
// to scrape (no full-table walk), so the dashboard polls it alongside
// the stats card on every refresh.

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
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

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/admin/crypto-orders/idempotency-metrics`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const body = (await res.json()) as AdminIdempotencyMetricsData;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
