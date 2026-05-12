// V-534.AO — useAdminCryptoPendingAge hook.
//
// Wraps GET /v1/admin/crypto-orders/pending-age (V-666.AC). Admin-only
// — requires the `driftstack_internal_admin` scope. Returns the four
// age buckets + total pending value by currency.

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
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

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/admin/crypto-orders/pending-age`, {
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
      const body = (await res.json()) as AdminPendingAgeData;
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
