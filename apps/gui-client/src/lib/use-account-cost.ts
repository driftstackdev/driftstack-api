// V-534.H — useAccountCost hook.
//
// Fetches the customer-facing GET /v1/account/cost route landed in
// V-541.D. The SDK doesn't yet expose `client.account.cost()`
// (V-541.E follow-up); until it does, this hook calls the endpoint
// directly using the baseUrl + apiKey already in SettingsContext.
//
// State machine: idle → loading → (ready | error). Caller can
// re-fetch via refetch().

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';
import type { CostBreakdownInput } from './cost-panel';

export interface AccountCostResponse {
  account_id: string;
  billing_cycle: string;
  tier: string;
  breakdown: CostBreakdownInput;
}

export type AccountCostState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AccountCostResponse }
  | { kind: 'error'; message: string };

export interface UseAccountCostOpts {
  /** YYYY-MM. Omit to fetch the current month. */
  billingCycle?: string;
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
}

export interface UseAccountCostResult {
  state: AccountCostState;
  refetch: () => Promise<void>;
}

export function useAccountCost(opts: UseAccountCostOpts = {}): UseAccountCostResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AccountCostState>(
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
      const qs = opts.billingCycle ? `?billing_cycle=${encodeURIComponent(opts.billingCycle)}` : '';
      const res = await fetch(`${baseUrl}/v1/account/cost${qs}`, {
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
      const body = (await res.json()) as AccountCostResponse;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, opts.billingCycle]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
