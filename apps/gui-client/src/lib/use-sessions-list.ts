// V-534.O — useSessionsList hook.
//
// Fetches GET /v1/sessions and exposes a loading/error/ready state
// machine + a refetch fn. Mirrors useAccountCost (V-534.H) /
// useCryptoCheckout (V-534.J): direct fetch against baseUrl + apiKey
// from SettingsContext until an SDK client.sessions.list() lands.

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';

export interface SessionListItem {
  id: string;
  status: string;
  url: string;
  createdAt: string;
  endedAt: string | null;
}

export interface SessionsListResponse {
  sessions: SessionListItem[];
  nextCursor: string | null;
}

export type SessionsListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: SessionsListResponse }
  | { kind: 'error'; message: string };

export interface UseSessionsListOpts {
  /** Page size. Default 25. */
  limit?: number;
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
}

export interface UseSessionsListResult {
  state: SessionsListState;
  refetch: () => Promise<void>;
}

export function useSessionsList(opts: UseSessionsListOpts = {}): UseSessionsListResult {
  const { settings } = useSettings();
  const [state, setState] = useState<SessionsListState>(
    opts.manual === true ? { kind: 'idle' } : { kind: 'loading' },
  );

  const limit = opts.limit ?? 25;

  const fetcher = useCallback(async (): Promise<void> => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/sessions?limit=${limit.toString()}`, {
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
      const body = (await res.json()) as SessionsListResponse;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [settings.apiKey, settings.baseUrl, limit]);

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
