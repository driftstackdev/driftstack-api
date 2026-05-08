// V-274 — Shared browser-OAuth-sign-in state machine.
//
// V-328 — extended with deep-link primary path. When the dashboard
// completion page redirects to driftstack://auth/callback?code=...&
// state=..., the OS hands off to this app and the deep-link listener
// fires synchronously. The 2s polling loop stays as a FALLBACK for
// platforms / installs where the URL scheme registration didn't
// take (e.g. Linux without a desktop env, Windows without HKCU
// write access). Both paths converge on the same setState path.
//
// Caller passes:
//   - baseUrl: the configured control-plane origin
//   - clientLabel: human-readable label that appears on the
//     dashboard's confirmation screen
//   - onSuccess: called with the issued plaintext key + accountId
//
// The hook returns the current state + start/cancel callbacks.

import { useEffect, useRef, useState } from 'react';
import { open as openInBrowser } from '@tauri-apps/plugin-shell';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

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
  /**
   * V-328 test seam: override the deep-link listener registration so
   * unit tests can simulate a deep-link arrival without booting the
   * Tauri runtime. Production passes undefined and the real
   * `@tauri-apps/plugin-deep-link.onOpenUrl` is used.
   */
  __onOpenUrl?: (handler: (urls: string[]) => void) => Promise<() => void>;
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
  // V-328 — handle returned by onOpenUrl(). Calling it removes the
  // listener; we call it on stop() and on unmount to keep the
  // deep-link channel from stacking up when the customer retries.
  const deepLinkUnlistenRef = useRef<(() => void) | null>(null);

  const stop = (): void => {
    if (pollHandleRef.current !== null) {
      window.clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    }
    if (timeoutHandleRef.current !== null) {
      window.clearTimeout(timeoutHandleRef.current);
      timeoutHandleRef.current = null;
    }
    if (deepLinkUnlistenRef.current !== null) {
      try {
        deepLinkUnlistenRef.current();
      } catch {
        /* swallow — the listener may have already been torn down */
      }
      deepLinkUnlistenRef.current = null;
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

      // V-328 — register the deep-link listener BEFORE arming the
      // poll so a fast OS hand-off (sub-second) is captured. The
      // dashboard /auth/cli-callback page is expected to redirect to
      // driftstack://auth/callback?code=<code>&state=<state>; the
      // handler validates state matches stateToken (CSRF guard) and
      // then runs the same exchange logic the poll path runs.
      try {
        const onUrl = opts.__onOpenUrl ?? onOpenUrl;
        const unlisten = await onUrl((urls) => {
          for (const url of urls) {
            void handleDeepLink(url, trimmedUrl, initiate.code, stateToken);
          }
        });
        deepLinkUnlistenRef.current = unlisten;
      } catch {
        // Plugin not available (Tauri version mismatch / dev runtime
        // without the plugin) → silent fallback to polling-only.
      }

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

  /**
   * V-328 — handle a deep-link URL of shape
   *   driftstack://auth/callback?code=<code>&state=<state>
   * Validates state + code match the in-flight authorization
   * (CSRF + cross-tab guard) and runs the same exchange the polling
   * path runs. Mismatched state → silent skip (the deep-link is for
   * a stale session; the poll loop continues).
   */
  async function handleDeepLink(
    rawUrl: string,
    serverUrl: string,
    expectedCode: string,
    expectedState: string,
  ): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'driftstack:') return;
    if (parsed.host !== 'auth') return;
    if (!parsed.pathname.startsWith('/callback')) return;
    const code = parsed.searchParams.get('code');
    const incomingState = parsed.searchParams.get('state');
    if (code !== expectedCode || incomingState !== expectedState) return;
    // Reuse the polling exchange — same endpoint, same response shape.
    await pollOnce(serverUrl, expectedCode, expectedState);
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
