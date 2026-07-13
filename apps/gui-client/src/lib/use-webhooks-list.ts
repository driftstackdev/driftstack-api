// V-534.S — useWebhooksList hook.
//
// Wraps GET /v1/webhooks (V-225 listWithCounts). The endpoint
// returns the customer's webhook endpoints + per-endpoint delivery
// counts; this hook surfaces it through the same state-machine
// pattern as useSessionsList (V-534.O) and useAccountCost (V-534.H).

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
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
      const res = await fetchWithDeadline(`${baseUrl}/v1/webhooks`, {
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
      const body = (await res.json()) as WebhooksListResponse;
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Webhook request timed out. Check your connection and try again.'
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [settings.apiKey, settings.baseUrl]);

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
