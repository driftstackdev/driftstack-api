// V-534.Q — useAccountMe hook.
//
// Wraps GET /v1/account/me into a state-machine hook so views can
// pull account info without re-implementing fetch + state every
// time. SettingsAccountCard (V-534.L) currently rolls its own
// equivalent; this hook is the shared version views should migrate
// to (the card stays as-is — refactoring it under the hook is a
// follow-up).

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { useSettings } from './SettingsContext';

export interface AccountMeData {
  account: {
    id: string;
    email: string;
    tier: string;
  };
}

export type AccountMeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: AccountMeData }
  | { kind: 'error'; message: string };

export interface UseAccountMeOpts {
  /** Disable auto-fetch on mount. Default false. */
  manual?: boolean;
}

export interface UseAccountMeResult {
  state: AccountMeState;
  refetch: () => Promise<void>;
}

export function useAccountMe(opts: UseAccountMeOpts = {}): UseAccountMeResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AccountMeState>(
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
      const res = await fetchWithDeadline(`${baseUrl}/v1/account/me`, {
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
      const body = (await res.json()) as AccountMeData;
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Account request timed out. Check your connection and try again.'
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
