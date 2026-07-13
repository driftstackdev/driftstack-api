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

import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';

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

/** Builds the auth headers, adding the workspace scope header when a team
 *  workspace is active so the taxonomy resolves against the SAME account the
 *  profiles do (the SDK client sends this on every profile request). Without it
 *  the org sync silently resolved against the PERSONAL account while the profiles
 *  it organizes live in the workspace — an account-scope mismatch. (audit) */
function orgHeaders(
  apiKey: string,
  effectiveAccount: string | null,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(effectiveAccount !== null ? { 'x-driftstack-account': effectiveAccount } : {}),
    ...extra,
  };
}

/** GET the account's taxonomy. Throws on non-2xx / network error (caller
 *  falls back to the local cache when offline). Pass the active workspace
 *  (owner account id) or null for personal scope. */
export async function fetchOrganization(
  baseUrl: string,
  apiKey: string,
  effectiveAccount: string | null = null,
): Promise<AccountOrganization> {
  const res = await fetchWithDeadline(orgUrl(baseUrl), {
    method: 'GET',
    headers: orgHeaders(apiKey, effectiveAccount, { accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`organization fetch failed: ${res.status.toString()}`);
  const body = await readBoundedApiJson<Partial<AccountOrganization>>(res);
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
 *  the caller's perspective — a failure leaves the local cache as the source.
 *  Pass the active workspace (owner account id) or null for personal scope so
 *  the write lands on the SAME account the profiles do. */
export async function saveOrganization(
  baseUrl: string,
  apiKey: string,
  org: AccountOrganization,
  effectiveAccount: string | null = null,
): Promise<void> {
  const res = await fetchWithDeadline(orgUrl(baseUrl), {
    method: 'PUT',
    headers: orgHeaders(apiKey, effectiveAccount, { 'content-type': 'application/json' }),
    body: JSON.stringify(org),
  });
  if (!res.ok) throw new Error(`organization save failed: ${res.status.toString()}`);
}
