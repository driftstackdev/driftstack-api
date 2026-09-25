// Driftstack SDK client.
//
// Now that @driftstack/sdk@0.1.1 ships an isomorphic webhook helper
// (Web Crypto API instead of node:crypto, see V-029 SDK-B), the
// browser bundle resolves cleanly and we use the published SDK
// directly. The hand-written fetch wrapper that GUI2 used as a
// workaround is gone.

import { Driftstack, type Session } from '@driftstack/sdk';
import { disposeResponseBody } from './dispose-response-body';
import { record } from './log-buffer';

export type { Session };
export { DriftstackError } from '@driftstack/sdk';

export type DriftstackClient = Driftstack;

// ─── Riding out a server restart ────────────────────────────────────────────
//
// ⛔ MEASURED 2026-09-24 (owner's developer log): a production deploy restarted
// the API at 11:58:53Z, and at 11:58:45Z the Profiles poll's two reads —
// `GET /v1/sessions` and `GET /v1/profiles?limit=50` — failed with "Failed to
// fetch". What the app did with that:
//   1. the SDK retried each read 3 times, with full-jitter delays of at most
//      0.2 / 0.4 / 0.8 s — all four tries were spent inside ~1.4 s of an outage
//      that lasted several seconds (the deploy script itself allows 30 s);
//   2. EVERY try came through here and was logged as its own ERROR line;
//   3. the view then showed "Couldn't reach … firewall, or VPN", and the error
//      banner logged that as one more ERROR.
// A restart is expected and short, so a read now waits it out instead: while
// the server does not answer, idempotent reads are retried with backoff for up
// to RIDE_OUT_BUDGET_MS from the moment it stopped answering. The view sees
// either the answer (no banner at all) or, once the outage has lasted, the
// failure it would have seen before. The log gets ONE line when the server
// stops answering, ONE when it answers again, and one ERROR only if it lasts.
// The title-bar pill reads the same state (`subscribeApiReachability`).
//
// ⚠️ Only GET/HEAD are retried here. A create/launch that failed mid-restart
// may or may not have reached the server, and repeating it could do it twice;
// those keep the SDK's own rule (retried only with an Idempotency-Key).

/** How long reads wait for a server that stopped answering before the failure
 *  is shown — counted from when it STOPPED answering, shared by every request,
 *  so a long outage costs one wait, not one per request. */
export const RIDE_OUT_BUDGET_MS = 20_000;
/** Backoff between quiet retries; the last step repeats. */
export const RIDE_OUT_STEPS_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

export type ApiReachability =
  | { state: 'answering' }
  | { state: 'retrying'; since: number }
  | { state: 'down'; since: number };

const reachability = new Map<string, ApiReachability>();
const reachabilityListeners = new Set<() => void>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function setReachability(origin: string, next: ApiReachability): void {
  reachability.set(origin, next);
  for (const fn of reachabilityListeners) fn();
}

/** Current reachability of the server behind `baseUrl`. */
export function apiReachability(baseUrl: string): ApiReachability {
  return reachability.get(originOf(baseUrl)) ?? { state: 'answering' };
}

/** Subscribe to reachability changes (any server); returns an unsubscribe. */
export function subscribeApiReachability(fn: () => void): () => void {
  reachabilityListeners.add(fn);
  return () => {
    reachabilityListeners.delete(fn);
  };
}

/** The server answered (any real answer). Logs the recovery once. */
export function noteApiAnswered(url: string, now: number = Date.now()): void {
  const origin = originOf(url);
  const current = reachability.get(origin);
  if (current === undefined || current.state === 'answering') return;
  const seconds = ((now - current.since) / 1000).toFixed(1);
  record('info', [`[api] ${hostOf(origin)} is answering again after ${seconds}s`]);
  setReachability(origin, { state: 'answering' });
}

/** The server did not answer. Returns the state after this failure, logging
 *  only the transitions: one INFO when it stops answering, one ERROR when the
 *  outage outlasts the budget. `detail` names the request that saw it. */
