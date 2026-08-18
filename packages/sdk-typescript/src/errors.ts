// SDK error classes — one per Driftstack RFC 7807 problem-type URI.
//
// All errors extend `DriftstackError` (the base) so consumers can catch the
// whole class with a single `instanceof DriftstackError`. The fine-grained
// classes carry typed extension data (e.g. `RateLimitError.retryAfterSeconds`,
// `ConcurrencyLimitError.currentSessions`).
//
// Mapping table (server → SDK class):
//   https://errors.driftstack.dev/bad-request          → BadRequestError
//   https://errors.driftstack.dev/validation-failed    → ValidationError
//   https://errors.driftstack.dev/unauthorized         → AuthError
//   https://errors.driftstack.dev/invalid-key          → InvalidKeyError
//   https://errors.driftstack.dev/revoked-key          → RevokedKeyError
//   https://errors.driftstack.dev/expired-key          → ExpiredKeyError
//   https://errors.driftstack.dev/forbidden            → ForbiddenError
//   https://errors.driftstack.dev/not-found            → NotFoundError
//   https://errors.driftstack.dev/conflict             → ConflictError
//   https://errors.driftstack.dev/rate-limited         → RateLimitError
//   https://errors.driftstack.dev/concurrency-limit    → ConcurrencyLimitError
//   https://errors.driftstack.dev/tier-limit           → TierLimitError
//   https://errors.driftstack.dev/storage-quota-exceeded → StorageQuotaExceededError
//   https://errors.driftstack.dev/session-destroyed    → SessionDestroyedError
//   https://errors.driftstack.dev/driver-error         → DriverError
//   https://errors.driftstack.dev/driver-not-integrated → DriverNotIntegratedError
//   https://errors.driftstack.dev/internal             → InternalError
//   https://errors.driftstack.dev/email-already-registered → EmailAlreadyRegisteredError
//   https://errors.driftstack.dev/invalid-credentials  → InvalidCredentialsError
//   https://errors.driftstack.dev/invalid-auth-token   → InvalidAuthTokenError
//   https://errors.driftstack.dev/email-not-verified   → EmailNotVerifiedError
//   https://errors.driftstack.dev/feature-unavailable  → FeatureUnavailableError
//   https://errors.driftstack.dev/mfa-step-up-required → MfaStepUpRequiredError
//   https://errors.driftstack.dev/proxy-validation-failed → ProxyValidationFailedError
//   https://errors.driftstack.dev/profile-in-use        → ProfileInUseError
//
// Anything else (network failure, parse error, etc.) surfaces as a
// `DriftstackError` with `kind: 'transport'` set on the instance.

import type { Problem } from '@driftstack/api-types';

export type DriftstackErrorKind =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'invalid_key'
  | 'revoked_key'
  | 'expired_key'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payment_required'
  | 'rate_limited'
  | 'concurrency_limit'
  | 'tier_limit'
  | 'session_destroyed'
  | 'session_timeout'
  | 'legal_acceptance_required'
  | 'driver_error'
  | 'driver_not_integrated'
  | 'internal'
  | 'email_already_registered'
  | 'invalid_credentials'
  | 'invalid_auth_token'
  | 'email_not_verified'
  // V-441 — closing problem-type parity with Go + Python.
  // Q.1.d (2026-05-17) appended `byok_anthropic_required`.
  | 'feature_unavailable'
  | 'mfa_step_up_required'
  | 'byok_anthropic_required'
  | 'proxy_validation_failed'
  | 'transport';

export class DriftstackError extends Error {
  readonly kind: DriftstackErrorKind;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(opts: {
    kind: DriftstackErrorKind;
    status: number;
    type: string;
    title: string;
    detail?: string;
    instance?: string;
    extensions?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.detail ?? opts.title, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'DriftstackError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.type = opts.type;
    this.title = opts.title;
    this.detail = opts.detail;
    this.instance = opts.instance;
    this.extensions = opts.extensions ?? {};
  }
}

export class BadRequestError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('bad_request', p));
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends DriftstackError {
  /** Server-supplied issues array; shape varies (often a Zod flatten()). */
  readonly issues: unknown;
  constructor(p: Problem) {
    super(toOpts('validation', p));
    this.name = 'ValidationError';
    this.issues = (p as { issues?: unknown }).issues;
  }
}

export class AuthError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('unauthorized', p));
    this.name = 'AuthError';
  }
}

export class InvalidKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('invalid_key', p));
    this.name = 'InvalidKeyError';
  }
}

