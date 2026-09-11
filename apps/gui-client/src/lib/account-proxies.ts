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
import { cleanProxyVantage, type ProxyVantage } from './proxy-vantage';

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
  /** [Peer] PresharedKey (44-char base64), when the peer requires one — carried to the
   *  fleet, which emits it under [Peer]. */
  preshared_key?: string;
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
  /** D2 — the exit the server last OBSERVED through this proxy (a live
   *  session's egress, or a fleet probe), resolved to geo server-side. Lets a
   *  VPN row show an exit without a test: the native exit probe is a SOCKS5
   *  request from this Mac and cannot run through a tunnel. null = never
   *  observed (the honest empty state); absent = an older server. */
  exit_observed?: AccountProxyListExitObserved | null;
  /** (i) I7 — when a fleet-vantage test found the tunnel DOWN while
   *  `exit_observed` was set (ISO 8601): the stored exit is what was last
   *  SEEN, this is when it was CONTRADICTED. The list adoption refuses an
   *  observation dated at or before it — and stamps the local entry — so a
   *  Mac that never ran the failing test agrees with the one that did.
   *  Cleared (null) by the next exit observation; absent = an older server. */
  exit_superseded_at?: string | null;
}

/** D2 — the LIST's observed exit. Narrower than the /test reply's
 *  `AccountProxyExitObserved` (no region/city; carries WHO observed it and
 *  WHEN). Field names match the wire. */
export interface AccountProxyListExitObserved {
  ip: string;
  country: string | null;
  timezone: string | null;
  observed_via: 'session' | 'probe';
  observed_at: string | null;
}

/** A listed row's `exit_observed` is kept only when it is an object whose `ip`
 *  is a non-empty string, whose `observed_via` is in the closed set, and whose
 *  geo/stamp members are each a string, null, or absent (absent reads as null).
 *  Anything else — including a malformed object — becomes null, the "never
 *  observed" state: a malformed exit must never become a rendered location, and
 *  one bad row must not fail the whole list. */
export function cleanListExitObserved(raw: unknown): AccountProxyListExitObserved | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ip !== 'string' || r.ip.length === 0) return null;
  if (r.observed_via !== 'session' && r.observed_via !== 'probe') return null;
  const opt = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : undefined;
  const country = opt(r.country);
  const timezone = opt(r.timezone);
  const observedAt = opt(r.observed_at);
  if (country === undefined || timezone === undefined || observedAt === undefined) return null;
  return { ip: r.ip, country, timezone, observed_via: r.observed_via, observed_at: observedAt };
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

/** The RFC-7807 members a refused create/update carries back. */
interface ProblemFields {
  type?: string;
  title?: string;
  detail?: string;
}

/** T-20 — a non-2xx answer to a proxy create/update, CARRYING the server's
 *  problem details. The transport used to dispose the body and throw
 *  `proxy create failed: 400`, which destroyed the one sentence that said why —
 *  e.g. which line of a pasted .ovpn the server refused — so the launch dialog
 *  could only guess ("Check the proxy and try again"). `message` keeps that
 *  historical prefix (a caller that only logs it sees no change); `status` is
 *  what the stale-id self-heal reads; `detail` is what the owner is shown. */
export class AccountProxyRequestError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly title: string | undefined;
  readonly detail: string | undefined;

  constructor(operation: 'create' | 'update', status: number, problem?: ProblemFields) {
    const base = `proxy ${operation} failed: ${status.toString()}`;
    super(problem?.detail === undefined ? base : `${base} — ${problem.detail}`);
    this.name = 'AccountProxyRequestError';
    this.status = status;
    this.type = problem?.type;
    this.title = problem?.title;
    this.detail = problem?.detail;
  }
}

/** The problem members of a decoded body, or nothing when it is not a
 *  problem+json object (an HTML 502 from something in front of the API, `{}`). */
function problemFields(body: unknown): ProblemFields | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const pick = (key: 'type' | 'title' | 'detail'): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const fields = { type: pick('type'), title: pick('title'), detail: pick('detail') };
  const empty =
    fields.type === undefined && fields.title === undefined && fields.detail === undefined;
  return empty ? undefined : fields;
}

/** The error for a non-2xx create/update: the body is read once, bounded, and
 *  the status-only message is the fallback when it is absent or not JSON. A
 *  success response never comes through here — the caller reads that body. */
