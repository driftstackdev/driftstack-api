// Per-account customer-proxies sync (ARC A slice 5).
//
// Customer proxies used to live only in this machine's Tauri store. The server
// now persists them per-account behind /v1/account/me/proxies (account_proxies,
// migration 0081), with the password wrapped under the account TMK and never
// returned (responses carry has_password). This module is the thin transport: a
// raw authed fetch (mirrors lib/account-organization.ts) rather than an SDK
// method — the SDK account surface is parity-locked across 3 SDKs, not worth
// widening for a GUI feature. The local Tauri proxy store stays as the OFFLINE
// cache; ProfilesView/ProxiesView reconcile (server wins on a successful load).

import { disposeResponseBody } from './dispose-response-body';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
import {
  isFingerprintConfidence,
  isFingerprintedOs,
  type OsFingerprint,
} from './os-fingerprint-verdict';

export type AccountProxyScheme = 'socks5' | 'http' | 'openvpn' | 'wireguard';

/** T-6 — the CLOSED SET of measured-QUIC verdicts the chip can render. Only
 *  these two survive the wire; a value outside them (a newer server, a proxy
 *  MITM-ing the response) is read as "never measured", never as a green ✓. */
export type MeasuredQuic = 'h3' | 'h2-only';

/** Keep only a measured-QUIC value the chip can render; anything else — a newer
 *  server enum, a non-string, an absent field — becomes null (the honest
 *  unmeasured state). Same N-2 closed-set rule as the OS fingerprint: not
 *  measured must never look like a pass. */
export function cleanMeasuredQuic(raw: unknown): MeasuredQuic | null {
  return raw === 'h3' || raw === 'h2-only' ? raw : null;
}

/** OVPN/WG — VPN config blocks on the create/update body. The secret-bearing
 *  parts (config_blob/password, private_key) are write-only; the server wraps
 *  them under the account TMK and never echoes them (has_secret instead). */
export interface OpenVpnConfigInput {
  config_blob: string;
  username?: string;
  password?: string;
}
export interface WireGuardConfigInput {
  private_key: string;
  peer_public_key: string;
  endpoint: string;
  allowed_ips: string;
  /** [Interface] Address (e.g. 10.7.0.2/32) — the harness WG ifconfig needs it. */
  address: string;
  dns?: string;
}

/** Server view — never carries the password/secret (has_password/has_secret instead). */
export interface AccountProxyMeta {
  id: string;
  label: string;
  scheme: AccountProxyScheme;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
  /** True when a VPN secret (openvpn config_blob / wireguard private_key) is stored. */
  has_secret?: boolean;
  created_at: string;
  updated_at: string;
  /** T-6 — the QUIC verdict MEASURED in a live session: 'h3' (HTTP/3 verified),
   *  'h2-only' (no HTTP/3, measured), or null when the proxy has never run a
   *  session. null is the honest unmeasured state and must never render green. */
  quic_measured?: MeasuredQuic | null;
  /** ISO timestamp of that measurement, or null when never measured. */
  quic_measured_at?: string | null;
}

/** Create body. `password` is write-only; omit (or null) for no password. VPN
 *  schemes carry the matching `openvpn`/`wireguard` block; host/port are the
 *  (display) endpoint. */