export class RevokedKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('revoked_key', p));
    this.name = 'RevokedKeyError';
  }
}

export class ExpiredKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('expired_key', p));
    this.name = 'ExpiredKeyError';
  }
}

export class ForbiddenError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('forbidden', p));
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('not_found', p));
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends DriftstackError {
  /** Suggested wait before retrying. Sourced from `retry_after_seconds` extension or `Retry-After` header. */
  readonly retryAfterSeconds: number;
  constructor(p: Problem, retryAfterSeconds: number) {
    super(toOpts('rate_limited', p));
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ConcurrencyLimitError extends DriftstackError {
  readonly currentSessions: number | undefined;
  readonly limit: number | undefined;
  constructor(p: Problem) {
    super(toOpts('concurrency_limit', p));
    this.name = 'ConcurrencyLimitError';
    const ext = p as { current_sessions?: number; limit?: number };
    this.currentSessions = ext.current_sessions;
    this.limit = ext.limit;
  }
}

export class TierLimitError extends DriftstackError {
  /**
   * Per-period usage quota exhausted. Extensions on the wire surface
   * the bucket state so the SDK consumer can render a precise "you've
   * used X of Y" message without a follow-up GET.
   *
   * `recordType` carries the RESOURCE whose cap was reached — "profile"
   * for every producer today. The server calls this field `resource`; the
   * accessor keeps its published name (see V-815 below).
   *
   * Cross-SDK parity: Python exposes `err.current` + `err.limit` +
   * `err.record_type` on QuotaExceededError; Go exposes `err.Current`
   * + `err.Limit` + `err.RecordType` on QuotaExceededError. TS keeps
   * the historical `TierLimitError` name (already shipped in 0.1.x)
   * + now exposes camelCase `err.current`, `err.limit`,
   * `err.recordType`.
   */
  readonly current: number | undefined;
  readonly limit: number | undefined;
  readonly recordType: string | undefined;
  constructor(p: Problem) {
    super(toOpts('tier_limit', p));
    this.name = 'TierLimitError';
    // V-815 — the server sends `resource` on the tier-limit problem
    // (`{ current, limit, resource, tier }`). `record_type` has NEVER been on
    // the wire: it exists as a `usage_records` column name and in a
    // hand-written Go SDK test fixture, and reading it here left
    // `err.recordType` undefined on every tier-limit error the API can
    // produce. The old key stays as a fallback so a future producer that does
    // send it still works; the PROPERTY keeps its name because it ships in
    // 0.1.x and renaming it would break consumers for a spelling.
    const ext = p as {
      current?: number;
      limit?: number;
      resource?: string;
      record_type?: string;
    };
    this.current = ext.current;
    this.limit = ext.limit;
    this.recordType = ext.resource ?? ext.record_type;
  }
}

/**
 * doc-150 item 6 — per-account profile-storage quota reached at session-
 * launch. 409 Conflict (reuses the `conflict` kind, like the pair-mode 409s).
 * Extensions carry the byte numbers so consumers can render the overage:
 * `err.usedBytes`, `err.capBytes`, `err.tier`. Only profile-backed launches
 * raise this; enterprise is soft-only and never does.
 */
export class StorageQuotaExceededError extends DriftstackError {
  readonly usedBytes: number | undefined;
  readonly capBytes: number | undefined;
  readonly tier: string | undefined;
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'StorageQuotaExceededError';
    const ext = p as { used_bytes?: number; cap_bytes?: number; tier?: string };
    this.usedBytes = ext.used_bytes;
    this.capBytes = ext.cap_bytes;
    this.tier = ext.tier;
  }
}

export class SessionDestroyedError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('session_destroyed', p));
    this.name = 'SessionDestroyedError';
  }
}

/**
 * 422 — the proxy attached to a launch failed the server's LIVE pre-launch
 * connectivity test (a real egress round-trip THROUGH the proxy). The launch was
 * BLOCKED before any session or worker started. `err.reason` is a stable enum so
 * you can branch on the cause: `'unreachable'` (check host/port/online),
 * `'auth_failed'` (re-enter credentials), `'timeout'` (proxy slow/down), or
 * `'egress_blocked'` (proxy connects but its upstream can't reach the internet).
 * Not retryable as-is — fix the proxy, then launch again.
 */
export class ProxyValidationFailedError extends DriftstackError {
  readonly reason: string | undefined;
  constructor(p: Problem) {
    super(toOpts('proxy_validation_failed', p));
    this.name = 'ProxyValidationFailedError';
    this.reason = (p as { reason?: string }).reason;
  }
}

