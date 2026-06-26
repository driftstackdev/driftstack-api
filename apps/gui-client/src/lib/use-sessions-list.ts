// V-534.O — useSessionsList hook.
//
// Fetches GET /v1/sessions and exposes a loading/error/ready state
// machine + a refetch fn. Mirrors useAccountCost (V-534.H) /
// useCryptoCheckout (V-534.J): direct fetch against baseUrl + apiKey
// from SettingsContext until an SDK client.sessions.list() lands.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
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

  // Abort the previous request on a key/baseUrl/limit change (or unmount) so a
  // slow response after the change can't setState with data fetched under the
  // OLD key (+ "setState on unmounted" churn). Mirrors use-connection-status.
  const abortRef = useRef<AbortController | null>(null);

  const fetcher = useCallback(
    async (signal?: AbortSignal, isActive?: () => boolean): Promise<void> => {
      const apply = (next: SessionsListState): void => {
        if (isActive === undefined || isActive()) setState(next);
      };
      if (!settings.apiKey) {
        apply({ kind: 'error', message: 'No API key configured.' });
        return;
      }
      apply({ kind: 'loading' });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/sessions?limit=${limit.toString()}`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
          },
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!res.ok) {
          apply({ kind: 'error', message: await readApiErrorMessage(res) });
          return;
        }
        const body = (await res.json()) as SessionsListResponse;
        apply({ kind: 'ready', data: body });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        apply({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl, limit],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    let active = true;
    const controller = new AbortController();
    abortRef.current = controller;
    void fetcher(controller.signal, () => active);
    return () => {
      active = false;
      controller.abort();
    };
  }, [fetcher, opts.manual]);

  const refetch = useCallback((): Promise<void> => fetcher(), [fetcher]);
  return { state, refetch };
}
