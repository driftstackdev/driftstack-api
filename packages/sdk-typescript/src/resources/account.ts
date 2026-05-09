// AccountResource — typed methods for /v1/account/*.
//
// V-237 introduced GET /v1/account/me as the customer self-profile
// endpoint. V-298a/V-298b/V-352b/V-353h/V-326c added slug, region,
// avatar_url, mfa_enrolled, and teams fields. The shape below mirrors
// the server's full /me response.

import type { AccountTier } from '@driftstack/api-types';
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
}
