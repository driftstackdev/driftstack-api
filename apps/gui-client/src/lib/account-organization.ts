// Per-account organization TAXONOMY sync (2026-06-16, org-sync phase 3c).
//
// The empty folders (+icons) and tags a customer defines in the rail before
// assigning them used to live only in this machine's Tauri store. The server
// now persists them per-account (accounts.organization jsonb, 0079) behind
// GET/PUT /v1/account/me/organization. This module is the thin transport: a
// raw authed fetch (mirrors lib/use-account-me.ts) rather than an SDK method —
// the SDK account surface is parity-locked across 3 SDKs, not worth widening
// for a GUI-only feature. folders-store/tags-store remain the OFFLINE cache;
// ProfilesView reconciles (server wins on a successful load, pushes on mutate).

export interface OrgFolder {
  name: string;
  icon?: string;
}
export interface AccountOrganization {
  folders: OrgFolder[];
  tags: string[];
}

function orgUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/account/me/organization`;
}

/** GET the account's taxonomy. Throws on non-2xx / network error (caller
 *  falls back to the local cache when offline). */
export async function fetchOrganization(
  baseUrl: string,
  apiKey: string,
): Promise<AccountOrganization> {
  const res = await fetch(orgUrl(baseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`organization fetch failed: ${res.status.toString()}`);
  const body = (await res.json()) as Partial<AccountOrganization>;
  return {
    folders: Array.isArray(body.folders)
      ? body.folders.filter((f) => typeof f?.name === 'string')
      : [],
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

/** PUT the full taxonomy (account_owner-scoped server-side). Best-effort from
 *  the caller's perspective — a failure leaves the local cache as the source. */
export async function saveOrganization(
  baseUrl: string,
  apiKey: string,
  org: AccountOrganization,
): Promise<void> {
  const res = await fetch(orgUrl(baseUrl), {
    method: 'PUT',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(org),
  });
  if (!res.ok) throw new Error(`organization save failed: ${res.status.toString()}`);
}
