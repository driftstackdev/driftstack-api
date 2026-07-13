// AuthResource — typed methods for /v1/auth/* (V-079).
//
// Note: these endpoints don't require an API key (they ARE the auth
// gate). Customers using the auth flow do so from a browser dashboard
// against the SDK's HTTP layer; the API key on the client is unused
// for these calls (the server doesn't validate it). The resource is
// here for ergonomics + type safety, not for API-key-driven auth.

import type {
  CliAuthorizeBindRequest,
  CliAuthorizeBindResponse,
  CliAuthorizeExchangeRequest,
  CliAuthorizeExchangeResponse,
  CliAuthorizeInitiateRequest,
  CliAuthorizeInitiateResponse,
  LoginRequest,
  LoginResponseUnion,
  MfaChallengeRequest,
  MfaChallengeResponse,
  MfaStepUpRequest,
  MfaStepUpResponse,
  LogoutRequest,
  LogoutResponse,
  MagicLinkConsumeRequest,
  MagicLinkConsumeResponse,
  MagicLinkRequest,
  MagicLinkRequestResponse,
  PasswordResetConfirmRequest,
  PasswordResetConfirmResponse,
  PasswordResetRequest,
  PasswordResetRequestResponse,
  RefreshSessionRequest,
  RefreshSessionResponse,
  SignupRequest,
  SignupResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  signup(body: SignupRequest): Promise<SignupResponse> {
    return this.http.request<SignupResponse>({
      method: 'POST',
      path: '/v1/auth/signup',
      body,
    });
  }

  verifyEmail(body: VerifyEmailRequest): Promise<VerifyEmailResponse> {
    return this.http.request<VerifyEmailResponse>({
      method: 'POST',
      path: '/v1/auth/verify-email',
      body,
    });
  }

  /**
   * V-353d — discriminated-union response. When the account has MFA
   * enrolled, the server returns `{ mfa_required: true, challenge_token,
   * challenge_expires_at }` instead of a session. Branch on the
   * `mfa_required` literal:
   *
   *   const out = await client.auth.login({ email, password });
   *   if ('mfa_required' in out && out.mfa_required) {
   *     // exchange out.challenge_token via /v1/auth/mfa/challenge
   *   } else {
   *     // out.session is the real session
   *   }
   */
  login(body: LoginRequest): Promise<LoginResponseUnion> {
    return this.http.request<LoginResponseUnion>({
      method: 'POST',
      path: '/v1/auth/login',
      body,
    });
  }

  requestMagicLink(body: MagicLinkRequest): Promise<MagicLinkRequestResponse> {
    return this.http.request<MagicLinkRequestResponse>({
      method: 'POST',
      path: '/v1/auth/magic-link/request',
      body,
    });
  }

  consumeMagicLink(body: MagicLinkConsumeRequest): Promise<MagicLinkConsumeResponse> {
    return this.http.request<MagicLinkConsumeResponse>({
      method: 'POST',
      path: '/v1/auth/magic-link/consume',
      body,
    });
  }

  requestPasswordReset(body: PasswordResetRequest): Promise<PasswordResetRequestResponse> {
    return this.http.request<PasswordResetRequestResponse>({
      method: 'POST',
      path: '/v1/auth/password-reset/request',
      body,
    });
  }

  confirmPasswordReset(body: PasswordResetConfirmRequest): Promise<PasswordResetConfirmResponse> {
    return this.http.request<PasswordResetConfirmResponse>({
      method: 'POST',
      path: '/v1/auth/password-reset/confirm',
      body,
    });
  }

  refresh(body: RefreshSessionRequest): Promise<RefreshSessionResponse> {
    return this.http.request<RefreshSessionResponse>({
      method: 'POST',
      path: '/v1/auth/refresh',
      body,
    });
  }

  logout(body: LogoutRequest): Promise<LogoutResponse> {
    return this.http.request<LogoutResponse>({
      method: 'POST',
      path: '/v1/auth/logout',
      body,
    });
  }

  /**
   * V-445 — exchange a login challenge_token (returned on the
   * MFA-required branch) for a real session via TOTP code or recovery
   * code. Distinguished response carries `via: 'totp' | 'recovery'`.
   */
  mfaChallenge(body: MfaChallengeRequest): Promise<MfaChallengeResponse> {
    return this.http.request<MfaChallengeResponse>({
      method: 'POST',
      path: '/v1/auth/mfa/challenge',
      body,
    });
  }

  /**
   * V-445 — refresh `mfa_satisfied_at` on the calling web session
   * (V-353e step-up gate; 15-minute freshness window). No new session
   * issued; the existing session row's mfa timestamp advances. Pair
   * with `MfaStepUpRequiredError` recovery flows.
   */
  mfaStepUp(body: MfaStepUpRequest): Promise<MfaStepUpResponse> {
    return this.http.request<MfaStepUpResponse>({
      method: 'POST',
      path: '/v1/auth/mfa/step-up',
      body,
    });
  }

  /**
   * V-460 — V-266 CLI/GUI activation flow: initiate.
   *
   * The CLI/GUI calls this with a CSRF nonce + optional client label.
   * Returns a one-shot code, a separate user code displayed by the
   * initiating device, and the browser URL. The user types that code in
   * the dashboard before the CLI/GUI can receive the API key.
   */
  cliAuthorizeInitiate(body: CliAuthorizeInitiateRequest): Promise<CliAuthorizeInitiateResponse> {
    return this.http.request<CliAuthorizeInitiateResponse>({
      method: 'POST',
      path: '/v1/auth/cli-authorize/initiate',
      body,
    });
  }

  /**
   * V-460 — V-266 CLI/GUI activation flow: bind.
   *
   * Web-session-authenticated. Called by the dashboard's
   * /cli/authorize confirmation page after the user enters the initiating
   * device's `user_code` and clicks Authorize:
   * mints an API key on the calling account and stages it for delivery
   * to the CLI/GUI through the exchange endpoint. Default scopes are
   * `["account_owner"]` server-side.
   */
  cliAuthorizeBind(body: CliAuthorizeBindRequest): Promise<CliAuthorizeBindResponse> {
    return this.http.request<CliAuthorizeBindResponse>({
      method: 'POST',
      path: '/v1/auth/cli-authorize/bind-device-code',
      body,
    });
  }

  /**
   * V-460 — V-266 CLI/GUI activation flow: exchange.
   *
   * Polled by the CLI/GUI. Returns one of three branches:
   * - `{ status: 'pending' }` — keep polling.
   * - `{ status: 'bound', api_key, account_id }` — one-shot delivery
   *   of the plaintext API key. Subsequent calls 404.
   * - `{ status: 'expired' }` — user took too long; restart the flow.
   */
  cliAuthorizeExchange(body: CliAuthorizeExchangeRequest): Promise<CliAuthorizeExchangeResponse> {
    return this.http.request<CliAuthorizeExchangeResponse>({
      method: 'POST',
      path: '/v1/auth/cli-authorize/exchange',
      body,
    });
  }
}