async function failedProxyRequest(
  res: Response,
  operation: 'create' | 'update',
): Promise<AccountProxyRequestError> {
  const status = res.status;
  let problem: ProblemFields | undefined;
  try {
    problem = problemFields(await readBoundedApiJson<unknown>(res));
  } catch {
    // Empty, non-JSON or over the cap — the status is all that is known.
  }
  await disposeResponseBody(res);
  return new AccountProxyRequestError(operation, status, problem);
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
  const rows = Array.isArray(body.data) ? (body.data as AccountProxyMeta[]) : [];
  // D2 — the one list field a client ADOPTS into local state is cleaned here
  // (closed set + typed members), so a malformed exit on one row becomes that
  // row's "never observed" and nothing else. A row without the field (an older
  // server) is passed through untouched — absent stays absent.
  // (i) I7 — so is the contradiction stamp the adoption dates it against: a
  // string or null is kept, anything else reads as "never contradicted" (a
  // malformed stamp must not refuse an exit, nor be parsed into a date).
  return rows.map((r) => {
    if (typeof r !== 'object' || r === null) return r;
    const raw = r as unknown as Record<string, unknown>;
    return {
      ...r,
      ...('exit_observed' in raw
        ? { exit_observed: cleanListExitObserved(raw.exit_observed) }
        : {}),
      ...('exit_superseded_at' in raw
        ? {
            exit_superseded_at:
              typeof raw.exit_superseded_at === 'string' ? raw.exit_superseded_at : null,
          }
        : {}),
    };
  });
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
  if (!res.ok) throw await failedProxyRequest(res, 'create');
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
    // The status lets callers distinguish a stale-id 404 (the row was deleted
    // server-side) from other failures and self-heal by re-creating.
    throw await failedProxyRequest(res, 'update');
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

/** Split an `host:port` endpoint (last colon, so IPv6 hosts survive) into the
 *  DISPLAY host/port. A bracketed IPv6 literal (`[2001:db8::1]:51820`, the
 *  wg-quick syntax) is unwrapped here — one surrounding `[ ]` pair — because the
 *  native endpoint_resolve reads a bare address and cannot parse the brackets.
 *  Only the display host changes: the `endpoint` string on the wire keeps its
 *  bracketed form, which is what the server accepts. */
function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const at = endpoint.lastIndexOf(':');
  if (at <= 0) return null;
  const rawHost = endpoint.slice(0, at);
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const port = Number.parseInt(endpoint.slice(at + 1), 10);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** What parse-wireguard's detailed parse hands over, typed by shape so this
 *  transport module stays free of the parser (whose fields already mirror
 *  WireGuardConfigInput 1:1). The `ok: false` arm carries the field-naming
 *  reason the form shows verbatim. */
type WireGuardParseOutcome =
  | { ok: true; value: WireGuardConfigInput }
  | { ok: false; reason: string };

/** Parsed wg0.conf → create body. Returns `{ error }` when the paste is unusable.
 *  Takes the detailed parse result so the error NAMES the field (Address, either
 *  key, or the Endpoint); the flat config / null form stays for callers that
 *  hold a stored config rather than a paste, and a null can only say the paste
 *  was unusable — it carries no reason. */
export function buildWireGuardProxyInput(
  label: string,
  parsed: WireGuardConfigInput | WireGuardParseOutcome | null,
): AccountProxyInput | { error: string } {
  if (parsed === null) {
    return {
      error:
        'Not a valid wg0.conf (needs a PrivateKey, a [Peer] PublicKey and Endpoint, and an [Interface] Address).',
    };
  }
  let config: WireGuardConfigInput;
  if ('ok' in parsed) {
    if (!parsed.ok) return { error: parsed.reason };
    config = parsed.value;
  } else {
    config = parsed;
  }
  const ep = splitEndpoint(config.endpoint);
  if (ep === null) return { error: 'WireGuard endpoint must be host:port.' };
  return {
    label,
    scheme: 'wireguard',
    host: ep.host,
    port: ep.port,
    wireguard: config,
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
       *  proxy, closer to the fleet vantage than the customer's Mac (T-1).
       *
       *  ⛔ NULL on a fleet result that reached the proxy but produced no timing.
       *  The spec's fleet member types this nullable and always has; the parser
       *  below used to refuse it, which threw `malformed response` into a caller
       *  that swallows throws — so the customer's re-test did nothing at all and
       *  the previous number stayed on the card looking freshly measured. */
      latency_ms: number | null;
      os_fingerprint?: OsFingerprint;
      /** T-6 — the measured QUIC verdict, present only when the server measured
       *  one in a live session; absent = never measured (chip stays inferred). */
      quic_measured?: MeasuredQuic | null;
      quic_measured_at?: string | null;
      /** T-1 — WHERE the server measured this: 'fleet' = the Mac that runs your
       *  profiles (node_id names it); 'control_plane' = no fleet Mac was free, so
       *  Driftstack's server measured it (the honest fallback). Absent on a
       *  vantage=cp response — today's shape, unchanged. Closed set: any other
       *  value is dropped, so a number is never shown under the wrong label. */
      measured_from?: ProxyVantage;
      /** Only beside measured_from 'fleet' — the node that ran the test. */
      node_id?: string;
      exit_ip?: string;
      /** T-1 — the fleet Mac's STANDALONE QUIC handshake through the proxy to a
       *  cold h3 origin: it proves the PROXY relays QUIC. A DIFFERENT signal from
       *  quic_measured (a live browser session's observed HTTP/3). Both ride the
       *  row, each under its own label, and are never merged — when they
       *  disagree, that disagreement is the finding. Only beside 'fleet'. */
      quic_probe?: boolean;
      quic_detail?: string;
      reachable?: boolean;
      udp_associate?: boolean;
      h2_ok?: boolean;
      /** VPN exit parity (b) — the exit the fleet Mac OBSERVED through this
       *  proxy/tunnel during the test, resolved to geo server-side. For an
       *  OpenVPN/WireGuard row this is the ONLY exit identity a client can get:
       *  the native exit probe is a SOCKS5 request from this Mac and cannot run
       *  through a tunnel. `ip` is the one required member; each geo member is
       *  null when the server could not say. Only beside 'fleet'. */
      exit_observed?: AccountProxyExitObserved;
    }
  | {
      ok: false;
      reason: string;
      measured_from?: ProxyVantage;
      /** (d) — present when NOTHING RAN, so this `ok:false` is not a verdict
       *  about the proxy: the control plane refused a VPN test because a live
       *  session holds the tunnel (`live_session`), or the fleet node could not
       *  run the probe (`node_busy` / `node_error`). The views branch on THIS —
       *  never on the `reason` prose — to keep the row's last verdict and show
       *  the sentence as a notice, not as "tunnel down". */
      not_run?: AccountProxyTestNotRun;
      /** (d) — beside `not_run: 'live_session'` (and (h) `'no_node'`) only: the
       *  exit a session observed through the tunnel (the server's stored
       *  observation, no region/city), so the row still shows where it exits. */
      exit_observed?: AccountProxyExitObserved;
    };

/** (d) — why a /test produced no measurement. A closed set: a value outside it
 *  is dropped (the reply then reads as a plain failure, never as a refusal it
 *  did not earn). (i) I6 — `plan_excluded` is minted by THIS client from a 403
 *  (the route's tier refusal); it is never read off the wire, so
 *  `cleanTestNotRun` does not admit it. */
export type AccountProxyTestNotRun =
  | 'live_session'
  | 'node_busy'
  | 'node_error'
  | 'no_node'
  | 'plan_excluded';

export function cleanTestNotRun(
  raw: unknown,
): Exclude<AccountProxyTestNotRun, 'plan_excluded'> | undefined {
  // (h) `no_node` — no fleet Mac was free to bring a VPN tunnel up, and the
  // control plane cannot measure a tunnel itself (it never falls back to a
  // TCP connect for a VPN row). Not a verdict; the row is "not tested".
  return raw === 'live_session' || raw === 'node_busy' || raw === 'node_error' || raw === 'no_node'
    ? raw
    : undefined;
}

/** The fleet-observed exit on a /test reply. Field names match the wire. */
export interface AccountProxyExitObserved {
  ip: string;
  country: string | null;
  timezone: string | null;
  region: string | null;
  city: string | null;
  /** (h) — beside a `not_run` reply only: WHEN the server's STORED exit was
   *  observed (ISO 8601), null when the observation predates the column, absent
   *  on a measured (ok) exit, which the reply itself dates. A stored exit is
   *  older than the reply that carries it — the consumer that dates exits
   *  (`persistServerProbe`) dates this one by the observation, never by the
   *  reply, or a fleet failure's "superseded" stamp could be walked past. */
  observed_at?: string | null;
}

/** A wire `exit_observed` is kept only when it is an object whose `ip` is a
 *  non-empty string and whose geo members are each a string, null, or absent
 *  (absent reads as null — the honest "not resolved"). Anything else — a bare
 *  string, an array, a numeric `country` — drops the FIELD, never throws: a
 *  malformed exit must not become a rendered location, and it must not turn a
 *  reply the caller can otherwise use into `malformed response`. */
export function cleanExitObserved(raw: unknown): AccountProxyExitObserved | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.ip !== 'string' || r.ip.length === 0) return undefined;
  const geo = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : undefined;
  const country = geo(r.country);
  const timezone = geo(r.timezone);
  const region = geo(r.region);
  const city = geo(r.city);
  if (country === undefined || timezone === undefined || region === undefined || city === undefined)
    return undefined;
  // (h) — the observation's own date rides along when the wire carries one; a
  // non-string value drops the DATE (the exit then reads as undated), never the
  // exit. Absent stays absent so an `ok` exit is not stamped with a null date.
  const observedAt = r.observed_at;
  return {
    ip: r.ip,
    country,
    timezone,
    region,
    city,
    ...(observedAt === null || typeof observedAt === 'string' ? { observed_at: observedAt } : {}),
  };
}

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

