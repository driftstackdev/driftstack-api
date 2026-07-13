// V-534.AI — useAdminCryptoStats hook.
//
// Wraps GET /v1/admin/crypto-orders/stats (V-666.N + V-666.W). Admin-
// only — requires the `driftstack_internal_admin` scope.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { useSettings } from './SettingsContext';

export type AdminCryptoStatsStatus =
  'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';

export interface AdminCryptoStatsData {
  total: number;
  by_status: Record<AdminCryptoStatsStatus, number>;
  paid_revenue_cents: Record<string, number>;
  avg_time_to_paid_ms: number | null;
  paid_sample: number;
  /** V-666.AE — paid revenue keyed by product → currency → cents. */
  paid_revenue_by_product?: Record<string, Record<string, number>>;
  /** V-666.AE — paid-order count keyed by product. */
  paid_count_by_product?: Record<string, number>;
  truncated: boolean;
  scanned: number;
}

export type AdminCryptoStatsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AdminCryptoStatsData }
  | { kind: 'error'; message: string };

export interface UseAdminCryptoStatsOpts {
  /** Disable auto-fetch on mount. */
  manual?: boolean;
}

export interface UseAdminCryptoStatsResult {
  state: AdminCryptoStatsState;
  refetch: () => Promise<void>;
}

export function useAdminCryptoStats(opts: UseAdminCryptoStatsOpts = {}): UseAdminCryptoStatsResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminCryptoStatsState>(
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
      const res = await fetchWithDeadline(`${baseUrl}/v1/admin/crypto-orders/stats`, {
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
      const body = (await res.json()) as AdminCryptoStatsData;
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Crypto stats timed out. Check your connection and try again.'
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
