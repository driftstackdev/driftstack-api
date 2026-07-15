// ProfilesResource — typed methods for /v1/profiles (V-081).

import type {
  CloneProfileRequest,
  CreateProfileRequest,
  PaginationQueryInput,
  Profile,
  Session,
  UpdateProfileRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface ProfilesListPage {
  data: Profile[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * V-480 — versioned, metadata-only export envelope. Per-profile browser
 * state lives driver-side and is out of scope for the v1 envelope; the
 * `version` literal lets a future v2 stay back-compat. `source_*` fields
 * are informational — import always mints a fresh id, into any account.
 */
export interface ProfileExportEnvelope {
  version: 1;
  exported_at: string;
  source_profile_id: string;
  source_account_id: string;
  profile: { name: string; archetype: string; description: string | null };
}

/** Body for `import()` — a v1 export envelope + optional rename. */
export interface ImportProfileRequest {
  envelope: ProfileExportEnvelope;
  /** Rename on import without editing the file; uses `envelope.profile.name` when omitted. */
  name_override?: string;
}

/** Response from `transfer()` — the recipient's freshly-minted profile. */
export interface TransferProfileResponse {
  new_profile: Profile;
  recipient_account_id: string;
}

/**
 * doc-150 §8 — discriminated response from `trim()`. The server ALWAYS returns
 * HTTP 200 with one of these shapes (branch on `status`, never the HTTP code):
 *  - `ok`          → caches cleared; `bytes_reclaimed` freed, `size_bytes` is the
 *                    new (smaller) sealed-store size persisted server-side.
 *  - `unavailable` → nothing to trim (fresh profile / storage trim not wired /
 *                    no connected node). `reason` is human-readable. Not an error.
 *  - `timeout`     → the session node did not respond in time. Safe to retry.
 *  - `error`       → the node reported a failure; the stored blob is untouched.
 */
export type TrimProfileResponse =
  | { status: 'ok'; size_bytes: number; bytes_reclaimed: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'timeout' }
  | { status: 'error'; reason: string };

export class ProfilesResource {
  constructor(private readonly http: HttpClient) {}

  /** Create a new profile. Tier-limit enforced server-side; throws TierLimitError on cap. */
  create(body: CreateProfileRequest): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'POST',
      path: '/v1/profiles',
      body,
    });
  }

  /** List profiles for the calling account. Cursor-paginated. */
  list(query: PaginationQueryInput = {}): Promise<ProfilesListPage> {
    return this.http.request<ProfilesListPage>({
      method: 'GET',
      path: '/v1/profiles',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /**
   * Lazily iterate every profile for the calling account, walking
   * cursor pages automatically. See `iteratePaginated` for semantics.
   */
  iterate(opts: { limit?: number } = {}): AsyncGenerator<Profile, void, void> {
    return iteratePaginated<Profile>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /** Get a single profile. */
  get(id: string): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'GET',
      path: `/v1/profiles/${encodeURIComponent(id)}`,
    });
  }

  /** Update a profile (partial). */
  update(id: string, body: UpdateProfileRequest): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'PATCH',
      path: `/v1/profiles/${encodeURIComponent(id)}`,
      body,
    });
  }

  /**
   * 2026-05-20 — antidetect-browser-style one-shot launch. Creates a
   * session bound to this profile (archetype + metadata inherited from
   * the profile, last_used_at bumped server-side). Body shape is
   * {label?} — everything else flows from the profile. Returns the
   * freshly-minted Session (use sessions.destroy to stop).
   *
   * This resource and `sessions.create()` intentionally accept no
   * per-session egress field. A previously accepted `proxy` field silently
   * did nothing, so passing one is now a compile error rather than a no-op.
   * For customer-controlled egress, use
   * `client.agentSessions.create({ proxy_id })` with one of your saved
   * `account_proxies`; the assigned browser runtime applies that proxy.
   */
  launch(id: string, body: { label?: string } = {}): Promise<Session> {
    return this.http.request<Session>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(id)}/launch`,
      body,
    });
  }

  /** Delete a profile. Idempotent. Soft delete (L4b) — recoverable via restore(). */
  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/profiles/${encodeURIComponent(id)}`,
    });
  }

  /**
   * L4b recycle bin — list the account's trashed (soft-deleted) profiles,
   * most-recently trashed first. Each carries `deleted_at`.
   */
  listTrash(): Promise<{ data: Profile[] }> {
    return this.http.request<{ data: Profile[] }>({
      method: 'GET',
      path: '/v1/profiles/trash',
    });
  }

  /**
   * L4b recycle bin — restore a trashed profile (clears `deleted_at`). 404 if
   * there's no trashed profile with that id; 409 if a live profile already
   * holds the name (rename it first).
   */
  restore(id: string): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(id)}/restore`,
    });
  }

  /**
   * L4b recycle bin — permanently delete a trashed profile, freeing its cap
   * slot immediately (trashed profiles otherwise count toward the tier limit
   * until the 30-day auto-purge). 404 if there's no trashed profile with that
   * id. Irreversible.
   */
  purge(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/profiles/${encodeURIComponent(id)}/purge`,
    });
  }

  /**
   * V-313 — duplicate a profile. Server auto-derives a "(copy)" /
   * "(copy 2)" / ... name when `body.name` is omitted. Tier-cap +
   * name-conflict checked the same as create.
   */
  clone(id: string, body: CloneProfileRequest = {}): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(id)}/clone`,
      body,
    });
  }

  /**
   * V-480 — export this profile as a versioned, metadata-only JSON
   * envelope. Feed the result to `import()` (in any account) to mint a
   * fresh profile from it.
   */
  export(id: string): Promise<ProfileExportEnvelope> {
    return this.http.request<ProfileExportEnvelope>({
      method: 'GET',
      path: `/v1/profiles/${encodeURIComponent(id)}/export`,
    });
  }

  /**
   * V-480 — import a profile from a v1 export envelope, minting a fresh
   * profile in the calling account. Tier-cap + name-conflict semantics
   * match `create`. Importing an envelope from a different account is
   * permitted (file-based transfer between teammates).
   */
  import(body: ImportProfileRequest): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'POST',
      path: '/v1/profiles/import',
      body,
    });
  }

  /**
   * V-666 — transfer ownership of a profile to another Driftstack
   * account by its `acc_<uuid>` id (shared out-of-band; no email path).
   * Mints a copy in the recipient's account; returns it + the recipient id.
   */
  transfer(id: string, body: { recipient_account_id: string }): Promise<TransferProfileResponse> {
    return this.http.request<TransferProfileResponse>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(id)}/transfer`,
      body,
    });
  }

  /**
   * doc-150 §8 — "Clear cache, keep logins". Reclaims a profile's re-fetchable
   * caches (HTTP/media/DOMCache/service-workers) WITHOUT touching logins,
   * localStorage, IndexedDB or open tabs — the headline reclaim action when an
   * account is over its storage cap. The server always responds 200 with a
   * DISCRIMINATED body; branch on `status` (see `TrimProfileResponse`), not the
   * HTTP code. On `ok` the profile's `size_bytes` is updated server-side, so a
   * subsequent list reflects the smaller size.
   */
  trim(id: string): Promise<TrimProfileResponse> {
    return this.http.request<TrimProfileResponse>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(id)}/trim`,
    });
  }
}
