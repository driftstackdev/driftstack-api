// SOCKS5 proxy registry — CRUD over tauri-plugin-store.
//
// Stored under the same store file as settings (settings.json) but
// keyed separately so a settings reset doesn't blow away proxies and
// vice versa. IDs are random uuid-shaped strings minted at create
// time; they're stable across edits so any future "session created
// with this proxy" reference can stay valid.
//
// SOCKS5-only for now. The GUI accepts auth (username + password)
// per RFC 1929. We never log the password — it's stored on disk in
// the OS config dir, same posture as the API key.
//
// This module is local-only — proxies aren't sent to the server until
// `CreateSessionRequest` grows a `proxy` field (Tier-3 contract change,
// surfaced to founder for coordination with the WebKit fork's SOCKS5
// support).

import { invoke } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import type {
  AccountProxyScheme,
  OpenVpnConfigInput,
  WireGuardConfigInput,
} from './account-proxies';

export interface ProxyConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** ISO8601 created timestamp. Hand-set by the GUI; not server-authoritative. */
  createdAt: string;
  /** ARC A — the id of this proxy's server-side account_proxies row, set the
   *  first time it's synced (on launch). Lets a session pass proxy_id so the
   *  server routes egress through it. Absent until first synced. */
  serverId?: string;
  /** OVPN/WG — proxy type. Absent/undefined = socks5 (back-compat). host/port
   *  are the (display) endpoint for VPN schemes too. */
  scheme?: AccountProxyScheme;
  /** OVPN/WG config blocks — present only for the matching scheme. The
   *  secret-bearing parts ride here in the LOCAL cache (same on-disk posture as
   *  the socks5 password); the server wraps them under the account TMK. */
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

export interface ProxyDraft {
  label: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  scheme?: AccountProxyScheme;
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

const STORE_FILE = 'settings.json';
const PROXIES_KEY = 'proxies';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

export async function listProxies(): Promise<ProxyConfig[]> {
  const value = await getStore().get<ProxyConfig[]>(PROXIES_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter(isProxyConfig);
}

export async function addProxy(draft: ProxyDraft): Promise<ProxyConfig> {
  const all = await listProxies();
  const next: ProxyConfig = {
    id: mintId(),
    label: draft.label,
    host: draft.host,
    port: draft.port,
    username: draft.username,
    password: draft.password,
    createdAt: new Date().toISOString(),
    ...(draft.scheme !== undefined ? { scheme: draft.scheme } : {}),
    ...(draft.openvpn !== undefined ? { openvpn: draft.openvpn } : {}),
    ...(draft.wireguard !== undefined ? { wireguard: draft.wireguard } : {}),
  };
  await persist([...all, next]);
  return next;
}

export async function updateProxy(id: string, patch: ProxyDraft): Promise<ProxyConfig | null> {
  const all = await listProxies();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const updated: ProxyConfig = {
    ...(all[idx] as ProxyConfig),
    label: patch.label,
    host: patch.host,
    port: patch.port,
    username: patch.username,
    password: patch.password,
    ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
    // VPN blocks: a patch carrying one replaces it; absent leaves the stored one.
    ...(patch.openvpn !== undefined ? { openvpn: patch.openvpn } : {}),
    ...(patch.wireguard !== undefined ? { wireguard: patch.wireguard } : {}),
  };
  const next = [...all];
  next[idx] = updated;
  await persist(next);
  return updated;
}

export async function removeProxy(id: string): Promise<void> {
  const all = await listProxies();
  await persist(all.filter((p) => p.id !== id));
}

/** Record the server-side account_proxies id for a local proxy (set on first
 *  launch-sync). No-op if the local proxy is gone. Returns the updated row. */
export async function setProxyServerId(id: string, serverId: string): Promise<ProxyConfig | null> {
  const all = await listProxies();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const updated: ProxyConfig = { ...(all[idx] as ProxyConfig), serverId };
  const next = [...all];
  next[idx] = updated;
  await persist(next);
  return updated;
}

async function persist(proxies: ProxyConfig[]): Promise<void> {
  await getStore().set(PROXIES_KEY, proxies);
  await getStore().save();
}

function isProxyConfig(v: unknown): v is ProxyConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.label === 'string' &&
    typeof r.host === 'string' &&
    typeof r.port === 'number' &&
    (r.username === null || typeof r.username === 'string') &&
    (r.password === null || typeof r.password === 'string') &&
    typeof r.createdAt === 'string' &&
    (r.serverId === undefined || typeof r.serverId === 'string')
  );
}

