// ApiKeysResource — typed methods for /v1/api-keys.

import type { ApiKey, CreateApiKeyRequest, CreateApiKeyResponse } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface ApiKeyList {
  data: ApiKey[];
}

export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a new API key. The plaintext is returned ONCE in the response;
   * store it now — it cannot be retrieved later. Requires the `admin` scope
   * on the calling key.
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
}
