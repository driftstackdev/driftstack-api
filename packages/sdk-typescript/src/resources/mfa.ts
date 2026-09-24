// MfaResource — typed methods for /v1/account/mfa/*.
//
// Enrollment management (status / enroll / verify / disable / regenerate
// recovery codes). Uses the calling web-session bearer; the
// X-Driftstack-Account team-RBAC header is not honored — MFA is per-
// account, not per-team-context.
//
// Pairs with `client.auth.mfaChallenge` (login MFA exchange) +
// `client.auth.mfaStepUp` (the step-up gate).

import type { HttpClient } from '../http.js';

export interface MfaStatusResponse {
  enrolled: boolean;
  enrolled_at: string | null;
  last_used_at: string | null;
  unused_recovery_codes: number;
}

export interface MfaEnrollResponse {
  /** otpauth:// URI for QR-code rendering in an authenticator app. */
  otpauth_uri: string;
  /** Plaintext base32-encoded TOTP secret for manual entry. */
  secret_base32: string;
  algorithm: 'SHA1';
  digits: 6;
  period_seconds: 30;
}

export interface MfaVerifyRequest {
  /** First 6-digit TOTP code from the customer's authenticator app. */
  code: string;
  /**
   * The account's current password. Required when the account has one; an
   * account without a password (created by Google or GitHub sign-in) leaves it
   * out and needs a sign-in from the last ten minutes instead.
   */
  current_password?: string;
}

export interface MfaVerifyResponse {
  /** 10 single-use recovery codes; shown ONCE. */
  recovery_codes: string[];
}

export interface MfaDisableRequest {
  /** Literal 'disable-mfa' confirmation phrase. */
  confirm: 'disable-mfa';
}

export class MfaResource {
  constructor(private readonly http: HttpClient) {}

  /** Read MFA enrollment state for the calling account. */
  status(): Promise<MfaStatusResponse> {
    return this.http.request<MfaStatusResponse>({
      method: 'GET',
      path: '/v1/account/mfa',
    });
  }

  /**
   * Start TOTP enrollment. Customer scans `otpauth_uri` with their
   * authenticator app, then calls `verify(...)` with the first
   * 6-digit code. Server stores the secret encrypted at rest;
   * plaintext is shown ONCE here.
   */
  enroll(): Promise<MfaEnrollResponse> {
    return this.http.request<MfaEnrollResponse>({
      method: 'POST',
      path: '/v1/account/mfa/enroll',
      body: {},
    });
  }

  /** Confirm enrollment with the first code. Returns 10 recovery codes. */
  verify(body: MfaVerifyRequest): Promise<MfaVerifyResponse> {
    return this.http.request<MfaVerifyResponse>({
      method: 'POST',
      path: '/v1/account/mfa/verify',
      body,
    });
  }

  /**
   * Disable MFA. Requires fresh MFA proof per the step-up gate
   * (15-minute freshness window) — call `client.auth.mfaStepUp(...)`
   * first if the gate is stale. Recovery codes are invalidated.
   */
  disable(body: MfaDisableRequest): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: '/v1/account/mfa',
      body,
    });
  }

  /** Mint 10 fresh recovery codes. Old codes invalidated; shown ONCE. */
  regenerateRecoveryCodes(): Promise<MfaVerifyResponse> {
    return this.http.request<MfaVerifyResponse>({
      method: 'POST',
      path: '/v1/account/mfa/recovery-codes/regenerate',
      body: {},
    });
  }
}