/**
 * 409 — a session-create carried a `profile_id` that already has a live
 * (non-terminal) session for the account. Two sessions on the same profile would
 * both restore and then overwrite the same saved cookie/state blob, losing the
 * customer's logins, so the launch is REFUSED. `err.activeSessionId` is the id of
 * the live session (e.g. `ses_…` / `agt_…`) — end it (or wait for it to finish)
 * before launching another. A create without a profile_id never raises this; reuses
 * the `conflict` kind (like the other 409s) so `catch (ConflictError)` still works.
 */
export class ProfileInUseError extends DriftstackError {
  readonly activeSessionId: string | undefined;
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'ProfileInUseError';
    this.activeSessionId = (p as { active_session_id?: string }).active_session_id;
  }
}

// LegalAcceptanceRequiredError — 409 when an operation (e.g. creating
// an API key) is gated on the customer accepting one or more legal
// documents. The `pendingAcceptances` array carries the document
// keys + current versions so the client can drive the user through
// the acceptance flow without a follow-up GET.
export interface PendingAcceptance {
  document_key: string;
  current_version: string;
}
export class LegalAcceptanceRequiredError extends DriftstackError {
  readonly pendingAcceptances: PendingAcceptance[];
  constructor(p: Problem) {
    super(toOpts('legal_acceptance_required', p));
    this.name = 'LegalAcceptanceRequiredError';
    const ext = (p as { pending_acceptances?: unknown }).pending_acceptances;
    this.pendingAcceptances = Array.isArray(ext)
      ? (ext.filter(
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as { document_key?: unknown }).document_key === 'string' &&
            typeof (e as { current_version?: unknown }).current_version === 'string',
        ) as PendingAcceptance[])
      : [];
  }
}

// SessionTimeoutError — distinguished from DriverError so customers can
// react specifically to "the operation didn't finish within the per-call
// timeout I supplied" without conflating with downstream driver failures.
// The `timeout_ms` field on the problem extension surfaces the bound the
// server actually applied (may differ from the customer's request if the
// server clamped it).
export class SessionTimeoutError extends DriftstackError {
  readonly timeoutMs: number | undefined;
  constructor(p: Problem) {
    super(toOpts('session_timeout', p));
    this.name = 'SessionTimeoutError';
    const ext = (p as { timeout_ms?: unknown }).timeout_ms;
    this.timeoutMs = typeof ext === 'number' ? ext : undefined;
  }
}

export class DriverError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('driver_error', p));
    this.name = 'DriverError';
  }
}

export class DriverNotIntegratedError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('driver_not_integrated', p));
    this.name = 'DriverNotIntegratedError';
  }
}

export class InternalError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('internal', p));
    this.name = 'InternalError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Auth-flow errors (V-079; SDK normalization V-114)
// ───────────────────────────────────────────────────────────────────────────

export class EmailAlreadyRegisteredError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('email_already_registered', p));
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class InvalidCredentialsError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('invalid_credentials', p));
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidAuthTokenError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('invalid_auth_token', p));
    this.name = 'InvalidAuthTokenError';
  }
}

export class EmailNotVerifiedError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('email_not_verified', p));
    this.name = 'EmailNotVerifiedError';
  }
}

// V-441 — typed errors closing TS SDK problem-type parity with Go + Python.

/** V-353e — operation requires fresh MFA proof (15-minute step-up window).
 *  Customer should call `client.auth.mfaStepUp({ code })` and retry. */
export class MfaStepUpRequiredError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('mfa_step_up_required', p));
    this.name = 'MfaStepUpRequiredError';
  }
}

/** Endpoint requires infrastructure not configured in this deployment
 *  (e.g. avatar uploads when R2 isn't wired). HTTP 503. */
export class FeatureUnavailableError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('feature_unavailable', p));
    this.name = 'FeatureUnavailableError';
  }
}

/** Q.1.d (2026-05-17) — agent-sessions message turn cannot resolve
 *  an Anthropic API key. BYOK-for-v1.0 means the customer must
 *  supply their own key. HTTP 502. */
