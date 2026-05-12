// V-534.J — useCryptoCheckout hook.
//
// Mints a CryptoOrder via POST /v1/billing/crypto-checkout (V-666.C).
// Single-shot state machine — idle → loading → (ready | error). The
// component using the hook decides what to do with the returned
// payment context (today: `provider: 'stub'` + null pay_address; the
// view renders a "support will reach out" notice).
//
// No SDK method yet — fetches the endpoint directly using the
// baseUrl + apiKey from SettingsContext, mirroring useAccountCost
// (V-534.H).
//
// V-534.AY — auto-sends an Idempotency-Key (V-666.AO). The key is
// minted once per hook instance and reused across retries (i.e.
// calling start() again after a network failure replays the same
// order rather than minting a second one). Calling reset() rotates
// the key so a fresh checkout gets a fresh order.
// V-534.AZ — exposes `replayed: boolean` on the ready state, sourced
// from the `Idempotent-Replayed` response header. Views can show a
// subtle "restored from your earlier attempt" notice when true.

import { useCallback, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older test
  // shims). Not cryptographic strength, just a unique-enough token.
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface CryptoCheckoutResponse {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  status: string;
  provider: 'stub' | 'nowpayments';
  payment_address: string | null;
  pay_currency: string | null;
  created_at: string;
}

export interface UseCryptoCheckoutArgs {
  product: string;
  price_cents: number;
  price_currency: string;
}

export type CryptoCheckoutState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; order: CryptoCheckoutResponse; replayed: boolean }
  | { kind: 'error'; message: string };

export interface UseCryptoCheckoutResult {
  state: CryptoCheckoutState;
  start: (args: UseCryptoCheckoutArgs) => Promise<void>;
  reset: () => void;
}

export function useCryptoCheckout(): UseCryptoCheckoutResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoCheckoutState>({ kind: 'idle' });
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());

  const start = useCallback(
    async (args: UseCryptoCheckoutArgs): Promise<void> => {
      if (!settings.apiKey) {
        setState({ kind: 'error', message: 'No API key configured.' });
        return;
      }
      setState({ kind: 'loading' });
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/billing/crypto-checkout`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': idempotencyKeyRef.current,
          },
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          setState({ kind: 'error', message: await readApiErrorMessage(res) });
          return;
        }
        const order = (await res.json()) as CryptoCheckoutResponse;
        const replayed = res.headers.get('idempotent-replayed') === '1';
        setState({ kind: 'ready', order, replayed });
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

  const reset = useCallback(() => {
    idempotencyKeyRef.current = newIdempotencyKey();
    setState({ kind: 'idle' });
  }, []);

  return { state, start, reset };
}
