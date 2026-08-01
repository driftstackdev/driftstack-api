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
  /** Whether avatar_url is a removable upload, read-only IDP fallback, or absent. */
  avatar_source: 'user' | 'idp' | 'none';
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
  /** V-326c — team memberships the calling account holds. Empty when none.
   *  `owner_email`/`owner_name` let the dashboard label a team by who owns it
   *  (instead of a bare acc_<uuid>); email is always present, name is null
   *  when the owner never set a display name. */
  teams: Array<{
    owner_account_id: string;
    owner_email: string;
    owner_name: string | null;
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
// Bucket keys mirror the server's BUCKET_KEYS / TIER_RATE_LIMIT_DEFAULTS —
// all four enforced buckets, so an exhaustive switch over `bucket_key` covers
// every limit the server actually returns (the agent_sessions:* pair was
// previously omitted, leaving real buckets unhandled).
export interface RateLimitBucket {
  bucket_key:
    | 'global'
    | 'sessions:create'
    | 'agent_sessions:message'
    | 'agent_sessions:input_event';
  capacity: number;
  refill_per_second: number;
  source: 'tier_default' | 'override';
  override_expires_at: string | null;
}

export interface GetAccountRateLimitsResponse {
  tier: string;
  buckets: RateLimitBucket[];
}

// Arc 1 sub-slice 6.6/6.7 — bundled-LLM settings + spend status. Lets the GUI
// give the customer an in-app fix for BundledLlmConsentRequiredError /
// BundledLlmBudgetExhaustedError instead of pointing at a raw curl command.
export interface BundledLlmSettings {
  consent: boolean;
  monthly_cap_usd_cents: number;
}

export interface BundledLlmStatus {
  consent: boolean;
  cap_cents: number;
  used_this_month_cents: number;
  remaining_cents: number;
  refused_count_this_month: number;
  month_started_at: string;
}

export interface UpdateBundledLlmSettingsRequest {
  consent?: boolean;
  monthly_cap_usd_cents?: number;
}

// AI-CHAT BYOK Anthropic — customer key metadata (never plaintext) + set/test.
export interface ByokAnthropicKeyMetadata {
  has_key: boolean;
  set_at: string | null;
  last_used_at: string | null;
}

export interface SetByokAnthropicKeyResponse {
  set_at: string;
}

export type TestByokAnthropicKeyResult = { ok: true } | { ok: false; reason: string };

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
      // The endpoint REFUSES a bulk revoke without this: "Bulk revoke requires
      // `?keep=current`. Pass it explicitly to confirm intent." Omitting it made
      // this method a guaranteed 400 in every SDK. The dashboard has always sent
      // it (security.astro), which is why the flow worked there and not here.
      query: { keep: 'current' },
    });
  }

  /** V-258 — read effective rate-limit config (per-bucket caps + override status). */
  rateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.http.request<GetAccountRateLimitsResponse>({
      method: 'GET',
      path: '/v1/account/rate-limits',
    });
  }

  /** Arc 1 sub-slice 6.6 — read current bundled-LLM consent + monthly cap. */
  getBundledLlmSettings(): Promise<BundledLlmSettings> {
    return this.http.request<BundledLlmSettings>({
      method: 'GET',
      path: '/v1/account/me/bundled-llm-settings',
    });
  }

  /** Arc 1 sub-slice 6.6 — flip consent and/or raise/lower the monthly cap.
   *  account_owner scope required server-side. */
  updateBundledLlmSettings(body: UpdateBundledLlmSettingsRequest): Promise<BundledLlmSettings> {
    return this.http.request<BundledLlmSettings>({
      method: 'PATCH',
      path: '/v1/account/me/bundled-llm-settings',
      body,
    });
  }

  /** Arc 1 sub-slice 6.7 — consent + cap + month-to-date spend + remaining
   *  headroom, for the "you've used $X of $Y" dashboard/GUI display. */
  getBundledLlmStatus(): Promise<BundledLlmStatus> {
    return this.http.request<BundledLlmStatus>({
      method: 'GET',
      path: '/v1/account/me/bundled-llm-status',
    });
  }

  /** AI-CHAT BYOK — metadata only (has_key/set_at/last_used_at); never the
   *  plaintext key. Broad read or account_owner scope required server-side. */
  getByokAnthropicKey(): Promise<ByokAnthropicKeyMetadata> {
    return this.http.request<ByokAnthropicKeyMetadata>({
      method: 'GET',
      path: '/v1/account/me/byok-anthropic-key',
    });
  }

  /** AI-CHAT BYOK — set or rotate the account's own Anthropic key.
   *  account_owner scope required server-side. */
  setByokAnthropicKey(apiKey: string): Promise<SetByokAnthropicKeyResponse> {
    return this.http.request<SetByokAnthropicKeyResponse>({
      method: 'PUT',
      path: '/v1/account/me/byok-anthropic-key',
      body: { api_key: apiKey },
    });
  }

  /** AI-CHAT BYOK — clear the stored key. Idempotent.
   *  account_owner scope required server-side. */
  clearByokAnthropicKey(): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: '/v1/account/me/byok-anthropic-key',
    });
  }

  /** AI-CHAT BYOK — connection test against the stored key, without ever
   *  echoing it back. account_owner scope required server-side. */
  testByokAnthropicKey(): Promise<TestByokAnthropicKeyResult> {
    return this.http.request<TestByokAnthropicKeyResult>({
      method: 'POST',
      path: '/v1/account/me/byok-anthropic-key/test',
    });
  }
}