// Arc 1 sub-slice 6.8 (v2-#6) — 402 Payment Required when the
// customer's bundled-LLM monthly spend has reached their per-account
// cap. Recovery paths: PATCH /v1/account/me/bundled-llm-settings to
// raise the cap, supply a BYOK key (header or stored), or wait for
// the next calendar month.
export class BundledLlmBudgetExhaustedError extends DriftstackError {
  readonly spentCents: number;
  readonly capCents: number;
  constructor(p: Problem) {
    super(toOpts('payment_required', p));
    this.name = 'BundledLlmBudgetExhaustedError';
    this.spentCents = Number((p as { spent_cents?: number }).spent_cents ?? 0);
    this.capCents = Number((p as { cap_cents?: number }).cap_cents ?? 0);
  }
}

// Arc 1 sub-slice 6.8 (v2-#6) — 402 Payment Required when the
// deployment offers bundled-LLM but the customer hasn't ticked
// consent yet. Dashboard surfaces a one-click enable CTA.
export class BundledLlmConsentRequiredError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('payment_required', p));
    this.name = 'BundledLlmConsentRequiredError';
  }
}

// Arc 2 sub-slice 8.10 (v2-#8) — pair-mode takeover lost the lock
// race. The body's `winner_client_id` is surfaced as a typed property
// so the dashboard can render "user X is taking over".
export class PairModeConflictError extends DriftstackError {
  readonly winnerClientId: string;
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'PairModeConflictError';
    this.winnerClientId = String((p as { winner_client_id?: string }).winner_client_id ?? '');
  }
}

// Arc 2 sub-slice 8.10 (v2-#8) — invalid pair-mode transition.
// `from` + `transition` carry the state-machine context.
export class PairModeStateInvalidTransitionError extends DriftstackError {
  readonly from: string;
  readonly transition: string;
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'PairModeStateInvalidTransitionError';
    this.from = String((p as { from?: string }).from ?? '');
    this.transition = String((p as { transition?: string }).transition ?? '');
  }
}

export class ByokAnthropicRequiredError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('byok_anthropic_required', p));
    this.name = 'ByokAnthropicRequiredError';
  }
}

