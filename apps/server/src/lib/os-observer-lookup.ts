// N-2 — passive OS fingerprint of a proxy's OWN TCP stack: the lookup half.
//
// A SOCKS5/HTTP proxy opens its own TCP connection to the destination, so the
// SYN the destination sees was built by the PROXY HOST's kernel — and the
// fields that identify a stack (TTL, window, MSS, window scale, option ORDER)
// exist only in that SYN. No socket API returns them once the handshake is
// done, so the control plane cannot read them itself. A raw-socket observer on
// the origin (`/opt/driftstack/os-observer`, listening on DS_OS_OBSERVER_PORT)
// records the last SYN per source address; this module fetches that record
// over loopback and turns it into the classifier's `TcpSynSignature`.
//
// ⛔ Absence is a first-class answer. The observer returns 404 for an address
// it has not seen (or saw too long ago), and this returns `absent` for that
// and `error` for a malformed record or a dead observer — never a default. A
// signature with a guessed option order would classify with confidence nobody
// measured, and the cell downstream would turn red or green on it.

import { isIP } from 'node:net';
import { readBoundedResponseBody } from './bounded-response-body.js';
import type { TcpSynSignature } from './tcp-os-fingerprint.js';

export const DEFAULT_OS_OBSERVER_PORT = 7791;
export const DEFAULT_OS_OBSERVER_LOOKUP = 'http://127.0.0.1:7792';
/** The lookup is loopback to a process answering from memory; anything slower
 *  than this is the observer being down, not being slow. */
export const OS_OBSERVER_LOOKUP_TIMEOUT_MS = 2_000;
/** A signature record is ~150 bytes; a body past this is not the observer. */
export const OS_OBSERVER_MAX_BODY_BYTES = 4 * 1024;

export type OsObserverLookupResult =
  | { kind: 'observed'; signature: TcpSynSignature }
  | { kind: 'absent' }
  | { kind: 'error'; detail: string };

export type OsObserverLookup = (ip: string) => Promise<OsObserverLookupResult>;

/**
 * Observer wire record (snake_case) → classifier signature. Pure; null on any
 * deviation. `mss` and `wscale` are legitimately absent (null) — a minimal
 * stack omits the options — but `ttl`, `window`, `df` and `options` are in
 * every SYN, so their absence is a broken record, not a sparse one.
 */
export function parseObserverSignature(raw: unknown): TcpSynSignature | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const u8 = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
  const u16 = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
  if (!u8(r.ttl) || !u16(r.window) || typeof r.df !== 'boolean') return null;
  if (!Array.isArray(r.options) || !r.options.every(u8)) return null;
  // null = option absent (valid); a present-but-malformed value is a broken record.
  if (r.mss !== null && !u16(r.mss)) return null;
  if (r.wscale !== null && !u8(r.wscale)) return null;
  return {
    ttl: r.ttl,
    windowSize: r.window,
    mss: r.mss === null ? null : r.mss,
    windowScale: r.wscale === null ? null : r.wscale,
    optionOrder: r.options,
    df: r.df,
  };
}

/**
 * Build the loopback lookup. `fetchImpl` is injectable so the unit tests never
 * open a socket. The address is validated as a literal IP BEFORE it reaches the
 * URL: the exit IP the caller passes came back THROUGH the customer's proxy, so
 * it is untrusted text until `isIP` says otherwise.
 */
export function makeOsObserverLookup(
  baseUrl: string = DEFAULT_OS_OBSERVER_LOOKUP,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OS_OBSERVER_LOOKUP_TIMEOUT_MS,
): OsObserverLookup {
  const base = baseUrl.replace(/\/+$/, '');
  return async (ip: string): Promise<OsObserverLookupResult> => {
    if (isIP(ip) === 0) return { kind: 'error', detail: 'lookup key is not an IP literal' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/sig/${ip}`, { signal: ctl.signal });
      if (res.status === 404) return { kind: 'absent' };
      if (res.status !== 200) return { kind: 'error', detail: `observer answered ${res.status}` };
      const sig = parseObserverSignature(
        JSON.parse(await readBoundedResponseBody(res, OS_OBSERVER_MAX_BODY_BYTES)) as unknown,
      );
      return sig === null
        ? { kind: 'error', detail: 'observer record was malformed' }
        : { kind: 'observed', signature: sig };
    } catch (err) {
      return { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}
