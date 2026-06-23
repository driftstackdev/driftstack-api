// W467.B — drift guard for apps/gui-client/src/lib/proxies.ts.
// SOCKS5 proxy registry over tauri-plugin-store. Drift here
// either drops the isProxyConfig runtime narrowing (a corrupted
// settings.json with arbitrary fields gets surfaced to UI as
// "proxy" entries, leaking customer-controlled JSON into the
// session-config UI) or breaks the Tier-3 server-handoff framing
// (proxies are local-only; sending them to the server before the
// WebKit fork has SOCKS5 wired is a coordination break with
// founder/Agent 1).
//
//   • Header framing pinned: 'SOCKS5 proxy registry — CRUD over
//     tauri-plugin-store.' + 'Stored under the same store file
//     as settings (settings.json) but keyed separately so a
//     settings reset doesn't blow away proxies and vice versa.
//     IDs are random uuid-shaped strings minted at create time;
//     they're stable across edits so any future "session created
//     with this proxy" reference can stay valid.'
//   • Local-only framing pinned: 'This module is local-only —
//     proxies aren't sent to the server until
//     CreateSessionRequest grows a `proxy` field (Tier-3
//     contract change, surfaced to founder for coordination with
//     the WebKit fork's SOCKS5 support).'
//   • RFC 1929 framing pinned: 'SOCKS5-only for now. The GUI
//     accepts auth (username + password) per RFC 1929. We never
//     log the password — it's stored on disk in the OS config
//     dir, same posture as the API key.'
//   • ProxyConfig 7-field (id + label + host + port + username
//     nullable + password nullable + createdAt ISO).
//   • ProxyDraft 5-field (label + host + port + username +
//     password — no id or createdAt; minted by addProxy).
//   • STORE_FILE = 'settings.json' + PROXIES_KEY = 'proxies'.
//   • LazyStore singleton via getStore lazy init.
//   • listProxies: get<ProxyConfig[]> + Array.isArray check +
//     filter(isProxyConfig) defensive narrow.
//   • addProxy: mintId + new Date().toISOString() + persist
//     [...all, next].
//   • updateProxy: findIndex; idx < 0 → null; spread + persist.
//   • removeProxy: filter !== id + persist.
//   • isProxyConfig: 7 type-checks (port number + nullable
//     username/password).
//   • mintId: globalThis.crypto?.randomUUID() preferred + fallback
//     16-hex-char loop.
//   • validateDraft: label/host non-empty after trim + port
//     integer 1-65535.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/proxies.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W467.B apps/gui-client/src/lib/proxies.ts content parity', () => {
  const body = read(LIB);

  it("Header framing pinned: 'SOCKS5 proxy registry — CRUD over tauri-plugin-store.' + 'Stored under the same store file as settings (settings.json) but keyed separately so a settings reset doesn't blow away proxies and vice versa. IDs are random uuid-shaped strings minted at create time; they're stable across edits so any future \"session created with this proxy\" reference can stay valid.'", () => {
    expect(body).toMatch(/\/\/ SOCKS5 proxy registry — CRUD over tauri-plugin-store\./);
    expect(body).toMatch(
      /\/\/ Stored under the same store file as settings \(settings\.json\) but\s*\n?\s*\/\/ keyed separately so a settings reset doesn't blow away proxies and\s*\n?\s*\/\/ vice versa\. IDs are random uuid-shaped strings minted at create\s*\n?\s*\/\/ time; they're stable across edits so any future "session created\s*\n?\s*\/\/ with this proxy" reference can stay valid\./,
    );
  });

  it("RFC 1929 framing pinned: 'SOCKS5-only for now. The GUI accepts auth (username + password) per RFC 1929. We never log the password — it's stored on disk in the OS config dir, same posture as the API key.'", () => {
    expect(body).toMatch(
      /\/\/ SOCKS5-only for now\. The GUI accepts auth \(username \+ password\)\s*\n?\s*\/\/ per RFC 1929\. We never log the password — it's stored on disk in\s*\n?\s*\/\/ the OS config dir, same posture as the API key\./,
    );
  });

  it("Local-only framing pinned: 'This module is local-only — proxies aren't sent to the server until `CreateSessionRequest` grows a `proxy` field (Tier-3 contract change, surfaced to founder for coordination with the WebKit fork's SOCKS5 support).'", () => {
    expect(body).toMatch(
      /\/\/ This module is local-only — proxies aren't sent to the server until\s*\n?\s*\/\/ `CreateSessionRequest` grows a `proxy` field \(Tier-3 contract change,\s*\n?\s*\/\/ surfaced to founder for coordination with the WebKit fork's SOCKS5\s*\n?\s*\/\/ support\)\./,
    );
  });

  it('ProxyConfig 8-field: id + label + host + port + username nullable + password nullable + createdAt + serverId? (ARC A — server account_proxies id, set on first launch-sync)', () => {
    expect(body).toMatch(
      /export interface ProxyConfig \{\s*\n?\s*id: string;\s*\n?\s*label: string;\s*\n?\s*host: string;\s*\n?\s*port: number;\s*\n?\s*username: string \| null;\s*\n?\s*password: string \| null;\s*\n?\s*\/\*\* ISO8601 created timestamp\. Hand-set by the GUI; not server-authoritative\. \*\/\s*\n?\s*createdAt: string;/,
    );
    // ARC A — serverId caches the server-side account_proxies id for launch.
    expect(body).toMatch(/serverId\?: string;/);
  });

  it('ProxyDraft (label + host + port + username + password — no id or createdAt; minted by addProxy) + OVPN/WG optional scheme/openvpn/wireguard', () => {
    expect(body).toMatch(
      /export interface ProxyDraft \{\s*\n?\s*label: string;\s*\n?\s*host: string;\s*\n?\s*port: number;\s*\n?\s*username: string \| null;\s*\n?\s*password: string \| null;\s*\n?\s*scheme\?: AccountProxyScheme;/,
    );
    // OVPN/WG arc — the draft carries the VPN config blocks for the matching scheme.
    expect(body).toContain('openvpn?: OpenVpnConfigInput;');
    expect(body).toContain('wireguard?: WireGuardConfigInput;');
  });

  it("Storage constants: STORE_FILE = 'settings.json' (shared with settings.ts) + PROXIES_KEY = 'proxies'; LazyStore from @tauri-apps/plugin-store + lazy getStore() singleton", () => {
    expect(body).toMatch(/const STORE_FILE = 'settings\.json';/);
    expect(body).toMatch(/const PROXIES_KEY = 'proxies';/);
    expect(body).toMatch(/import \{ LazyStore \} from '@tauri-apps\/plugin-store';/);
    expect(body).toMatch(
      /let store: LazyStore \| null = null;\s*\n?\s*function getStore\(\): LazyStore \{\s*\n?\s*if \(store === null\) \{\s*\n?\s*store = new LazyStore\(STORE_FILE\);\s*\n?\s*\}\s*\n?\s*return store;\s*\n?\s*\}/,
    );
  });

  it('listProxies: get<ProxyConfig[]>(PROXIES_KEY) + !Array.isArray(value) → [] + .filter(isProxyConfig) defensive runtime-narrow', () => {
    expect(body).toMatch(
      /export async function listProxies\(\): Promise<ProxyConfig\[\]> \{\s*\n?\s*const value = await getStore\(\)\.get<ProxyConfig\[\]>\(PROXIES_KEY\);\s*\n?\s*if \(!Array\.isArray\(value\)\) return \[\];\s*\n?\s*return value\.filter\(isProxyConfig\);\s*\n?\s*\}/,
    );
  });

  it('addProxy: mintId() + new Date().toISOString() + persist([...all, next]); updateProxy: findIndex; idx < 0 → null; spread merge + persist; removeProxy: filter !== id + persist', () => {
    expect(body).toMatch(
      /export async function addProxy\(draft: ProxyDraft\): Promise<ProxyConfig> \{\s*\n?\s*return writeLock\(async \(\) => \{\s*\n?\s*const all = await listProxies\(\);\s*\n?\s*const next: ProxyConfig = \{\s*\n?\s*id: mintId\(\),\s*\n?\s*label: draft\.label,\s*\n?\s*host: draft\.host,\s*\n?\s*port: draft\.port,\s*\n?\s*username: draft\.username,\s*\n?\s*password: draft\.password,\s*\n?\s*createdAt: new Date\(\)\.toISOString\(\),/,
    );
    // OVPN/WG arc — addProxy carries the optional scheme + VPN blocks through.
    expect(body).toContain('await persist([...all, next]);');
    expect(body).toContain('? { scheme: draft.scheme }');
    expect(body).toMatch(
      /export async function updateProxy\(id: string, patch: ProxyDraft\): Promise<ProxyConfig \| null> \{\s*\n?\s*return writeLock\(async \(\) => \{\s*\n?\s*const all = await listProxies\(\);\s*\n?\s*const idx = all\.findIndex\(\(p\) => p\.id === id\);\s*\n?\s*if \(idx < 0\) return null;/,
    );
    expect(body).toMatch(
      /export async function removeProxy\(id: string\): Promise<void> \{\s*\n?\s*return writeLock\(async \(\) => \{\s*\n?\s*const all = await listProxies\(\);\s*\n?\s*await persist\(all\.filter\(\(p\) => p\.id !== id\)\);\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('isProxyConfig runtime narrow: id/label/host/createdAt string + port number + nullable username/password + optional serverId string', () => {
    expect(body).toMatch(
      /function isProxyConfig\(v: unknown\): v is ProxyConfig \{\s*\n?\s*if \(typeof v !== 'object' \|\| v === null\) return false;\s*\n?\s*const r = v as Record<string, unknown>;\s*\n?\s*return \(\s*\n?\s*typeof r\.id === 'string' &&\s*\n?\s*typeof r\.label === 'string' &&\s*\n?\s*typeof r\.host === 'string' &&\s*\n?\s*typeof r\.port === 'number' &&\s*\n?\s*\(r\.username === null \|\| typeof r\.username === 'string'\) &&\s*\n?\s*\(r\.password === null \|\| typeof r\.password === 'string'\) &&\s*\n?\s*typeof r\.createdAt === 'string' &&\s*\n?\s*\(r\.serverId === undefined \|\| typeof r\.serverId === 'string'\)\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('setProxyServerId: caches the server account_proxies id on the local proxy (ARC A launch-sync mapping)', () => {
    expect(body).toContain('export async function setProxyServerId(');
    expect(body).toContain('serverId: string): Promise<ProxyConfig | null>');
  });

  it("mintId framing pinned: 'crypto.randomUUID is in WebCrypto in every Tauri WebView we ship.' preferred + 'Cheap fallback: 16 random hex chars. Good enough for local IDs.' loop fallback", () => {
    expect(body).toMatch(
      /\/\/ crypto\.randomUUID is in WebCrypto in every Tauri WebView we ship\.\s*\n?\s*if \(typeof globalThis\.crypto\?\.randomUUID === 'function'\) \{\s*\n?\s*return globalThis\.crypto\.randomUUID\(\);\s*\n?\s*\}\s*\n?\s*\/\/ Cheap fallback: 16 random hex chars\. Good enough for local IDs\.\s*\n?\s*let s = '';\s*\n?\s*for \(let i = 0; i < 16; i\+\+\) s \+= Math\.floor\(Math\.random\(\) \* 16\)\.toString\(16\);\s*\n?\s*return s;/,
    );
  });

  it("validateDraft: label/host non-empty after trim() (errors.label/host = 'Required.') + port Number.isInteger + range 1-65535 (errors.port = 'Port must be 1–65535.') + framing 'username/password are optional; if one is set the other isn't required (some SOCKS5 servers accept username-only auth).'", () => {
    expect(body).toMatch(
      /export function validateDraft\(d: ProxyDraft\): DraftValidation \{\s*\n?\s*const errors: Partial<Record<keyof ProxyDraft, string>> = \{\};\s*\n?\s*if \(d\.label\.trim\(\)\.length === 0\) errors\.label = 'Required\.';\s*\n?\s*if \(d\.host\.trim\(\)\.length === 0\) errors\.host = 'Required\.';\s*\n?\s*if \(!Number\.isInteger\(d\.port\) \|\| d\.port < 1 \|\| d\.port > 65535\) \{\s*\n?\s*errors\.port = 'Port must be 1–65535\.';\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ username\/password are optional; if one is set the other isn't required\s*\n?\s*\/\/ \(some SOCKS5 servers accept username-only auth\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
