// V-534.AA — useCryptoReceipt hook.
//
// Wraps GET /v1/billing/crypto-orders/:id/receipt (V-666.M) for the
// GUI receipt-view. Fetch-on-mount when an orderId is supplied; idle
// when orderId is null. Refetch() supported for re-renders after
// payment confirms.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { humanizeError } from './humanize-error';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

export interface CryptoReceiptData {
  order_id: string;
  issued_at: string;
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  paid_at: string | null;
  created_at: string;
}

export type CryptoReceiptState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: CryptoReceiptData }
  | { kind: 'error'; message: string };

export interface UseCryptoReceiptOpts {
  manual?: boolean;
}

export interface UseCryptoReceiptResult {
  state: CryptoReceiptState;
  refetch: () => Promise<void>;
}

export function useCryptoReceipt(
  orderId: string | null,
  opts: UseCryptoReceiptOpts = {},
): UseCryptoReceiptResult {
  const { settings } = useSettings();
  const [state, setState] = useState<CryptoReceiptState>(
    opts.manual === true || orderId === null ? { kind: 'idle' } : { kind: 'loading' },
  );
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const sequenceRef = useRef(0);

  const fetcher = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    if (orderId === null) {
      setState({ kind: 'idle' });
      return;
    }
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
      const res = await fetchWithDeadline(
        `${baseUrl}/v1/billing/crypto-orders/${encodeURIComponent(orderId)}/receipt`,
        {
          method: 'GET',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        const message = await readApiErrorMessage(res);
        if (sequence === sequenceRef.current) setState({ kind: 'error', message });
        return;
      }
      const body = await readBoundedApiJson<CryptoReceiptData>(res);
      if (sequence === sequenceRef.current) setState({ kind: 'ready', data: body });
    } catch (err) {
      if (sequence === sequenceRef.current) {
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Receipt request timed out. Check your connection and try again.'
              : humanizeError(err, "Couldn't load the receipt. Try again."),
        });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        inFlightRef.current = false;
      }
    }
  }, [orderId, settings.apiKey, settings.baseUrl]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [orderId, settings.apiKey, settings.baseUrl],
  );

  useEffect(() => {
    if (opts.manual === true) return;
    if (orderId === null) return;
    void fetcher();
  }, [fetcher, opts.manual, orderId]);

  return { state, refetch: fetcher };
}

/**
 * Build a multi-line plain-text receipt suitable for clipboard copy
 * or PDF generation. Pure function; takes the receipt + a vendor
 * label as input so the formatting decision lives next to the hook
 * rather than the caller.
 */
export function formatReceiptForClipboard(
  receipt: CryptoReceiptData,
  vendor = 'Driftstack',
): string {
  const lines = [
    `${vendor} receipt`,
    '',
    `Order: ${receipt.order_id}`,
    `Issued: ${receipt.issued_at}`,
    `Status: ${receipt.status}`,
    `Product: ${receipt.product}`,
    `Amount: ${(receipt.price_cents / 100).toFixed(2)} ${receipt.price_currency}`,
  ];
  if (receipt.paid_at !== null) lines.push(`Paid at: ${receipt.paid_at}`);
  if (receipt.payment_id !== null) lines.push(`Payment id: ${receipt.payment_id}`);
  lines.push(`Created: ${receipt.created_at}`);
  return lines.join('\n');
}