/** T-1 — a fleet `ok:false` frame carries no `reason` (the node reports the
 *  measurement, not prose), so the client says what happened in plain words. */
const FLEET_TEST_FAILED_REASON =
  'The Mac that runs your profiles could not connect through this proxy.';

/** (i) I6 — a 403 on /test whose problem detail is the route's TIER refusal
 *  (the same one POST/PUT give a VPN row on a tier without vpnEgress). The
 *  transport used to throw on it like any non-2xx, which the shared step
 *  turned into `unavailable` — "the server did not answer" — for an account
 *  whose retry can never succeed. The problem+json `detail` is appended.
 *  ⛔ Only the TIER 403: the route also answers 403 for a key lacking the
 *  `account_owner` scope, a suspended account, a device the free-desktop
 *  policy denies — none of which is a plan exclusion, and the tier refusal
 *  carries no problem `type` of its own, so its sentence is the discriminator
 *  (`requireTierFeature` in the server's errors-helpers). Every other 403
 *  still throws, as before I6. */
export const PLAN_EXCLUDES_FLEET_TEST_REASON =
  'Your plan does not include fleet tests for VPN proxies.';

/** The server's tier-refusal detail: `The "<feature>" feature is not available
 *  on the "<tier>" tier. …` — matched, never reproduced. */
