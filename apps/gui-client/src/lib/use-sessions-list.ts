// V-534.O — useSessionsList hook.
//
// Fetches GET /v1/sessions and exposes a loading/error/ready state
// machine + a refetch fn. Mirrors useAccountCost (V-534.H) /
// useCryptoCheckout (V-534.J): direct fetch against baseUrl + apiKey
// from SettingsContext until an SDK client.sessions.list() lands.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
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
      const res = await fetchWithDeadline(`${baseUrl}/v1/sessions?limit=${limit.toString()}`, {
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
      const body = await readBoundedApiJson<SessionsListResponse>(res);
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Session history timed out. Check your connection and try again.'
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
  }, [settings.apiKey, settings.baseUrl, limit]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [settings.apiKey, settings.baseUrl, limit],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    void fetcher();
  }, [fetcher, opts.manual]);

  return { state, refetch: fetcher };
}
