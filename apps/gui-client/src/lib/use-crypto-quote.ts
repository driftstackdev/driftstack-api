// V-534.V — useCryptoQuote hook.
//
// Wraps POST /v1/billing/crypto-checkout/quote (V-666.H) for the GUI
// checkout flow. Given a tier product + optional fiat currency, returns
// the price preview without minting an order. Re-fetches automatically
// when product or currency changes; supports manual mode for views that
// want to gate the request behind a button.

import { useCallback, useEffect, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { useSettings } from './SettingsContext';

export interface CryptoQuoteData {
  product: string;
  price_cents: number;
  price_currency: string;
  provider: string;
  pay_currency: string | null;
  pay_min_amount: number | null;
  pay_max_amount: number | null;
}

export type CryptoQuoteState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: CryptoQuoteData }
  | { kind: 'error'; message: string };

export interface UseCryptoQuoteOpts {
  /** Tier product to quote. null = no fetch; result stays idle. */
  product: string | null;
  /** Optional fiat currency override. Defaults to the server's EUR. */
  priceCurrency?: string;
  /** Disable auto-fetch on mount + on dependency change. Default false. */
  manual?: boolean;
}

export interface UseCryptoQuoteResult {
  state: CryptoQuoteState;
  refetch: () => Promise<void>;
}

export function useCryptoQuote(opts: UseCryptoQuoteOpts): UseCryptoQuoteResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoQuoteState>(
    opts.manual === true || opts.product === null ? { kind: 'idle' } : { kind: 'loading' },
  );

  const fetcher = useCallback(async (): Promise<void> => {
    if (opts.product === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const baseUrl = settings.baseUrl.replace(/\/+$/, '');
      const body: Record<string, string> = { product: opts.product };
      if (opts.priceCurrency !== undefined) {
        body.price_currency = opts.priceCurrency;
      }
      const res = await fetch(`${baseUrl}/v1/billing/crypto-checkout/quote`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(res) });
        return;
      }
      const parsed = (await res.json()) as CryptoQuoteData;
      setState({ kind: 'ready', data: parsed });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [opts.product, opts.priceCurrency, settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (opts.manual === true) return;
    if (opts.product === null) return;
    void fetcher();
  }, [fetcher, opts.manual, opts.product]);

  return { state, refetch: fetcher };
}
