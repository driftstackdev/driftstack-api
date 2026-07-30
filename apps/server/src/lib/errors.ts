// Error taxonomy for the API.
//
// Every thrown error that surfaces to the response layer is one of these
// `ApiError` subclasses. The error middleware (apps/server/src/middleware/
// error-handler.ts) converts them to RFC 7807 problem+json responses.
//
// Anything *else* that escapes — a TypeError, a Drizzle error, a pino crash —
// is logged at error level and replied as Internal (500) with a stable
// problem-type. We never leak raw error messages to clients.

import { PROBLEM_TYPES, type Problem, type ProblemType } from '@driftstack/api-types';

export interface ApiErrorOptions {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly type: ProblemType;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(opts: ApiErrorOptions) {
    super(opts.detail ?? opts.title, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ApiError';
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.detail = opts.detail;
    this.extensions = opts.extensions ?? {};
  }

  toProblem(instance?: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(instance !== undefined ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export class BadRequestError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.BadRequest,
      title: 'Bad Request',
      status: 400,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends ApiError {
  constructor(issues: unknown) {
    super({
      type: PROBLEM_TYPES.ValidationFailed,
      title: 'Validation Failed',
      status: 400,
      detail: 'One or more fields failed validation.',
      extensions: { issues },
    });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(detail = 'API key missing or invalid.') {
    super({
      type: PROBLEM_TYPES.Unauthorized,
      title: 'Unauthorized',
      status: 401,
      detail,
    });
    this.name = 'UnauthorizedError';
  }
}

export class InvalidKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.InvalidKey,
      title: 'Invalid API key',
      status: 401,
      detail: 'The supplied API key is not recognised.',
    });
    this.name = 'InvalidKeyError';
  }
}

export class RevokedKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.RevokedKey,
      title: 'API key revoked',
      status: 401,
      detail: 'This API key has been revoked.',
    });
    this.name = 'RevokedKeyError';
  }
}

export class ExpiredKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.ExpiredKey,
      title: 'API key expired',
      status: 401,
      detail: 'This API key has expired.',
    });
    this.name = 'ExpiredKeyError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(detail = 'Caller is not permitted to perform this action.') {
    super({
      type: PROBLEM_TYPES.Forbidden,
      title: 'Forbidden',
      status: 403,
      detail,
    });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(detail = 'Resource not found.') {
    super({
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
      status: 404,
      detail,
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.Conflict,
      title: 'Conflict',
      status: 409,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'ConflictError';
  }
}

export class RateLimitedError extends ApiError {
  constructor(retryAfterSeconds: number, detail = 'Rate limit exceeded.') {
    super({
      type: PROBLEM_TYPES.RateLimited,
      title: 'Too Many Requests',
      status: 429,
      detail,
      extensions: { retry_after_seconds: retryAfterSeconds },
    });
    this.name = 'RateLimitedError';
  }
}

export class ConcurrencyLimitError extends ApiError {
  constructor(currentSessions: number, limit: number) {
    super({
      type: PROBLEM_TYPES.ConcurrencyLimit,
      title: 'Concurrent session limit reached',
      status: 429,
      detail: `Account already has ${currentSessions.toString()} active sessions; tier permits ${limit.toString()}.`,
      extensions: { current_sessions: currentSessions, limit },
    });
    this.name = 'ConcurrencyLimitError';
  }
}

export class TierLimitError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.TierLimit,
      title: 'Tier limit reached',
      status: 429,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'TierLimitError';
  }
}

// doc-150 item 6 — per-account profile-storage quota reached. Raised at
// session-launch when a profile-backed session-create would grow the
// account's stored state past its tier's hard cap (the SUM of every live
// profile's size_bytes). 409 Conflict (the request conflicts with the
// account's current storage state, like the per-tier name/limit conflicts).
// Extensions carry the byte numbers so the dashboard + SDK consumers can
// render the precise overage without re-querying. Enterprise is soft-only
// and never raises this; sessions without a profile are never blocked.
export class StorageQuotaExceededError extends ApiError {
  constructor(args: { usedBytes: number; capBytes: number; tier: string }) {
    super({
      type: PROBLEM_TYPES.StorageQuotaExceeded,
      title: 'Storage quota reached',
      // The human `detail` reads in GiB (the caps are whole-GiB per-tier, so
      // "5 GiB" is far more legible than "5368709120 bytes"); the structured
      // `used_bytes`/`cap_bytes` extensions below stay RAW bytes for machine
      // consumers (dashboard/SDK render their own precise overage).
      status: 409,
      detail:
        `Your profiles use ${formatGiB(args.usedBytes)}, which has reached the ` +
        `${formatGiB(args.capBytes)} storage limit for the "${args.tier}" tier. ` +
        `Delete or trim a profile, or upgrade your tier, then launch again. ` +
        `Sessions without a profile are not affected.`,
      extensions: {
        used_bytes: args.usedBytes,
        cap_bytes: args.capBytes,
        tier: args.tier,
        resource: 'profile_storage',
      },
    });
    this.name = 'StorageQuotaExceededError';
  }
}