export interface AccountProxyInput {
  label: string;
  scheme?: AccountProxyScheme;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

/** Update body — every field optional; password omitted keeps the stored one,
 *  null clears it, a string sets it. */
export type AccountProxyUpdate = Partial<AccountProxyInput>;

function base(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/account/me/proxies`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
}

/** GET the account's proxies. Throws on non-2xx / network error (caller falls
 *  back to the local cache when offline). */
export async function listProxies(baseUrl: string, apiKey: string): Promise<AccountProxyMeta[]> {
  const res = await fetchWithDeadline(base(baseUrl), {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  if (!res.ok) {
    const status = res.status;
    await disposeResponseBody(res);
    throw new Error(`proxies fetch failed: ${status.toString()}`);
  }
  const body = await readBoundedApiJson<{ data?: unknown }>(res);
  return Array.isArray(body.data) ? (body.data as AccountProxyMeta[]) : [];
}

export async function createProxy(
  baseUrl: string,
  apiKey: string,
  input: AccountProxyInput,
): Promise<AccountProxyMeta> {
  const res = await fetchWithDeadline(base(baseUrl), {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const status = res.status;
    await disposeResponseBody(res);
    throw new Error(`proxy create failed: ${status.toString()}`);
  }
  return readBoundedApiJson<AccountProxyMeta>(res);
}

export async function updateProxy(
  baseUrl: string,
  apiKey: string,
  id: string,
  patch: AccountProxyUpdate,
): Promise<AccountProxyMeta> {
  const res = await fetchWithDeadline(`${base(baseUrl)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const status = res.status;
    await disposeResponseBody(res);
    // Attach the status so callers can distinguish a stale-id 404 (the row was
    // deleted server-side) from other failures and self-heal by re-creating.
    const err = new Error(`proxy update failed: ${status.toString()}`) as Error & {
      status?: number;
    };
    err.status = status;
    throw err;
  }
  return readBoundedApiJson<AccountProxyMeta>(res);
}

export async function deleteProxy(baseUrl: string, apiKey: string, id: string): Promise<void> {
  const res = await fetchWithDeadline(`${base(baseUrl)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  });
  // 204 expected; 404 = already gone (idempotent from the caller's view).
  const status = res.status;
  const accepted = res.ok || status === 404;
  await disposeResponseBody(res);
  if (!accepted) {
    throw new Error(`proxy delete failed: ${status.toString()}`);
  }
}

// OVPN/WG arc — glue from a pasted VPN config to the create body. The VPN
// editor parses the paste with lib/parse-wireguard + lib/parse-openvpn (which
// extract the endpoint) and calls these to build the AccountProxyInput. host/
// port are set to the endpoint so the proxy renders meaningfully in the list.
// Pure + total (no throws): a bad paste → an `error` so the form can surface it.

/** Split an `host:port` endpoint (last colon, so IPv6 hosts survive). */
function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const at = endpoint.lastIndexOf(':');
  if (at <= 0) return null;
  const host = endpoint.slice(0, at);
  const port = Number.parseInt(endpoint.slice(at + 1), 10);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Parsed wg0.conf → create body. Returns `{ error }` when the paste is unusable. */
export function buildWireGuardProxyInput(
  label: string,
  parsed: WireGuardConfigInput | null,
): AccountProxyInput | { error: string } {
  if (parsed === null) return { error: 'Not a valid wg0.conf (missing keys or endpoint).' };
  const ep = splitEndpoint(parsed.endpoint);
  if (ep === null) return { error: 'WireGuard endpoint must be host:port.' };
  return {
    label,
    scheme: 'wireguard',
    host: ep.host,
    port: ep.port,
    wireguard: parsed,
  };
}

/** .ovpn paste + extracted remote → create body. */
export function buildOpenVpnProxyInput(
  label: string,
  configBlob: string,
  remote: { host: string; port: number } | null,
  creds?: { username?: string; password?: string },
): AccountProxyInput | { error: string } {
  if (remote === null) return { error: 'Not a valid .ovpn (missing client/remote directive).' };
  return {
    label,
    scheme: 'openvpn',
    host: remote.host,
    port: remote.port,
    openvpn: {
      config_blob: configBlob,
      ...(creds?.username ? { username: creds.username } : {}),
      ...(creds?.password ? { password: creds.password } : {}),
    },
  };
}

// N-2 — the control plane's connection test. Beyond ok/latency it carries the
// passive OS fingerprint of the proxy's OWN TCP stack when the control plane
// observed one: the proxy's kernel builds the SYN, only the destination of
// that connection can read it, and the native probe in this app is the
// proxy's client, not its destination. So this is the ONLY source of that
// verdict, and only a proxy stored on the account can be tested for it.

export type AccountProxyTestResult =
  | {
      ok: true;
      /** SERVER-measured latency (ms) — the control plane's own round-trip to the
       *  proxy, closer to the fleet vantage than the customer's Mac (T-1). */
      latency_ms: number;
      os_fingerprint?: OsFingerprint;
      /** T-6 — the measured QUIC verdict, present only when the server measured
       *  one in a live session; absent = never measured (chip stays inferred). */
      quic_measured?: MeasuredQuic | null;
      quic_measured_at?: string | null;
    }
  | { ok: false; reason: string };

/** A wire fingerprint is kept only when every field is one the verdict can
 *  render. A value outside the closed set (a newer server, a proxy MITM-ing
 *  the response) drops the FIELD — it must never become a green chip. */
function cleanWireFingerprint(raw: unknown): OsFingerprint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (!isFingerprintedOs(f.os) || !isFingerprintConfidence(f.confidence)) return undefined;
  if (typeof f.reason !== 'string') return undefined;
  return { os: f.os, confidence: f.confidence, reason: f.reason };
}

/** The server budgets ~12s for connectivity plus ~6s for the observer tunnel;
 *  the client deadline sits above both so a slow-but-working proxy is not cut
 *  off here and reported as a failure the server never saw. */
const PROXY_TEST_DEADLINE_MS = 30_000;

export async function testAccountProxy(
  baseUrl: string,
  apiKey: string,
  id: string,
): Promise<AccountProxyTestResult> {
  const res = await fetchWithDeadline(
    `${base(baseUrl)}/${encodeURIComponent(id)}/test`,
    { method: 'POST', headers: authHeaders(apiKey) },
    PROXY_TEST_DEADLINE_MS,
  );
  if (!res.ok) {
    const status = res.status;
    await disposeResponseBody(res);
    throw new Error(`proxy test failed: ${status.toString()}`);
  }
  const body = await readBoundedApiJson<Record<string, unknown>>(res);
  if (body.ok === true && typeof body.latency_ms === 'number') {
    const fp = cleanWireFingerprint(body.os_fingerprint);
    // T-6 — a value outside the closed set is DROPPED (the field is omitted, read
    // downstream as "never measured"), never coerced into a would-be green chip.
    const quic = cleanMeasuredQuic(body.quic_measured);
    return {
      ok: true,
      latency_ms: body.latency_ms,
      ...(fp !== undefined ? { os_fingerprint: fp } : {}),
      ...(quic !== null
        ? {
            quic_measured: quic,
            quic_measured_at:
              typeof body.quic_measured_at === 'string' ? body.quic_measured_at : null,
          }
        : {}),
    };
  }
  if (body.ok === false && typeof body.reason === 'string')
    return { ok: false, reason: body.reason };
  throw new Error('proxy test: malformed response');
}
