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

  // Track the latest in-flight request so a key/baseUrl change (or unmount) can
  // abort the previous one and discard its late resolution — otherwise a slow
  // response after a key change could setState with data fetched under the OLD
  // key (+ "setState on unmounted" churn). Mirrors use-connection-status. (audit)
  const abortRef = useRef<AbortController | null>(null);

  // `isActive` lets the effect-driven call drop its result after cleanup; a
  // manual refetch (no isActive) always applies.
  const fetcher = useCallback(
    async (signal?: AbortSignal, isActive?: () => boolean): Promise<void> => {
      const apply = (next: AccountMeState): void => {
        if (isActive === undefined || isActive()) setState(next);
      };
      if (!settings.apiKey) {
        apply({ kind: 'error', message: 'No API key configured.' });
        return;
      }
      apply({ kind: 'loading' });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/account/me`, {
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
        const body = (await res.json()) as AccountMeData;
        apply({ kind: 'ready', data: body });
      } catch (err) {
        // An abort (key/baseUrl change / unmount) is expected — don't surface it.
        if (err instanceof Error && err.name === 'AbortError') return;
        apply({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
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

  // The public refetch keeps its no-arg signature (user-triggered → always apply).
  const refetch = useCallback((): Promise<void> => fetcher(), [fetcher]);
  return { state, refetch };
}