// A3 finding #7 (W2979/W2980) — single-active-session-per-profile guard. A
// session-create carrying a `profile_id` that already has a NON-TERMINAL session
// for the account is REFUSED with this 409: two concurrent sessions on the SAME
// profile would both restore the same sealed cookie/state blob, diverge, and BOTH
// save back at teardown → a last-writer-wins clobber that loses the customer's
// logins. The guard is enforced atomically under a per-profile advisory lock so
// two concurrent creates can't both pass. The `active_session_id` extension carries
// the id of the live session (ses_<uuid> / agt_<uuid>) so the GUI/SDK can prompt
// the customer to end the other session before launching another. Reconnecting to
// the SAME existing session is not a new bind and never reaches this; a profile
// whose only sessions are terminal binds freely; a create with no profile_id is
// never gated.
export class ProfileInUseError extends ApiError {
  constructor(activeSessionId: string, detail?: string) {
    super({
      type: PROBLEM_TYPES.ProfileInUse,
      title: 'Profile already in use',
      status: 409,
      detail:
        detail ??
        `This profile already has a live session (${activeSessionId}). ` +
          `End it before launching another — two sessions on the same profile would ` +
          `overwrite each other's saved cookies and logins.`,
      extensions: { active_session_id: activeSessionId, resource: 'profile' },
    });
    this.name = 'ProfileInUseError';
  }
}

/**
 * Founder directive #63 — the CP-side live proxy connectivity probe rejected the
 * proxy at launch time, so the launch is BLOCKED (zero session row, zero worker
 * spin-up) instead of dispatching a session that would dead-end at the box.
 *
 * 422 Unprocessable Entity — the request is syntactically valid + the proxy is
 * owned, but the named entity (the proxy) cannot be used right now: it failed a
 * real egress round-trip. `reason` is a stable machine enum so the dashboard +
 * SDK can branch ("auth failed → re-enter credentials", "unreachable → check the
 * host", "timeout → the proxy is slow/down", "egress_blocked → the proxy connects
 * but can't reach the internet"). `detail` is the human one-liner. Forward-
 * compatible with A3's W2931 post-dispatch box-reported egress failure (same
 * problem-type + reason enum, surfaced after launch instead of before it).
 */
export class ProxyValidationFailedError extends ApiError {
  constructor(args: {
    reason: 'unreachable' | 'auth_failed' | 'timeout' | 'egress_blocked';
    detail?: string;
  }) {
    const human: Record<typeof args.reason, string> = {
      unreachable:
        'The proxy could not be reached — check the host and port, and that the proxy is online.',
      auth_failed:
        'The proxy rejected the supplied credentials — re-enter the username and password.',
      timeout: 'The proxy did not respond in time — it may be slow or offline. Try again shortly.',
      egress_blocked:
        'The proxy connected but could not reach the internet — its upstream egress is blocked.',
    };
    super({
      type: PROBLEM_TYPES.ProxyValidationFailed,
      title: 'Proxy validation failed',
      status: 422,
      detail: args.detail ?? human[args.reason],
      extensions: { reason: args.reason, resource: 'proxy' },
    });
    this.name = 'ProxyValidationFailedError';
  }
}

