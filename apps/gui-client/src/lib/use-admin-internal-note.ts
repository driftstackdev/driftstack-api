// V-534.AL — useAdminInternalNote hook.
//
// Wraps PATCH /v1/admin/crypto-orders/:id/internal-note (V-666.AA).
// Admin-only — caller must hold the `driftstack_internal_admin` scope.
// Returns a state machine + a single `save(orderId, note)` action;
// passing null OR an empty string clears the note (the server-side
// service normalises both to null).

import { useCallback, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
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

  const save = useCallback(
    async (orderId: string, internalNote: string | null): Promise<void> => {
      if (!settings.apiKey) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: 'No API key configured.',
        });
        return;
      }
      setState({ kind: 'submitting', orderId });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/admin/crypto-orders/${orderId}/internal-note`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ internal_note: internalNote }),
        });
        if (!res.ok) {
          setState({
            kind: 'failed',
            orderId,
            status: res.status,
            message: await readApiErrorMessage(res),
          });
          return;
        }
        const order = (await res.json()) as AdminCryptoOrder;
        setState({ kind: 'succeeded', orderId, order });
      } catch (err) {
        setState({
          kind: 'failed',
          orderId,
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return { state, save, reset };
}