function mintId(): string {
  // crypto.randomUUID is in WebCrypto in every Tauri WebView we ship.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Cheap fallback: 16 random hex chars. Good enough for local IDs.
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ─── validation helpers (used by the form) ────────────────────────

export interface DraftValidation {
  ok: boolean;
  errors: Partial<Record<keyof ProxyDraft, string>>;
}

export function validateDraft(d: ProxyDraft): DraftValidation {
  const errors: Partial<Record<keyof ProxyDraft, string>> = {};
  if (d.label.trim().length === 0) errors.label = 'Required.';
  if (d.host.trim().length === 0) errors.host = 'Required.';
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    errors.port = 'Port must be 1–65535.';
  }
  // VPN schemes require their config block (the paste must have parsed); host/
  // port are the endpoint, validated above.
  if (d.scheme === 'openvpn' && d.openvpn === undefined) {
    errors.openvpn = 'Paste a valid .ovpn configuration.';
  }
  if (d.scheme === 'wireguard' && d.wireguard === undefined) {
    errors.wireguard = 'Paste a valid wg0.conf configuration.';
  }
  // username/password are optional; if one is set the other isn't required
  // (some SOCKS5 servers accept username-only auth).
  return { ok: Object.keys(errors).length === 0, errors };
}

// ─── live connectivity probe (native) ─────────────────────────────

/** Result of the native `proxy_test` Tauri command. Field names match
 *  the Rust `ProxyTestResult` serialization exactly. */
export interface ProxyTestResult {
  /** TCP connect + SOCKS5 greeting handshake succeeded. */
  reachable: boolean;
  /** Auth accepted, or none required. `false` only on rejected creds. */
  auth_ok: boolean;
  /** `UDP ASSOCIATE` answered with success — QUIC / WebRTC tunnel works. */
  udp_associate: boolean;
  /** Handshake round-trip in milliseconds. */
  latency_ms: number;
  /** Human-readable summary, safe to render verbatim. */
  message: string;
}

/** Test a SOCKS5 proxy from the desktop host. Raw sockets are
 *  unavailable inside the WebView, so the probe runs natively in Rust
 *  (see `src-tauri` `proxy_test`). Resolves to a structured result even
 *  when the proxy is unreachable — `reachable: false` carries the
 *  diagnostic in `message` rather than throwing. */
/** Result of the native `proxy_exit_probe` command (E-2). */
export interface ProxyExitProbeResult {
  ip: string;
  country: string | null;
  // Geo enrichment (2026-06-15): best-effort city/region/timezone/ASN org
  // from lumtest.com/myip.json fetched THROUGH the proxy (the exit's geo as a
  // site would infer it). All null when lumtest is unreachable/blocked — the
  // ip/country baseline is unaffected.
  city?: string | null;
  region?: string | null;
  timezone?: string | null;
  asn_org?: string | null;
}

/** Exit-geo probe: native Rust fetches /v1/egress/echo THROUGH the proxy
 *  (design doc build-order 2). Returns null when the native command isn't
 *  built yet OR the echo endpoint isn't live on the server (pre-deploy) —
 *  callers render an honest 'geo unavailable' state, never a guess. */
export async function probeProxyExit(input: {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}): Promise<ProxyExitProbeResult | null> {
  try {
    return await invoke<ProxyExitProbeResult>('proxy_exit_probe', {
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
    });
  } catch {
    return null;
  }
}

export async function testProxy(input: {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}): Promise<ProxyTestResult> {
  return invoke<ProxyTestResult>('proxy_test', {
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
  });
}