// Render a byte count as GiB for the human-facing storage-quota message. Whole
// GiB show with no decimal ("5 GiB"); a fractional amount shows up to 2 decimals
// trimmed of trailing zeros ("2.5 GiB", "1.25 GiB"). Used ONLY for `detail` —
// the structured byte extensions stay raw.
function formatGiB(bytes: number): string {
  const gib = bytes / 2 ** 30;
  const rounded = Math.round(gib * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, '')} GiB`;
}

export class SessionDestroyedError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.SessionDestroyed,
      title: 'Session destroyed',
      status: 410,
      detail: 'This session has been destroyed and cannot be used.',
    });
    this.name = 'SessionDestroyedError';
  }
}

// SessionTimeoutError — distinguished from DriverError so customers
// can react specifically to "the operation didn't finish within the
// per-call timeout I supplied" without conflating it with downstream
// driver failures.
export class SessionTimeoutError extends ApiError {
  constructor(timeoutMs: number, detail?: string) {
    super({
      type: PROBLEM_TYPES.SessionTimeout,
      title: 'Session timeout',
      status: 504,
      detail: detail ?? `The operation exceeded the supplied timeout of ${timeoutMs} ms.`,
      extensions: { timeout_ms: timeoutMs },
    });
    this.name = 'SessionTimeoutError';
  }
}

export class DriverError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.DriverError,
      title: 'Driver error',
      status: 502,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'DriverError';
  }
}

export class DriverNotIntegratedError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.DriverNotIntegrated,
      title: 'Driver not integrated',
      status: 503,
      detail: 'The selected browser driver does not implement this operation in this deployment.',
    });
    this.name = 'DriverNotIntegratedError';
  }
}

// V-352b — 503 when an optional feature is disabled at deploy-time
// (e.g. avatar upload when the public R2 bucket isn't configured).
export class FeatureUnavailableError extends ApiError {
  constructor(detail: string) {
    super({
      type: PROBLEM_TYPES.FeatureUnavailable,
      title: 'Feature unavailable',
      status: 503,
      detail,
    });
    this.name = 'FeatureUnavailableError';
  }
}

// Q.1.d (2026-05-17) — agent-sessions message turn cannot resolve
// an Anthropic API key. Returned when the request supplies no
// `x-byok-anthropic-api-key` header AND the account has no stored
// BYOK key AND the deployment is configured to refuse fallback
// (Q.1.d default for prod per Tier-3 verdict 2026-05-16).
// 502 because the agent layer IS operational; it just cannot serve
// THIS customer's turn without a key. The customer fixes this by
// PUTting their key via /v1/account/me/byok-anthropic-key or by
// sending the header per request.
export class ByokAnthropicRequiredError extends ApiError {
  constructor(detail: string) {
    super({
      type: PROBLEM_TYPES.ByokAnthropicRequired,
      title: 'BYOK Anthropic key required',
      status: 502,
      detail,
    });
    this.name = 'ByokAnthropicRequiredError';
  }
}

// Arc 2 sub-slice 8.10 (v2-#8) — pair-mode takeover lost the
// SET-NX-EX race. Body carries `winner_client_id`.
export class PairModeConflictError extends ApiError {
  constructor(winnerClientId: string) {
    super({
      type: PROBLEM_TYPES.PairModeConflict,
      title: 'Pair-mode takeover already in flight',
      status: 409,
      detail: `Another client (${winnerClientId}) is currently taking over this agent session.`,
      extensions: { winner_client_id: winnerClientId },
    });
    this.name = 'PairModeConflictError';
  }
}

// Arc 2 sub-slice 8.10 (v2-#8) — invalid pair-mode transition.
// Extensions carry from + transition for dashboard diagnostics.
export class PairModeStateInvalidTransitionRouteError extends ApiError {
  constructor(args: { from: string; transition: string }) {
    super({
      type: PROBLEM_TYPES.PairModeStateInvalidTransition,
      title: 'Invalid pair-mode transition',
      status: 409,
      detail: `Transition '${args.transition}' is not allowed from state '${args.from}'.`,
      extensions: { from: args.from, transition: args.transition },
    });
    this.name = 'PairModeStateInvalidTransitionRouteError';
  }
}

// Arc 1 sub-slice 6.8 (v2-#6). Fires when the deployment IS wired for
// bundled-LLM (service + fallback key both present) AND no BYOK key
// resolved AND the customer's consent flag is false. Distinct from
// the generic ByokAnthropicRequired (502) so the dashboard can show
// a one-click "enable bundled-LLM" CTA. Status 402 Payment Required.
export class BundledLlmConsentRequiredError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.BundledLlmConsentRequired,
      title: 'Bundled-LLM consent required',
      status: 402,
      detail:
        'This deployment offers bundled-LLM but your account has not opted in. ' +
        'PATCH /v1/account/me/bundled-llm-settings with { "consent": true } to enable, ' +
        'or PUT /v1/account/me/byok-anthropic-key to bring your own Anthropic key (BYOK always wins).',
    });
    this.name = 'BundledLlmConsentRequiredError';
  }
}

// Arc 1 sub-slice 6.5 (v2-#6 bundled-LLM, founder verdict Q3=C
// $20 default cap). Fires when the customer's bundled-LLM monthly
// spend has reached `accounts.bundled_llm_monthly_cap_usd_cents`.
// Status 402 Payment Required so SDK consumers can branch on the
// status code AND the typed problem-type URI. Extensions carry the
// spend / cap numbers so the dashboard can render a precise message.
export class BundledLlmBudgetExhaustedError extends ApiError {
  constructor(args: { spentCents: number; capCents: number }) {
    super({
      type: PROBLEM_TYPES.BundledLlmBudgetExhausted,
      title: 'Bundled-LLM monthly cap reached',
      status: 402,
      detail:
        `You've used $${(args.spentCents / 100).toFixed(2)} of your ` +
        `$${(args.capCents / 100).toFixed(2)} monthly bundled-LLM budget. ` +
        `Raise the cap via PATCH /v1/account/me/bundled-llm-settings, ` +
        `supply your own Anthropic API key via PUT /v1/account/me/byok-anthropic-key, ` +
        `or wait for the next calendar month.`,
      extensions: {
        spent_cents: args.spentCents,
        cap_cents: args.capCents,
      },
    });
    this.name = 'BundledLlmBudgetExhaustedError';
  }
}

