// ProfilesResource — typed methods for /v1/profiles (V-081).

import type {
  CloneProfileRequest,
  CreateProfileRequest,
  PaginationQueryInput,
  Profile,
  UpdateProfileRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface ProfilesListPage {
  data: Profile[];
  has_more: boolean;
  next_cursor: string | null;
}

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

  /** Delete a profile. Idempotent. */
  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/profiles/${encodeURIComponent(id)}`,
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
}
