// W470.B — drift guard for apps/gui-client/src/lib/use-cancel-order.ts.
// V-534.Y useCancelOrder action hook. Drift here either breaks
// the failed-state preservation of orderId (the UI confirmation
// can't tell which order failed to cancel because the state
// loses the original orderId) or drops the reset() function
// (modal can't return to idle for the next cancel attempt and
// shows stale state across orders).
//
//   • V-534.Y framing pinned: 'useCancelOrder hook.' + 'Action
//     hook (not a fetch-on-mount hook) that wraps POST
//     /v1/billing/crypto-orders/:id/cancel (V-666.J). Returns a
//     state machine: idle → submitting → succeeded | failed.
//     Caller invokes `cancel(orderId)` to fire the request.
//     `reset()` returns to idle so the same hook instance can be
//     reused across multiple orders.'
//   • CancelOrderState 4-variant union: idle | submitting{orderId}
//     | succeeded{order: CryptoOrderData} | failed{orderId +
//     status + message}.
//   • UseCancelOrderResult 3-method (state + cancel(orderId) +
//     reset()).
//   • No-apiKey → failed{status:0, message:'No API key configured.'}.
//   • Fetch: trailing-slash strip + POST + Bearer + accept JSON +
//     no Content-Type (no body) + URL `${baseUrl}/v1/billing/
//     crypto-orders/${orderId}/cancel`.
//   • !res.ok → failed{status: res.status, message:
//     readApiErrorMessage}; res.ok → ready{order: CryptoOrderData}.
//   • catch → failed{status:0, message: err.message fallback}.
//   • reset useCallback: setState({kind:'idle'}) + empty deps.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-cancel-order.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W470.B apps/gui-client/src/lib/use-cancel-order.ts content parity', () => {
  const body = read(LIB);

  it("V-534.Y framing pinned: 'V-534.Y — useCancelOrder hook.' + 'Action hook (not a fetch-on-mount hook) that wraps POST /v1/billing/crypto-orders/:id/cancel (V-666.J). Returns a state machine: idle → submitting → succeeded | failed. Caller invokes `cancel(orderId)` to fire the request. `reset()` returns to idle so the same hook instance can be reused across multiple orders.'", () => {
    expect(body).toMatch(/\/\/ V-534\.Y — useCancelOrder hook\./);
    expect(body).toMatch(
      /\/\/ Action hook \(not a fetch-on-mount hook\) that wraps\s*\n?\s*\/\/ POST \/v1\/billing\/crypto-orders\/:id\/cancel \(V-666\.J\)\. Returns a state\s*\n?\s*\/\/ machine: idle → submitting → succeeded \| failed\. Caller invokes\s*\n?\s*\/\/ `cancel\(orderId\)` to fire the request\. `reset\(\)` returns to idle so\s*\n?\s*\/\/ the same hook instance can be reused across multiple orders\./,
    );
  });

  it("Imports lifecycle hooks + shared deadline + readApiErrorMessage + useSettings + type CryptoOrderData from './use-crypto-order'", () => {
    expect(body).toMatch(/import \{ useCallback, useEffect, useRef, useState \} from 'react';/);
    expect(body).toMatch(/import \{ readApiErrorMessage \} from '\.\/api-errors';/);
    expect(body).toMatch(/import \{ fetchWithDeadline \} from '\.\/fetch-with-deadline';/);
    expect(body).toMatch(/import \{ useSettings \} from '\.\/SettingsContext';/);
    expect(body).toMatch(/import type \{ CryptoOrderData \} from '\.\/use-crypto-order';/);
  });

  it("CancelOrderState 4-variant union: idle | submitting{orderId} | succeeded{order: CryptoOrderData} | failed{orderId + status + message} — orderId preserved through submitting/failed for UI 'which order failed' reference", () => {
    expect(body).toMatch(
      /export type CancelOrderState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'submitting'; orderId: string \}\s*\n?\s*\| \{ kind: 'succeeded'; order: CryptoOrderData \}\s*\n?\s*\| \{ kind: 'failed'; orderId: string; status: number; message: string \};/,
    );
  });

  it('UseCancelOrderResult: 3-method (state + cancel(orderId): Promise<void> + reset(): void) — cancel is action, reset is sync', () => {
    expect(body).toMatch(
      /export interface UseCancelOrderResult \{\s*\n?\s*state: CancelOrderState;\s*\n?\s*cancel: \(orderId: string\) => Promise<void>;\s*\n?\s*reset: \(\) => void;\s*\n?\s*\}/,
    );
  });

  it("Initial state: {kind:'idle'} (NOT manual?-aware — action hook starts idle); no-apiKey → failed{orderId, status:0, message:'No API key configured.'}", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<CancelOrderState>\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{\s*\n?\s*kind: 'failed',\s*\n?\s*orderId,\s*\n?\s*status: 0,\s*\n?\s*message: 'No API key configured\.',\s*\n?\s*\}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('Request: setState submitting{orderId} pre-fetch + trailing-slash strip + POST `${baseUrl}/v1/billing/crypto-orders/${orderId}/cancel` + Bearer + accept JSON (NO Content-Type since no body)', () => {
    expect(body).toMatch(/setState\(\{ kind: 'submitting', orderId \}\);/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{orderId\}\/cancel`,\s*\{\s*method: 'POST',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*accept: 'application\/json',\s*\},\s*\},\s*\);/,
    );
  });

  it('!res.ok → failed{orderId, status: res.status, message: readApiErrorMessage}; res.ok → succeeded{order: body as CryptoOrderData}; catch → failed{orderId, status: 0, message: instance-of-Error fallback}', () => {
    expect(body).toMatch(/const message = await readApiErrorMessage\(res\);/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) \{\s*setState\(\{ kind: 'failed', orderId, status: res\.status, message \}\);/,
    );
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'succeeded', order: body \}\);/,
    );
    expect(body).toMatch(/Cancellation timed out\. Check your connection and try again\./);
  });

  it('keeps cancel dependencies and makes reset/unmount abort and invalidate active work', () => {
    expect(body).toMatch(/\[settings\.apiKey, settings\.baseUrl\],\s*\n?\s*\);/);
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /const reset = useCallback\(\(\): void => \{[\s\S]*?requestRef\.current\?\.abort\(\);[\s\S]*?setState\(\{ kind: 'idle' \}\);/,
    );
    expect(body).toMatch(/useEffect\([\s\S]*?requestRef\.current\?\.abort\(\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