// V-353e — step-up MFA challenge required to run the requested op.
// Status is 403 (the caller is authenticated; they just need to prove
// MFA again within the 15-min freshness window). The
// `requires_mfa_step_up: true` extension lets clients branch on this
// without parsing the problem-type URI.
export class MfaStepUpRequiredError extends ApiError {
  constructor(reason: 'never_satisfied' | 'expired') {
    super({
      type: PROBLEM_TYPES.MfaStepUpRequired,
      title: 'MFA step-up required',
      status: 403,
      detail:
        reason === 'never_satisfied'
          ? 'This action requires a fresh MFA challenge. Sign in again with your authenticator code.'
          : 'Your MFA proof has expired. Re-enter your authenticator code to continue.',
      extensions: { requires_mfa_step_up: true, reason },
    });
    this.name = 'MfaStepUpRequiredError';
  }
}

// LegalAcceptanceRequiredError — 409 when an operation is gated on
// the customer accepting one or more legal documents (ToS, Privacy,
// DPA, AUP). The extension carries `pending_acceptances` so the
// client can surface the exact list to the customer without a
// follow-up GET /v1/legal/required round-trip.
export class LegalAcceptanceRequiredError extends ApiError {
  constructor(
    pendingAcceptances: Array<{ document_key: string; current_version: string }>,
    detail?: string,
  ) {
    super({
      type: PROBLEM_TYPES.LegalAcceptanceRequired,
      title: 'Legal acceptance required',
      status: 409,
      detail:
        detail ??
        `Operation requires acceptance of ${pendingAcceptances.length} document(s) before proceeding.`,
      extensions: { pending_acceptances: pendingAcceptances },
    });
    this.name = 'LegalAcceptanceRequiredError';
  }
}

// Auth-flow errors (V-079).

export class EmailAlreadyRegisteredError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.EmailAlreadyRegistered,
      title: 'Email already registered',
      status: 409,
      detail: 'An account with this email already exists.',
    });
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class InvalidCredentialsError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.InvalidCredentials,
      title: 'Invalid credentials',
      status: 401,
      detail: 'Email or password is incorrect.',
    });
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidAuthTokenError extends ApiError {
  constructor(detail = 'Token is invalid, expired, or already used.') {
    super({
      type: PROBLEM_TYPES.InvalidAuthToken,
      title: 'Invalid auth token',
      status: 400,
      detail,
    });
    this.name = 'InvalidAuthTokenError';
  }
}

export class EmailNotVerifiedError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.EmailNotVerified,
      title: 'Email not verified',
      status: 403,
      detail: 'Verify your email address before logging in.',
    });
    this.name = 'EmailNotVerifiedError';
  }
}

export class InternalError extends ApiError {
  constructor(detail = 'An unexpected error occurred.', cause?: unknown) {
    super({
      type: PROBLEM_TYPES.Internal,
      title: 'Internal Server Error',
      status: 500,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = 'InternalError';
  }
}