const TIER_REFUSAL_DETAIL = /\bis not available on the "[^"]+" tier\b/;

export function isTierRefusalDetail(detail: string | undefined): detail is string {
  return detail !== undefined && TIER_REFUSAL_DETAIL.test(detail);
}

/**
 * @param opts.vantage T-1 — 'fleet' asks the server to measure from the Mac
 *   that will run the profile (the response then carries `measured_from`, and
 *   'control_plane' when no node was free). Omitted/'cp' is today's request and
 *   today's response, unchanged.
 */
export async function testAccountProxy(
  baseUrl: string,
  apiKey: string,
  id: string,
  opts?: { vantage?: 'cp' | 'fleet' },
): Promise<AccountProxyTestResult> {
  const query = opts?.vantage === 'fleet' ? '?vantage=fleet' : '';
  const res = await fetchWithDeadline(
    `${base(baseUrl)}/${encodeURIComponent(id)}/test${query}`,
    { method: 'POST', headers: authHeaders(apiKey) },
    PROXY_TEST_DEADLINE_MS,
  );
  if (!res.ok) {
    const status = res.status;
    if (status === 403) {
      // (i) I6 — the TIER refusal is an ANSWER (nothing ran; a retry cannot
      // change it), surfaced like a `not_run` so the views show it as a notice
      // and a sweep counts the row as skipped — never as "the server did not
      // answer". Recognised by its detail: a 403 with any other detail (scope,
      // suspended, device policy) or no readable body is NOT a plan exclusion
      // and throws like every other non-2xx.
      let detail: string | undefined;
      try {
        detail = problemFields(await readBoundedApiJson<unknown>(res))?.detail;
      } catch {
        /* status is all that is known */
      }
      await disposeResponseBody(res);
      if (isTierRefusalDetail(detail)) {
        return {
          ok: false,
          reason: `${PLAN_EXCLUDES_FLEET_TEST_REASON} ${detail}`,
          not_run: 'plan_excluded',
        };
      }
      throw new Error(`proxy test failed: ${status.toString()}`);
    }
    await disposeResponseBody(res);
    throw new Error(`proxy test failed: ${status.toString()}`);
  }
  const body = await readBoundedApiJson<Record<string, unknown>>(res);
  // T-1 — the vantage is a CLOSED set; a value outside it is dropped (the number
  // then renders unlabelled), never shown under a label it did not earn.
  const vantage = cleanProxyVantage(body.measured_from);
  // T-1 — `latency_ms: null` is a DOCUMENTED ok answer from a fleet Mac, not a
  // malformed one: the node reached the proxy and produced no timing. Accepted
  // for the fleet vantage ONLY — the cp member of the spec types the field as a
  // required integer, so a null there really is malformed and is still refused.
  const latency =
    typeof body.latency_ms === 'number'
      ? body.latency_ms
      : body.latency_ms === null && vantage === 'fleet'
        ? null
        : undefined;
  if (body.ok === true && latency !== undefined) {
    const fp = cleanWireFingerprint(body.os_fingerprint);
    // T-6 — a value outside the closed set is DROPPED (the field is omitted, read
    // downstream as "never measured"), never coerced into a would-be green chip.
    const quic = cleanMeasuredQuic(body.quic_measured);
    // T-1 — the fleet-only fields are kept ONLY beside a 'fleet' vantage: the
    // QUIC-relay chip's caption names a fleet Mac, so a value that did not come
    // from one must not reach it. Each field keeps its own type or is omitted.
    const fleet = vantage === 'fleet';
    const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const nodeId = fleet ? optStr(body.node_id) : undefined;
    const exitIp = fleet ? optStr(body.exit_ip) : undefined;
    const quicDetail = fleet ? optStr(body.quic_detail) : undefined;
    // (e) — a QUIC leg the node SKIPPED (VPN path; endpoint never answered) is not a
    // measurement: never let it read as "does not relay QUIC". Older servers still send
    // quic_ok:false beside such a detail; newer ones omit quic_ok — both land here.
    const quicDetailRaw = fleet ? optStr(body.quic_detail) : undefined;
    const quicProbe =
      fleet && !(quicDetailRaw !== undefined && quicDetailRaw.startsWith('skipped:'))
        ? optBool(body.quic_ok)
        : undefined;
    const reachable = fleet ? optBool(body.reachable) : undefined;
    const udpAssociate = fleet ? optBool(body.udp_associate) : undefined;
    const h2Ok = fleet ? optBool(body.h2_ok) : undefined;
    // VPN exit parity (b) — the fleet-observed exit rides beside quic_probe under
    // the same fleet-only rule; a malformed one drops the field, never the reply.
    const exitObserved = fleet ? cleanExitObserved(body.exit_observed) : undefined;
    return {
      ok: true,
      latency_ms: latency,
      ...(fp !== undefined ? { os_fingerprint: fp } : {}),
      ...(quic !== null
        ? {
            quic_measured: quic,
            quic_measured_at:
              typeof body.quic_measured_at === 'string' ? body.quic_measured_at : null,
          }
        : {}),
      ...(vantage !== undefined ? { measured_from: vantage } : {}),
      ...(nodeId !== undefined ? { node_id: nodeId } : {}),
      ...(exitIp !== undefined ? { exit_ip: exitIp } : {}),
      ...(quicProbe !== undefined ? { quic_probe: quicProbe } : {}),
      ...(quicDetail !== undefined ? { quic_detail: quicDetail } : {}),
      ...(reachable !== undefined ? { reachable } : {}),
      ...(udpAssociate !== undefined ? { udp_associate: udpAssociate } : {}),
      ...(h2Ok !== undefined ? { h2_ok: h2Ok } : {}),
      ...(exitObserved !== undefined ? { exit_observed: exitObserved } : {}),
    };
  }
  if (body.ok === false && typeof body.reason === 'string') {
    const notRun = cleanTestNotRun(body.not_run);
    // (d) — the stored session exit rides ONLY on the live-session refusal (the
    // documented case); on any other failure an exit_observed is not a claim
    // this reply can make, and it is dropped. Malformed → dropped, never thrown.
    const refusedExit =
      notRun === 'live_session' || notRun === 'no_node'
        ? cleanExitObserved(body.exit_observed)
        : undefined;
    return {
      ok: false,
      reason: body.reason,
      ...(vantage !== undefined ? { measured_from: vantage } : {}),
      ...(notRun !== undefined ? { not_run: notRun } : {}),
      ...(refusedExit !== undefined ? { exit_observed: refusedExit } : {}),
    };
  }
  // T-1 — a fleet Mac reports a failed test as a RESULT without prose; that is a
  // well-formed answer, not a malformed one.
  if (body.ok === false && vantage === 'fleet')
    return { ok: false, reason: FLEET_TEST_FAILED_REASON, measured_from: vantage };
  throw new Error('proxy test: malformed response');
}
