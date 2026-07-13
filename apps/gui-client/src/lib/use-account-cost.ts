// V-534.H — useAccountCost hook.
//
// Fetches the customer-facing GET /v1/account/cost route landed in
// V-541.D. The SDK doesn't yet expose `client.account.cost()`
// (V-541.E follow-up); until it does, this hook calls the endpoint
// directly using the baseUrl + apiKey already in SettingsContext.
//
// State machine: idle → loading → (ready | error). Caller can
// re-fetch via refetch().

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
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
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  const fetcher = useCallback(async (): Promise<void> => {
    const sequence = ++sequenceRef.current;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!settings.apiKey) {
      requestRef.current = null;
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const qs = opts.billingCycle ? `?billing_cycle=${encodeURIComponent(opts.billingCycle)}` : '';
      const res = await fetchWithDeadline(`${baseUrl}/v1/account/cost${qs}`, {
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
      const body = (await res.json()) as AccountCostResponse;
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Cost request timed out. Check your connection and try again.'
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [settings.apiKey, settings.baseUrl, opts.billingCycle]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  return { state, refetch: fetcher };
}
