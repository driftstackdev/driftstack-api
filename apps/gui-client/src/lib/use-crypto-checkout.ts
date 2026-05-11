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

import { useCallback, useState } from 'react';
import { useSettings } from './SettingsContext';

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
  | { kind: 'ready'; order: CryptoCheckoutResponse }
  | { kind: 'error'; message: string };

export interface UseCryptoCheckoutResult {
  state: CryptoCheckoutState;
  start: (args: UseCryptoCheckoutArgs) => Promise<void>;
  reset: () => void;
}

export function useCryptoCheckout(): UseCryptoCheckoutResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoCheckoutState>({ kind: 'idle' });

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
          },
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status.toString()}` });
          return;
        }
        const order = (await res.json()) as CryptoCheckoutResponse;
        setState({ kind: 'ready', order });
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
    setState({ kind: 'idle' });
  }, []);

  return { state, start, reset };
}
