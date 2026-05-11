// V-534.AI — useAdminCryptoStats hook.
//
// Wraps GET /v1/admin/crypto-orders/stats (V-666.N + V-666.W). Admin-
// only — requires the `driftstack_internal_admin` scope.

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';

export type AdminCryptoStatsStatus =
  | 'pending'
  | 'confirming'
  | 'paid'
  | 'failed'
  | 'partial'
  | 'cancelled';

export interface AdminCryptoStatsData {
  total: number;
  by_status: Record<AdminCryptoStatsStatus, number>;
  paid_revenue_cents: Record<string, number>;
  avg_time_to_paid_ms: number | null;
  paid_sample: number;
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

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/admin/crypto-orders/stats`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        setState({ kind: 'error', message: `HTTP ${res.status.toString()}` });
        return;
      }
      const body = (await res.json()) as AdminCryptoStatsData;
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