export function noteApiUnreachable(
  url: string,
  detail: string,
  now: number = Date.now(),
): ApiReachability {
  const origin = originOf(url);
  const current = reachability.get(origin) ?? { state: 'answering' };
  if (current.state === 'answering') {
    const next: ApiReachability = { state: 'retrying', since: now };
    record('info', [
      `[api] ${hostOf(origin)} is not answering (${detail}) — retrying quietly for up to ${String(RIDE_OUT_BUDGET_MS / 1000)}s; a server restart takes a few seconds`,
    ]);
    setReachability(origin, next);
    return next;
  }
  if (current.state === 'retrying' && now - current.since >= RIDE_OUT_BUDGET_MS) {
    const next: ApiReachability = { state: 'down', since: current.since };
    record('error', [
      `[api] ${hostOf(origin)} has not answered for ${String(Math.round((now - current.since) / 1000))}s (${detail}) — showing the failure; requests keep trying and this clears when it answers`,
    ]);
    setReachability(origin, next);
    return next;
  }
  return current;
}

// ─── The most recent failed answer ──────────────────────────────────────────
//
// ErrorBanner logs every banner it shows, and until 2026-09-24 always at ERROR —
// including the ones that are an ordinary, handled answer (a name already
// taken, a validation refusal, an expired key with its own prompt). Views pass
// the banner only their sentence, so the banner asks here what the last failed
// request was: a 4xx the server answered is a WARN, anything else stays ERROR.

let lastApiFailure: { at: number; status: number } | null = null;

/** How recent a failed answer must be to explain a banner shown now. */
export const RECENT_API_FAILURE_MS = 3_000;

/** The last failed request within `withinMs`: its status, 0 for no answer. */
export function recentApiFailure(
  withinMs: number = RECENT_API_FAILURE_MS,
  now: number = Date.now(),
): { status: number } | null {
  if (lastApiFailure === null || now - lastApiFailure.at > withinMs) return null;
  return { status: lastApiFailure.status };
}

function noteApiFailure(status: number): void {
  lastApiFailure = { at: Date.now(), status };
}

/** Test seam: forget every server's state. */
export function resetApiReachabilityForTests(): void {
  lastApiFailure = null;
  reachability.clear();
  for (const fn of reachabilityListeners) fn();
}

/** A gateway answering for a server that is not up — what a restart looks like
 *  from outside. The API's own 502/503/504 are RFC 7807 problem documents and
 *  are real answers (a 503 "driver not integrated" is terminal), so those pass. */
function isRestartResponse(res: Response): boolean {
  if (![502, 503, 504, 520, 521, 522, 523, 524].includes(res.status)) return false;
  const type = res.headers.get('content-type') ?? '';
  return !type.includes('application/problem+json');
}

function isAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted === true) return true;
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/** The abort reason as an Error, as the SDK's own abort handling expects. */
function abortReason(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

function abortableSleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// W609 — Dev Logs productivity: a FAILING API call is mirrored into the in-app
// log buffer (lib/log-buffer), because views render friendly banners that never
// touch console.*. Success responses are NOT logged (a poll would flood the
// 500-entry buffer); failures are rare + load-bearing. Levels: a 5xx the server
// answered is ERROR; a 4xx is WARN — the caller handles most of them (a 404 on
// an optional endpoint, a 409, an expired key that gets its own banner), and an
// ERROR per handled answer buried the real ones.
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = (() => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  })();
  const quiet = method === 'GET' || method === 'HEAD';
  const signal = init?.signal;
  for (let attempt = 0; ; attempt += 1) {
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await globalThis.fetch(input, init);
    } catch (e) {
      err = e;
    }
    if (res === undefined && isAbort(err, signal)) throw err;
    if (res !== undefined && !isRestartResponse(res)) {
      noteApiAnswered(url);
      if (!res.ok) {
        noteApiFailure(res.status);
        record(res.status >= 500 ? 'error' : 'warn', [
          `[api] ${method} ${url} → ${String(res.status)} ${res.statusText}`.trimEnd(),
        ]);
      }
      return res;
    }
    const what =
      res === undefined
        ? `${method} ${path} → network failure: ${String(err)}`
        : `${method} ${path} → ${String(res.status)} from the gateway`;
    const state = noteApiUnreachable(url, what);
    if (!quiet || state.state === 'down') {
      noteApiFailure(0);
      // Not retried here: the SDK and the view take it from here. While the
      // server is down the ERROR above already said so — one line, not one per
      // request. A write is logged: it is an action that did not happen.
      if (!quiet) record('warn', [`[api] ${what} (not retried: it may not be safe to repeat)`]);
      if (res !== undefined) return res;
      throw err;
    }
    if (res !== undefined) await disposeResponseBody(res);
    const step = RIDE_OUT_STEPS_MS[Math.min(attempt, RIDE_OUT_STEPS_MS.length - 1)] ?? 4_000;
    await abortableSleep(step, signal);
  }
}

