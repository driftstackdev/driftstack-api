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
// GUI audit #9 — PKCE (RFC 7636, S256). `code` and `state` are readable in
// the sign-in link and in the driftstack:// hand-off, so they must not be
// enough to collect the key. Each attempt makes a fresh `code_verifier` that
// lives only in this closure: initiate sends its SHA-256 as `code_challenge`,
// and every exchange — poll or deep link — sends the verifier in the POST
// body. It is never put in a URL, in React state, or in storage.
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
import { isSlowDown, retryAfterMs } from './retry-after';

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

/** Driftstack's own cloud API, and the dashboard origins its sign-in page lives on. */
const CLOUD_API_HOST = 'api.driftstack.dev';
const CLOUD_DASHBOARD_HOSTS: ReadonlySet<string> = new Set([
  'app.driftstack.io',
  'app.driftstack.dev',
]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * GUI audit #14 — is `browserUrl` this deployment's sign-in page for THIS flow?
 *
 * The URL comes from the server's /initiate answer and is opened in the default
 * browser. The shell plugin's capability URL list is never consulted (its `open`
 * takes no scope), so this is the check: it must carry the code the server just
 * issued, be https (or loopback http for a local server), have no credentials in
 * it, and — on Driftstack's own cloud — be the dashboard's `/cli/authorize`. A
 * self-hosted server names its own dashboard host, so only the scheme and the
 * code are required there.
 */
export function isThisFlowsSignInPage(
  browserUrl: string,
  apiBaseUrl: string,
  code: string,
): boolean {
  let page: URL;
  let api: URL;
  try {
    page = new URL(browserUrl);
    api = new URL(apiBaseUrl);
  } catch {
    return false;
  }
  if (page.username !== '' || page.password !== '') return false;
  if (page.searchParams.get('code') !== code) return false;
  if (page.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(page.hostname) && LOOPBACK_HOSTS.has(api.hostname);
  }
  if (page.protocol !== 'https:') return false;
  if (api.hostname === CLOUD_API_HOST) {
    return (
      CLOUD_DASHBOARD_HOSTS.has(page.hostname) &&
      page.port === '' &&
      page.pathname.replace(/\/+$/, '') === '/cli/authorize'
    );
  }
  return true;
}

export function generateBrowserSignInState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 §4.1 — 32 random bytes, base64url: a 43-character verifier. */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** RFC 7636 §4.2 S256 — BASE64URL(SHA-256(ASCII(code_verifier))), unpadded. */
export async function s256CodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64Url(new Uint8Array(digest));
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
  // GUI audit #8 — the earliest moment the next exchange poll may go out. A 429
  // (the pre-login per-IP limit, shared by every desktop and CLI behind one
  // address) pushes it back by the server's Retry-After; the flow keeps waiting
  // until its own deadline instead of abandoning a key the user already approved.
  const nextPollAtRef = useRef(0);

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
    nextPollAtRef.current = 0;
    setState({ kind: 'opening' });
    const trimmedUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    const stateToken = generateBrowserSignInState();
    // GUI audit #9 — stays in this closure; only its hash leaves the app.
    const codeVerifier = generateCodeVerifier();
    try {
      const codeChallenge = await s256CodeChallenge(codeVerifier);
      const initiateRes = await fetchWithDeadline(`${trimmedUrl}/v1/auth/cli-authorize/initiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: stateToken,
          client_label: opts.clientLabel ?? `Driftstack desktop on ${navigator.platform}`,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
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
      if (!isThisFlowsSignInPage(initiate.browser_url, trimmedUrl, initiate.code)) {
        throw Object.assign(
          new Error(
            "The server's sign-in page address wasn't one this app expects, so it wasn't opened. Check the server address in Settings, or paste an API key instead.",
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
            void handleDeepLink(url, trimmedUrl, initiate.code, stateToken, codeVerifier);
          }
        });
        deepLinkUnlistenRef.current = unlisten;
      } catch {
        // Plugin not available (Tauri version mismatch / dev runtime
        // without the plugin) → silent fallback to polling-only.
      }

      pollHandleRef.current = window.setInterval(() => {
        void pollOnce(trimmedUrl, initiate.code, stateToken, codeVerifier);
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
  // continues as the fallback path. The hand-off is only a "poll now"
  // signal: the exchange it triggers still carries this attempt's verifier,
  // which the hand-off never contained.
  async function handleDeepLink(
    rawUrl: string,
    serverUrl: string,
    expectedCode: string,
    expectedState: string,
    codeVerifier: string,
  ): Promise<void> {
    const result = parseDeepLink(rawUrl);
    if (!result.ok) return;
    if (result.payload.kind !== 'cli-authorize') return;
    if (result.payload.code !== expectedCode || result.payload.state !== expectedState) return;
    await pollOnce(serverUrl, expectedCode, expectedState, codeVerifier);
  }

  async function pollOnce(
    serverUrl: string,
    code: string,
    stateToken: string,
    codeVerifier: string,
  ): Promise<void> {
    if (pollInFlightRef.current || settledRef.current) return;
    if (Date.now() < nextPollAtRef.current) return; // still inside a Retry-After
    pollInFlightRef.current = true;
    try {
      const res = await fetchWithDeadline(`${serverUrl}/v1/auth/cli-authorize/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state: stateToken, code_verifier: codeVerifier }),
      });
      // The flow may have terminated (success / cancel / unmount /
      // timeout) while this exchange was in-flight — drop the late
      // response so it can't overwrite the settled state.
      if (settledRef.current) {
        await disposeResponseBody(res);
        return;
      }
      if (!res.ok) {
        if (isSlowDown(res)) {
          // GUI audit #8 — "slow down", not "no": wait the server's Retry-After
          // (never less than our own cadence) and keep polling. The flow's
          // deadline still ends it if the wait outlasts the authorization.
          const interval = opts.__pollIntervalMs ?? POLL_INTERVAL_MS;
          nextPollAtRef.current = Date.now() + Math.max(retryAfterMs(res) ?? 0, interval);
          await disposeResponseBody(res);
          return;
        }
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
