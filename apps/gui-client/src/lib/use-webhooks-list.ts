// V-534.S — useWebhooksList hook.
//
// Wraps GET /v1/webhooks (V-225 listWithCounts). The endpoint
// returns the customer's webhook endpoints + per-endpoint delivery
// counts; this hook surfaces it through the same state-machine
// pattern as useSessionsList (V-534.O) and useAccountCost (V-534.H).

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';

export interface WebhookCounts {
  delivered: number;
  failed: number;
  dlq: number;
}

export interface WebhookListItem {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  disabledAt: string | null;
  createdAt: string;
  counts: WebhookCounts;
}

export interface WebhooksListResponse {
  webhooks: WebhookListItem[];
}

export type WebhooksListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: WebhooksListResponse }
  | { kind: 'error'; message: string };

export interface UseWebhooksListOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
}

export interface UseWebhooksListResult {
  state: WebhooksListState;
  refetch: () => Promise<void>;
}

export function useWebhooksList(opts: UseWebhooksListOpts = {}): UseWebhooksListResult {
  const { settings } = useSettings();
  const [state, setState] = useState<WebhooksListState>(
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
      const res = await fetch(`${baseUrl}/v1/webhooks`, {
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
      const body = (await res.json()) as WebhooksListResponse;
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
