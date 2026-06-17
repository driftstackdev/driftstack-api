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

export type AccountProxyScheme = 'socks5' | 'http';

/** Server view — never carries the password (has_password instead). */
export interface AccountProxyMeta {
  id: string;
  label: string;
  scheme: AccountProxyScheme;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

/** Create body. `password` is write-only; omit (or null) for no password. */
export interface AccountProxyInput {
  label: string;
  scheme?: AccountProxyScheme;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
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
  const res = await fetch(base(baseUrl), { method: 'GET', headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`proxies fetch failed: ${res.status.toString()}`);
  const body = (await res.json()) as { data?: unknown };
  return Array.isArray(body.data) ? (body.data as AccountProxyMeta[]) : [];
}

export async function createProxy(
  baseUrl: string,
  apiKey: string,
  input: AccountProxyInput,
): Promise<AccountProxyMeta> {
  const res = await fetch(base(baseUrl), {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`proxy create failed: ${res.status.toString()}`);
  return (await res.json()) as AccountProxyMeta;
}

export async function updateProxy(
  baseUrl: string,
  apiKey: string,
  id: string,
  patch: AccountProxyUpdate,
): Promise<AccountProxyMeta> {
  const res = await fetch(`${base(baseUrl)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`proxy update failed: ${res.status.toString()}`);
  return (await res.json()) as AccountProxyMeta;
}

export async function deleteProxy(baseUrl: string, apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${base(baseUrl)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  });
  // 204 expected; 404 = already gone (idempotent from the caller's view).
  if (!res.ok && res.status !== 404) {
    throw new Error(`proxy delete failed: ${res.status.toString()}`);
  }
}