/** Network / parse / non-Problem failure — server didn't return a structured error. */
export class TransportError extends DriftstackError {
  constructor(message: string, status = 0, cause?: unknown) {
    super({
      kind: 'transport',
      status,
      type: 'about:blank',
      title: 'Transport error',
      detail: message,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = 'TransportError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Mapping
// ───────────────────────────────────────────────────────────────────────────

const TYPE_TO_CTOR: Record<string, (p: Problem) => DriftstackError> = {
  'https://errors.driftstack.dev/bad-request': (p) => new BadRequestError(p),
  'https://errors.driftstack.dev/validation-failed': (p) => new ValidationError(p),
  'https://errors.driftstack.dev/unauthorized': (p) => new AuthError(p),
  'https://errors.driftstack.dev/invalid-key': (p) => new InvalidKeyError(p),
  'https://errors.driftstack.dev/revoked-key': (p) => new RevokedKeyError(p),
  'https://errors.driftstack.dev/expired-key': (p) => new ExpiredKeyError(p),
  'https://errors.driftstack.dev/forbidden': (p) => new ForbiddenError(p),
  'https://errors.driftstack.dev/not-found': (p) => new NotFoundError(p),
  'https://errors.driftstack.dev/conflict': (p) => new ConflictError(p),
  'https://errors.driftstack.dev/concurrency-limit': (p) => new ConcurrencyLimitError(p),
  'https://errors.driftstack.dev/tier-limit': (p) => new TierLimitError(p),
  // doc-150 item 6 — per-account profile-storage quota (409 at session-launch).
  'https://errors.driftstack.dev/storage-quota-exceeded': (p) => new StorageQuotaExceededError(p),
  // Live pre-launch proxy validation (422 at launch).
  'https://errors.driftstack.dev/proxy-validation-failed': (p) => new ProxyValidationFailedError(p),
  // A3 finding #7 — single-active-session-per-profile guard (409 at launch).
  'https://errors.driftstack.dev/profile-in-use': (p) => new ProfileInUseError(p),
  'https://errors.driftstack.dev/session-destroyed': (p) => new SessionDestroyedError(p),
  'https://errors.driftstack.dev/session-timeout': (p) => new SessionTimeoutError(p),
  'https://errors.driftstack.dev/legal-acceptance-required': (p) =>
    new LegalAcceptanceRequiredError(p),
  'https://errors.driftstack.dev/driver-error': (p) => new DriverError(p),
  'https://errors.driftstack.dev/driver-not-integrated': (p) => new DriverNotIntegratedError(p),
  'https://errors.driftstack.dev/internal': (p) => new InternalError(p),
  'https://errors.driftstack.dev/email-already-registered': (p) =>
    new EmailAlreadyRegisteredError(p),
  'https://errors.driftstack.dev/invalid-credentials': (p) => new InvalidCredentialsError(p),
  'https://errors.driftstack.dev/invalid-auth-token': (p) => new InvalidAuthTokenError(p),
  'https://errors.driftstack.dev/email-not-verified': (p) => new EmailNotVerifiedError(p),
  // V-441 — closing problem-type parity with Go + Python.
  'https://errors.driftstack.dev/feature-unavailable': (p) => new FeatureUnavailableError(p),
  'https://errors.driftstack.dev/mfa-step-up-required': (p) => new MfaStepUpRequiredError(p),
  'https://errors.driftstack.dev/byok-anthropic-required': (p) => new ByokAnthropicRequiredError(p),
  // Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM 402s.
  'https://errors.driftstack.dev/bundled-llm-budget-exhausted': (p) =>
    new BundledLlmBudgetExhaustedError(p),
  'https://errors.driftstack.dev/bundled-llm-consent-required': (p) =>
    new BundledLlmConsentRequiredError(p),
  // Arc 2 sub-slice 8.10 (v2-#8) — pair-mode 409s.
  'https://errors.driftstack.dev/pair-mode-conflict': (p) => new PairModeConflictError(p),
  'https://errors.driftstack.dev/pair-mode-invalid-transition': (p) =>
    new PairModeStateInvalidTransitionError(p),
};

/**
 * Build the typed error class from a server `Problem` plus a possibly-set
 * Retry-After header (used by RateLimitError when the body's
 * `retry_after_seconds` is missing).
 */
export function errorFromProblem(p: Problem, retryAfterHeader: string | null): DriftstackError {
  if (p.type === 'https://errors.driftstack.dev/rate-limited') {
    const fromBody = (p as { retry_after_seconds?: number }).retry_after_seconds;
    const fromHeader = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
    const retryAfter = fromBody ?? (Number.isFinite(fromHeader) ? fromHeader : 1);
    return new RateLimitError(p, retryAfter);
  }
  const ctor = TYPE_TO_CTOR[p.type];
  if (ctor) return ctor(p);
  // Unknown problem type — surface as DriftstackError with the raw fields.
  // Route through toOpts so the problem's EXTENSION members (code, request_id,
  // retry_after_seconds, …) are preserved on `.extensions` rather than dropped,
  // exactly as every mapped error type does. Retryability of an unknown 5xx
  // (kind 'internal' → retryable, matching the SDK's documented "retry generic
  // 5xx" policy) is intentionally unchanged.
  return new DriftstackError(toOpts(p.status >= 500 ? 'internal' : 'bad_request', p));
}

function toOpts(
  kind: DriftstackErrorKind,
  p: Problem,
): {
  kind: DriftstackErrorKind;
  status: number;
  type: string;
  title: string;
  detail?: string;
  instance?: string;
  extensions: Record<string, unknown>;
} {
  return {
    kind,
    status: p.status,
    type: p.type,
    title: p.title,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    ...(p.instance !== undefined ? { instance: p.instance } : {}),
    extensions: extensionMembers(p),
  };
}

function extensionMembers(p: Problem): Record<string, unknown> {
  const known = new Set(['type', 'title', 'status', 'detail', 'instance']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}

/**
 * V-489 — `isRetryable(err)` predicate exposed for SDK consumers
 * who run their own retry/backoff loop instead of the built-in one
 * in `retry.ts`. Returns `true` when a retry stands a reasonable
 * chance of succeeding; `false` when it doesn't.
 *
 * Retryable kinds:
 *   - `transport` (network failure, DNS, TLS handshake — should
 *     succeed once connectivity is restored)
 *   - `internal` (5xx from Driftstack — likely transient)
 *   - `rate_limited` (429 with a Retry-After hint — back off then
 *     retry)
 *
 * NOT retryable:
 *   - 4xx that aren't 429 (validation, authn, authz, not found,
 *     conflict, tier-limit, MFA-step-up — retrying without a state
 *     change won't help)
 *   - any DriftstackError where `kind: 'unknown'` is not the case
 *     and the kind is not in the retryable set above
 *
 * For non-DriftstackError thrown values, returns false — the SDK
 * always wraps known errors in a DriftstackError, so a non-DS error
 * is something the caller threw and the caller should decide how
 * to handle.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof DriftstackError)) return false;
  switch (err.kind) {
    case 'transport':
    case 'internal':
    case 'rate_limited':
      return true;
    default:
      return false;
  }
}
