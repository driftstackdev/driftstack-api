// V-534.AL — useAdminInternalNote hook.
//
// Wraps PATCH /v1/admin/crypto-orders/:id/internal-note (V-666.AA).
// Admin-only — caller must hold the `driftstack_internal_admin` scope.
// Returns a state machine + a single `save(orderId, note)` action;
// passing null OR an empty string clears the note (the server-side
// service normalises both to null).

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { useSettings } from './SettingsContext';
import type { AdminCryptoOrder } from './use-admin-crypto-orders-list';

export type AdminInternalNoteState =
  | { kind: 'idle' }
  | { kind: 'submitting'; orderId: string }
  | { kind: 'succeeded'; orderId: string; order: AdminCryptoOrder }
  | { kind: 'failed'; orderId: string; status: number; message: string };

export interface UseAdminInternalNoteResult {
  state: AdminInternalNoteState;
  save: (orderId: string, internalNote: string | null) => Promise<void>;
  reset: () => void;
}

export function useAdminInternalNote(): UseAdminInternalNoteResult {
  const { settings } = useSettings();
  const [state, setState] = useState<AdminInternalNoteState>({ kind: 'idle' });
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const save = useCallback(
    async (orderId: string, internalNote: string | null): Promise<void> => {
      if (inFlightRef.current) return;
      if (!settings.apiKey) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: 'No API key configured.',
        });
        return;
      }
      inFlightRef.current = true;
      const sequence = ++sequenceRef.current;
      const controller = new AbortController();
      requestRef.current = controller;
      setState({ kind: 'submitting', orderId });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetchWithDeadline(
          `${baseUrl}/v1/admin/crypto-orders/${encodeURIComponent(orderId)}/internal-note`,
          {
            method: 'PATCH',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${settings.apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ internal_note: internalNote }),
          },
        );
        if (!res.ok) {
          const message = await readApiErrorMessage(res);
          if (sequence === sequenceRef.current) {
            setState({ kind: 'failed', orderId, status: res.status, message });
          }
          return;
        }
        const order = (await res.json()) as AdminCryptoOrder;
        if (sequence === sequenceRef.current) setState({ kind: 'succeeded', orderId, order });
      } catch (err) {
        if (sequence === sequenceRef.current) {
          setState({
            kind: 'failed',
            orderId,
            status: 0,
            message:
              err instanceof DOMException && err.name === 'AbortError'
                ? 'Saving the internal note timed out. Check your connection and try again.'
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
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback((): void => {
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    inFlightRef.current = false;
    setState({ kind: 'idle' });
  }, []);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [],
  );

  return { state, save, reset };
}
