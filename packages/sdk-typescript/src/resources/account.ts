// AccountResource — typed methods for /v1/account/*.
//
// V-237 introduced GET /v1/account/me as the customer self-profile
// endpoint. V-298a/V-298b/V-352b/V-353h/V-326c added slug, region,
// avatar_url, mfa_enrolled, and teams fields. The shape below mirrors
// the server's full /me response.
//
// V-450 — also wraps /web-sessions list + revoke, /me/avatar
// upload + clear, and /rate-limits read.

import type {
  AccountTier,
  UpdateAccountMeRequest,
  UploadAvatarRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface AccountSelfProfile {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  /** V-352 — IANA timezone (e.g. "Europe/Amsterdam"); null = UTC fallback. */
  timezone: string | null;
  /** V-298a — readable account handle; null when unset. */
  slug: string | null;
  /** V-298b — stated infrastructure-region preference; null when unset. */
  region: 'us' | 'eu' | 'apac' | null;
  /** V-352b — short-lived (~1h) presigned R2 GET URL; null when no avatar. */
  avatar_url: string | null;
  /** V-353h — true once TOTP enrollment is verified. */
  mfa_enrolled: boolean;
  /** Concurrent session cap for this account's tier. */
  concurrent_session_cap: number;
  /** Active sessions right now (live count, not cached). */
  concurrent_session_active: number;
  /** Profile cap for this tier; null for enterprise (negotiated). */
  profile_cap: number | null;
  /** Existing profiles right now (live count, not cached). */
  profile_count: number;
  /** V-326c — team memberships the calling account holds. Empty when none. */
  teams: Array<{
    owner_account_id: string;
    role: 'admin' | 'member';
    membership_id: string;
  }>;
}

// V-355 — active dashboard sign-in for the calling account.
export interface WebSessionEntry {
  id: string;
  os: string;
  browser: string;
  last_used_at: string;
  expires_at: string;
  /** True when this entry is the calling session itself. */
  current: boolean;
}

export interface ListWebSessionsResponse {
  data: WebSessionEntry[];
}

// V-352b — avatar upload response. Presigned R2 URL is short-lived (~1h).
export interface UploadAvatarResponse {
  avatar_url: string | null;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
}

// V-258 — effective rate-limit config (per-bucket capacity + refill).
export interface RateLimitBucket {
  bucket_key: 'global' | 'sessions:create';
  capacity: number;
  refill_per_second: number;
  source: 'tier_default' | 'override';
  override_expires_at: string | null;
}

export interface GetAccountRateLimitsResponse {
  tier: string;
  buckets: RateLimitBucket[];
}

export class AccountResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * V-237 — customer self-profile. Powers the GUI client's
   * "X / Y concurrent sessions" + "P / Q profiles" header gates.
   */
  me(): Promise<AccountSelfProfile> {
    return this.http.request<AccountSelfProfile>({
      method: 'GET',
      path: '/v1/account/me',
    });
  }

  /** V-352 — partial update of the calling account (name / timezone / slug / region). */
  updateMe(body: UpdateAccountMeRequest): Promise<AccountSelfProfile> {
    return this.http.request<AccountSelfProfile>({
      method: 'PATCH',
      path: '/v1/account/me',
      body,
    });
  }

  /** V-352b — upload (or replace) the calling account avatar. */
  uploadAvatar(body: UploadAvatarRequest): Promise<UploadAvatarResponse> {
    return this.http.request<UploadAvatarResponse>({
      method: 'POST',
      path: '/v1/account/me/avatar',
      body,
    });
  }

  /** V-352b — clear the calling account avatar pointer. */
  clearAvatar(): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: '/v1/account/me/avatar',
    });
  }

  /** V-355 — list active dashboard sign-ins for the calling account. */
  listWebSessions(): Promise<ListWebSessionsResponse> {
    return this.http.request<ListWebSessionsResponse>({
      method: 'GET',
      path: '/v1/account/web-sessions',
    });
  }

  /** V-355 — revoke a single web session by id. Idempotent. */
  revokeWebSession(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/account/web-sessions/${encodeURIComponent(id)}`,
    });
  }

  /** V-355 — revoke every web session except the calling one. */
  revokeAllOtherWebSessions(): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: '/v1/account/web-sessions',
    });
  }

  /** V-258 — read effective rate-limit config (per-bucket caps + override status). */
  rateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.http.request<GetAccountRateLimitsResponse>({
      method: 'GET',
      path: '/v1/account/rate-limits',
    });
  }
}