// ─── The server refused this app's own key ─────────────────────────────────
//
// Owner decision 2026-09-24: when the server says the app's key is REVOKED or
// not recognised, the app signs out with a clear message instead of leaving
// every screen failing behind a banner. Only on that confirmed answer: a 401
// whose RFC 7807 `type` is one of the two below. A network failure, a timeout,
// a 5xx, a gateway page, a bare 401 or any other problem type is never a reason
// to sign anyone out — the key may be fine and the server merely unreachable.

/** The problem types that mean "this key will never work again". */
export const KEY_REFUSED_PROBLEM_TYPES: Readonly<Record<string, KeyRefusalReason>> = {
  'https://errors.driftstack.dev/revoked-key': 'revoked',
  'https://errors.driftstack.dev/invalid-key': 'invalid',
};

export type KeyRefusalReason = 'revoked' | 'invalid';

export interface KeyRefusal {
  /** The key the refused request carried — the listener compares it with the
   *  key the app holds NOW, so a late answer for a replaced key is ignored. */
  apiKey: string;
  /** The server that refused it, without a trailing slash. */
  baseUrl: string;
  reason: KeyRefusalReason;
}

const keyRefusalListeners = new Set<(refusal: KeyRefusal) => void>();

/** Subscribe to confirmed key refusals; returns an unsubscribe. */
export function subscribeKeyRefused(fn: (refusal: KeyRefusal) => void): () => void {
  keyRefusalListeners.add(fn);
  return () => {
    keyRefusalListeners.delete(fn);
  };
}

/** The refusal a response carries, or null. Reads a CLONE, so the caller's
 *  body is untouched; any doubt (not 401, not a problem document, unreadable,
 *  another type) is null. */
export async function keyRefusalOf(res: Response): Promise<KeyRefusalReason | null> {
  if (res.status !== 401) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/problem+json')) return null;
  try {
    const text = await res.clone().text();
    if (text.length > 16_384) return null;
    const body = JSON.parse(text) as { type?: unknown };
    return typeof body.type === 'string' ? (KEY_REFUSED_PROBLEM_TYPES[body.type] ?? null) : null;
  } catch {
    return null;
  }
}

export function buildClient(
  apiKey: string | null,
  baseUrl: string,
  /** Workspace half-2: a team owner's account id scopes every request via
   *  the SDK's effectiveAccount option (X-Driftstack-Account). Null =
   *  personal workspace. */
  effectiveAccount: string | null = null,
  /** Fired when any API call returns 401 with a key SET — i.e. the key expired
   *  or was revoked mid-session. Lets SettingsContext surface ONE central
   *  re-auth prompt instead of every view rendering its own 401 copy. */
  onUnauthorized?: () => void,
): DriftstackClient | null {
  if (apiKey === null || apiKey.length === 0) return null;
  const base = baseUrl.replace(/\/+$/, '');
  // Layer a 401 observer over apiFetch — pure pass-through (returns the
  // same Response), it only NOTIFIES on an expired/revoked key mid-session,
  // and, on a confirmed refusal of this key, tells the shell (see above).
  const authFetch: typeof fetch = (input, init) =>
    apiFetch(input, init).then((res) => {
      if (res.status === 401) {
        onUnauthorized?.();
        if (keyRefusalListeners.size > 0) {
          void keyRefusalOf(res).then((reason) => {
            if (reason === null) return;
            record('warn', [
              `[api] ${hostOf(originOf(base))} refused this app's key (${reason}) — signing out`,
            ]);
            for (const fn of keyRefusalListeners) fn({ apiKey, baseUrl: base, reason });
          });
        }
      }
      return res;
    });
  return new Driftstack({
    apiKey,
    baseUrl: base,
    fetch: authFetch,
    ...(effectiveAccount !== null ? { effectiveAccount } : {}),
  });
}
