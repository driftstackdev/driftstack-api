// ProfileSnapshotsResource — typed methods for /v1/profiles/:id/snapshots
// + /v1/profile-snapshots (V-312). Immutable point-in-time copies of
// saved profiles. Capture from a parent profile, list per-profile or
// across the whole account, restore into a new profile (tier-cap +
// name-conflict checked the same way as profiles.create), or delete.

import type {
  CaptureSnapshotRequest,
  PaginationQueryInput,
  Profile,
  ProfileSnapshot,
  RestoreSnapshotRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface ProfileSnapshotsListPage {
  data: ProfileSnapshot[];
  has_more: boolean;
  next_cursor: string | null;
}

export class ProfileSnapshotsResource {
  constructor(private readonly http: HttpClient) {}

  /** Capture a snapshot of an existing profile. */
  capture(profileId: string, body: CaptureSnapshotRequest): Promise<ProfileSnapshot> {
    return this.http.request<ProfileSnapshot>({
      method: 'POST',
      path: `/v1/profiles/${encodeURIComponent(profileId)}/snapshots`,
      body,
    });
  }

  /** List snapshots for one specific profile. Newest-first. */
  listForProfile(
    profileId: string,
    query: PaginationQueryInput = {},
  ): Promise<ProfileSnapshotsListPage> {
    return this.http.request<ProfileSnapshotsListPage>({
      method: 'GET',
      path: `/v1/profiles/${encodeURIComponent(profileId)}/snapshots`,
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /** List every snapshot owned by the EFFECTIVE account — your own, or the
   *  owner you are acting as via `X-Driftstack-Account`. V-1121 — this named
   *  the caller rather than the effective owner; the handler resolves the team
   *  header first. */
  list(query: PaginationQueryInput = {}): Promise<ProfileSnapshotsListPage> {
    return this.http.request<ProfileSnapshotsListPage>({
      method: 'GET',
      path: '/v1/profile-snapshots',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /**
   * Lazily iterate every snapshot for the EFFECTIVE account, walking
   * cursor pages automatically. See `iteratePaginated` for semantics.
   */
  iterate(opts: { limit?: number } = {}): AsyncGenerator<ProfileSnapshot, void, void> {
    return iteratePaginated<ProfileSnapshot>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /** Get a single snapshot. */
  get(id: string): Promise<ProfileSnapshot> {
    return this.http.request<ProfileSnapshot>({
      method: 'GET',
      path: `/v1/profile-snapshots/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Restore a snapshot into a new profile. Throws TierLimitError on
   * cap, ConflictError on name conflict.
   */
  restore(id: string, body: RestoreSnapshotRequest): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'POST',
      path: `/v1/profile-snapshots/${encodeURIComponent(id)}/restore`,
      body,
    });
  }

  /** Delete a snapshot. */
  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/profile-snapshots/${encodeURIComponent(id)}`,
    });
  }
}
