// V-274 — Shared browser-OAuth-sign-in state machine.
//
// Extracted from FirstRunWizard's V-268 ApiKeyStep so SettingsView
// can reuse the same flow (post-sign-out re-authorization without
// restarting the app).
//
// Caller passes:
//   - baseUrl: the configured control-plane origin
//   - clientLabel: human-readable label that appears on the
//     dashboard's confirmation screen
//   - onSuccess: called with the issued plaintext key + accountId
//
// The hook returns the current state + start/cancel callbacks.
//
// Pure logic; no React DOM. Cross-platform (no Tauri-specific bits
// except `@tauri-apps/plugin-shell`'s `open()` for the browser hand-
// off, which is the same plugin V-268 already wired).

import { useEffect, useRef, useState } from 'react';
import { open as openInBrowser } from '@tauri-apps/plugin-shell';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface InitiateResponse {
  code: string;
  browser_url: string;
  expires_at: string;
}

interface ExchangeResponse {
  status: 'pending' | 'bound' | 'expired';
  api_key?: string;
  account_id?: string;
}

export type BrowserSignInState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'waiting'; code: string; state: string; expiresAt: number }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export interface UseBrowserSignInOptions {
  baseUrl: string;
  clientLabel?: string;
  onSuccess: (apiKey: string, accountId: string) => void | Promise<void>;
  /** Test-only: override the 2s poll cadence. */
  __pollIntervalMs?: number;
  /** Test-only: override the 5-minute backstop. */
  __pollTimeoutMs?: number;
}

export interface UseBrowserSignInResult {
  state: BrowserSignInState;
  start: () => void;
  cancel: () => void;
}

export function generateBrowserSignInState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function useBrowserSignIn(opts: UseBrowserSignInOptions): UseBrowserSignInResult {
  const [state, setState] = useState<BrowserSignInState>({ kind: 'idle' });
  const pollHandleRef = useRef<number | null>(null);
  const timeoutHandleRef = useRef<number | null>(null);

  const stop = (): void => {
    if (pollHandleRef.current !== null) {
      window.clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    }
    if (timeoutHandleRef.current !== null) {
      window.clearTimeout(timeoutHandleRef.current);
      timeoutHandleRef.current = null;
    }
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => stop();
  }, []);

  const cancel = (): void => {
    stop();
    setState({ kind: 'idle' });
  };

  const start = (): void => {
    void run();
  };

  async function run(): Promise<void> {
    setState({ kind: 'opening' });
    const trimmedUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    const stateToken = generateBrowserSignInState();
    try {
      const initiateRes = await fetch(`${trimmedUrl}/v1/auth/cli-authorize/initiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: stateToken,
          client_label: opts.clientLabel ?? `Driftstack desktop on ${navigator.platform}`,
        }),
      });
      if (!initiateRes.ok) {
        const body = (await initiateRes.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? `HTTP ${initiateRes.status.toString()}`);
      }
      const initiate = (await initiateRes.json()) as InitiateResponse;
      await openInBrowser(initiate.browser_url);

      const expiresAt = new Date(initiate.expires_at).getTime();
      setState({ kind: 'waiting', code: initiate.code, state: stateToken, expiresAt });

      pollHandleRef.current = window.setInterval(() => {
        void pollOnce(trimmedUrl, initiate.code, stateToken);
      }, opts.__pollIntervalMs ?? POLL_INTERVAL_MS);
      timeoutHandleRef.current = window.setTimeout(() => {
        stop();
        setState({
          kind: 'error',
          message: 'Authorization expired. Click "Sign in with browser" to try again.',
        });
      }, opts.__pollTimeoutMs ?? POLL_TIMEOUT_MS);
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to start browser sign-in.',
      });
    }
  }

  async function pollOnce(serverUrl: string, code: string, stateToken: string): Promise<void> {
    try {
      const res = await fetch(`${serverUrl}/v1/auth/cli-authorize/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state: stateToken }),
      });
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          stop();
          const body = (await res.json().catch(() => ({}))) as { detail?: string };
          setState({
            kind: 'error',
            message: body.detail ?? 'Authorization request rejected.',
          });
        }
        return;
      }
      const body = (await res.json()) as ExchangeResponse;
      if (body.status === 'pending') return;
      if (body.status === 'expired') {
        stop();
        setState({
          kind: 'error',
          message: 'Authorization expired. Click "Sign in with browser" to try again.',
        });
        return;
      }
      if (body.status === 'bound' && body.api_key && body.account_id) {
        stop();
        setState({ kind: 'success' });
        await opts.onSuccess(body.api_key, body.account_id);
      }
    } catch {
      // network blip — silent retry
    }
  }

  return { state, start, cancel };
}
