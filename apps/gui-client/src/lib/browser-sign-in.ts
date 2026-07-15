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
import { parseDeepLink } from './deep-link';
import { diagnosticFetchError } from './diagnostic-fetch-error';
import { humanizeError } from './humanize-error';
import { disposeResponseBody } from './dispose-response-body';
import { readApiErrorMessage } from './api-errors';
import { readBoundedApiJson } from './read-bounded-json';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface InitiateResponse {
  code: string;
  user_code: string;
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
  | { kind: 'waiting'; code: string; userCode: string; state: string; expiresAt: number }
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
  /** Test-only: override the per-request network deadline. */
  __requestTimeoutMs?: number;
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
  const activeControllersRef = useRef<Set<AbortController>>(new Set());
  const pollInFlightRef = useRef(false);
  // Once the flow reaches a terminal state (success / error / cancel /
  // unmount / timeout) stop() flips this. Any exchange response still
  // in-flight then becomes a no-op — so a late 2s-poll can't overwrite a
  // success with a spurious "Authorization expired" error (the deep-link
  // fast-path consumes the one-shot code, so an in-flight poll that lands
  // after it sees the code already gone), and a late "bound" can't sign
  // the customer in after they cancelled.
  const settledRef = useRef(false);

  const fetchWithDeadline = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    activeControllersRef.current.add(controller);
    let timeout: number | null = null;
    const cleanup = (): void => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      activeControllersRef.current.delete(controller);
      controller.signal.removeEventListener('abort', cleanup);
    };
    controller.signal.addEventListener('abort', cleanup, { once: true });
    timeout = window.setTimeout(
      () => controller.abort(),
      opts.__requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      cleanup();
      throw error;
    }
  };

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
    for (const controller of activeControllersRef.current) controller.abort();
    activeControllersRef.current.clear();
    pollInFlightRef.current = false;
    settledRef.current = true;
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
    settledRef.current = false; // re-arm for a fresh attempt
    setState({ kind: 'opening' });
    const trimmedUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    const stateToken = generateBrowserSignInState();
    try {
      const initiateRes = await fetchWithDeadline(`${trimmedUrl}/v1/auth/cli-authorize/initiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: stateToken,
          client_label: opts.clientLabel ?? `Driftstack desktop on ${navigator.platform}`,
        }),
      });
      if (!initiateRes.ok) {
        // Problem prose is remote diagnostic input. Only stable type/status
        // crosses the installed-client copy boundary.
        throw Object.assign(new Error(await readApiErrorMessage(initiateRes)), {
          customerSafe: true,
        });
      }
      const initiate = await readBoundedApiJson<InitiateResponse>(initiateRes);
      if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(initiate.user_code)) {
        throw Object.assign(
          new Error(
            'This server does not support secure browser sign-in. Update the server and desktop app together, or paste an API key.',
          ),
          { customerSafe: true },
        );
      }
      await openInBrowser(initiate.browser_url);

      // If the user cancelled (Cancel / "paste a key instead") during the
      // awaits above, stop() already ran (settledRef=true, refs nulled). Bail
      // BEFORE re-arming the poll/timeout/deep-link listener + flipping the UI
      // back to 'waiting' — otherwise we'd leak timers + a listener nothing
      // clears until the 5-min backstop (and compound on a restart).
      if (settledRef.current) {
        deepLinkUnlistenRef.current?.();
        return;
      }

      const expiresAt = new Date(initiate.expires_at).getTime();
      setState({
        kind: 'waiting',
        code: initiate.code,
        userCode: initiate.user_code,
        state: stateToken,
        expiresAt,
      });

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
      if (settledRef.current) return;
      // 2026-05-20 — surface a multi-line diagnostic for network
      // failures (Tauri WebKit "Load failed" / Chrome "Failed to fetch"
      // etc.) instead of the bare error.message. The browser sign-in
      // path is often the first network call a new customer makes;
      // an opaque "Load failed" gives them no path forward.
      const diag = diagnosticFetchError(err, trimmedUrl);
      const customerSafeMessage =
        err instanceof Error && (err as Error & { customerSafe?: boolean }).customerSafe === true
          ? err.message
          : null;
      setState({
        kind: 'error',
        message:
          diag ??
          customerSafeMessage ??
          humanizeError(err, 'Failed to start browser sign-in. Check Settings and try again.'),
      });
    }
  }

  // Handle a deep-link URL via the shared parser (V-534.A). Mismatched
  // state or non-cli-authorize payloads → silent skip; the poll loop
  // continues as the fallback path.
  async function handleDeepLink(
    rawUrl: string,
    serverUrl: string,
    expectedCode: string,
    expectedState: string,
  ): Promise<void> {
    const result = parseDeepLink(rawUrl);
    if (!result.ok) return;
    if (result.payload.kind !== 'cli-authorize') return;
    if (result.payload.code !== expectedCode || result.payload.state !== expectedState) return;
    await pollOnce(serverUrl, expectedCode, expectedState);
  }

  async function pollOnce(serverUrl: string, code: string, stateToken: string): Promise<void> {
    if (pollInFlightRef.current || settledRef.current) return;
    pollInFlightRef.current = true;
    try {
      const res = await fetchWithDeadline(`${serverUrl}/v1/auth/cli-authorize/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state: stateToken }),
      });
      // The flow may have terminated (success / cancel / unmount /
      // timeout) while this exchange was in-flight — drop the late
      // response so it can't overwrite the settled state.
      if (settledRef.current) {
        await disposeResponseBody(res);
        return;
      }
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          stop();
          setState({
            kind: 'error',
            message: await readApiErrorMessage(res),
          });
        } else {
          await disposeResponseBody(res);
        }
        return;
      }
      const body = await readBoundedApiJson<ExchangeResponse>(res);
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
        try {
          await opts.onSuccess(body.api_key, body.account_id);
        } catch (error) {
          setState({
            kind: 'error',
            message: humanizeError(
              error,
              "Authorized, but the API key couldn't be saved. Check system credential access and try again.",
            ),
          });
          return;
        }
        setState({ kind: 'success' });
      }
    } catch {
      // network blip — silent retry
    } finally {
      pollInFlightRef.current = false;
    }
  }

  return { state, start, cancel };
}
