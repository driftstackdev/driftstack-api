// AccountResource — typed methods for /v1/account/*.
//
// V-237 introduced GET /v1/account/me as the customer self-profile
// endpoint powering the GUI client's tier-aware enforcement display.
// Future /v1/account/* endpoints (audit-log, email-preferences,
// rate-limits) get accessor methods here as they're plumbed through
// the SDK.

import type { AccountTier } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface AccountSelfProfile {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  /** Concurrent session cap for this account's tier. */
  concurrent_session_cap: number;
  /** Active sessions right now (live count, not cached). */
  concurrent_session_active: number;
  /** Profile cap for this tier; null for enterprise (negotiated). */
  profile_cap: number | null;
  /** Existing profiles right now (live count, not cached). */
  profile_count: number;
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
