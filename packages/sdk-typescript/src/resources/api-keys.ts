// ApiKeysResource — typed methods for /v1/api-keys.

import type { ApiKey, CreateApiKeyRequest, CreateApiKeyResponse } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface ApiKeyList {
  data: ApiKey[];
}

/**
 * V-296 — response shape for POST /v1/api-keys/:id/rotate. Includes the
 * new key's plaintext (shown ONCE), the previous key's id, and the
 * timestamp at which the previous key auto-revokes via the existing
 * expires_at-driven auth gate.
 */
export interface RotateApiKeyResponse extends CreateApiKeyResponse {
  rotated_from: string;
  grace_period_ends_at: string;
}

export interface RotateApiKeyOptions {
  /** Optional new name for the rotated key. Defaults to the old name. */
  name?: string;
}

export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a new API key. The plaintext is returned ONCE in the response;
   * store it now — it cannot be retrieved later. Requires the
   * `account_owner` scope on the calling key.
   */
  create(body: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    return this.http.request<CreateApiKeyResponse>({
      method: 'POST',
      path: '/v1/api-keys',
      body,
    });
  }

  /** List all API keys for the current account. Plaintext is never included. */
  list(): Promise<ApiKeyList> {
    return this.http.request<ApiKeyList>({ method: 'GET', path: '/v1/api-keys' });
  }

  /** Revoke an API key. Idempotent — revoking an already-revoked key is a no-op. */
  revoke(keyId: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/api-keys/${encodeURIComponent(keyId)}`,
    });
  }

  /**
   * V-296 — rotate an API key. Mints a fresh plaintext + sets the OLD key's
   * expires_at to now + 24h grace. Both keys work concurrently during the
   * grace window; deploy the new key, then the old key auto-revokes at the
   * grace boundary via the existing expires_at-driven auth gate.
   *
   * ⚠️ Two things the "now + 24h" above does not say, and both bite only when
   * the key you are rotating already carries an `expires_at` (optional at
   * create time, so most keys do not):
   *
   * - The grace never EXTENDS an expiry. It is `min(now + 24h, the key's own
   *   expires_at)`, so rotating a key that expires in an hour buys an hour,
   *   not a day.
   * - The successor INHERITS that same `expires_at`. Rotating a key because it
   *   is about to expire does not hand you a longer-lived one — set the expiry
   *   you want at create time, or leave it unset.
   *
   * Rotation also DE-ESCALATES (V-775): `driftstack_internal_admin` is dropped
   * and the legacy `admin` alias becomes `account_owner`, which carries the
   * same customer authority. Rotation is an issuance path and must not launder
   * a scope `create` would refuse.
   *
   * The new plaintext is returned ONCE in the response — store it now.
   */
  rotate(keyId: string, options: RotateApiKeyOptions = {}): Promise<RotateApiKeyResponse> {
    return this.http.request<RotateApiKeyResponse>({
      method: 'POST',
      path: `/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
      body: options,
    });
  }
}
