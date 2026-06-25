// RFC 7807 problem details. Every error response from the API is one of these.
// `type` is a stable URI; clients switch on it. `detail` is human-readable.

import { z } from 'zod';

export const ProblemSchema = z
  .object({
    type: z
      .string()
      .url()
      .describe('Stable URI identifying the problem class. Clients switch on this.'),
    title: z.string(),
    status: z.number().int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
  })
  .catchall(z.unknown())
  .describe('RFC 7807 problem details');

export type Problem = z.infer<typeof ProblemSchema>;

// Stable problem types — keep these URIs forever. Adding new ones is fine;
// renaming or removing breaks consumers.
export const PROBLEM_TYPES = {
  BadRequest: 'https://errors.driftstack.dev/bad-request',
  Unauthorized: 'https://errors.driftstack.dev/unauthorized',
  Forbidden: 'https://errors.driftstack.dev/forbidden',
  NotFound: 'https://errors.driftstack.dev/not-found',
  Conflict: 'https://errors.driftstack.dev/conflict',
  RateLimited: 'https://errors.driftstack.dev/rate-limited',
  ConcurrencyLimit: 'https://errors.driftstack.dev/concurrency-limit',
  TierLimit: 'https://errors.driftstack.dev/tier-limit',
  RevokedKey: 'https://errors.driftstack.dev/revoked-key',
  ExpiredKey: 'https://errors.driftstack.dev/expired-key',
  InvalidKey: 'https://errors.driftstack.dev/invalid-key',
  SessionDestroyed: 'https://errors.driftstack.dev/session-destroyed',
  SessionTimeout: 'https://errors.driftstack.dev/session-timeout',
  LegalAcceptanceRequired: 'https://errors.driftstack.dev/legal-acceptance-required',
  DriverError: 'https://errors.driftstack.dev/driver-error',
  DriverNotIntegrated: 'https://errors.driftstack.dev/driver-not-integrated',
  ValidationFailed: 'https://errors.driftstack.dev/validation-failed',
  Internal: 'https://errors.driftstack.dev/internal',
  // Auth-flow problem types (V-079).
  EmailAlreadyRegistered: 'https://errors.driftstack.dev/email-already-registered',
  InvalidCredentials: 'https://errors.driftstack.dev/invalid-credentials',
  InvalidAuthToken: 'https://errors.driftstack.dev/invalid-auth-token',
  EmailNotVerified: 'https://errors.driftstack.dev/email-not-verified',
  // V-352b — feature explicitly disabled at deploy-time (e.g. avatar
  // upload requires the public R2 bucket; in environments where it
  // isn't configured the endpoint returns 503 instead of a misleading
  // 404 / 500).
  FeatureUnavailable: 'https://errors.driftstack.dev/feature-unavailable',
  // V-353e — step-up MFA challenge required before this op runs.
  // Returned as 403 with `requires_mfa_step_up: true` extension. Client
  // collects a fresh 6-digit code, posts to /v1/auth/mfa/step-up, then
  // retries the original request.
  MfaStepUpRequired: 'https://errors.driftstack.dev/mfa-step-up-required',
  // Q.1.d (2026-05-17) — agent-sessions message turn cannot resolve
  // an Anthropic API key. BYOK-for-v1.0 Tier-3 verdict means the
  // customer MUST supply their own key (via stored
  // /v1/account/me/byok-anthropic-key OR per-request
  // `x-byok-anthropic-api-key` header). 502 status — the agent
  // layer is operational but cannot serve this customer's turn
  // without a key.
  ByokAnthropicRequired: 'https://errors.driftstack.dev/byok-anthropic-required',
  // Arc 1 sub-slice 6.5 (v2-#6 bundled-LLM, founder verdict Q3=C
  // $20 default cap). Customer's bundled-LLM monthly spend has hit
  // the soft-cap (`accounts.bundled_llm_monthly_cap_usd_cents`).
  // 402 Payment Required — the customer can either raise the cap
  // via PATCH /v1/account/me/bundled-llm-settings or supply a BYOK
  // key (BYOK always wins per Q4=A). Resets at calendar month start.
  BundledLlmBudgetExhausted: 'https://errors.driftstack.dev/bundled-llm-budget-exhausted',
  // Arc 1 sub-slice 6.8 (v2-#6) — distinct from BYOK-required because
  // the deployment IS wired for bundled-LLM, the customer just hasn't
  // ticked the consent flag yet. 402 Payment Required so SDKs can
  // branch on status + URI; the dashboard surfaces a one-click
  // "enable bundled-LLM" call-to-action that hits
  // PATCH /v1/account/me/bundled-llm-settings.
  BundledLlmConsentRequired: 'https://errors.driftstack.dev/bundled-llm-consent-required',
  // Arc 2 sub-slice 8.10 (v2-#8) — pair-mode takeover lost the
  // SET-NX-EX race. Body carries `winner_client_id` so the loser
  // dashboard can render "user X is taking over". 409 Conflict.
  PairModeConflict: 'https://errors.driftstack.dev/pair-mode-conflict',
  // Arc 2 sub-slice 8.10 (v2-#8) — the requested pair-mode
  // transition isn't valid from the current state (e.g. a handback
  // request before any takeover-grant). 409 Conflict + `from` +
  // `transition` extensions for dashboard diagnostics.
  PairModeStateInvalidTransition: 'https://errors.driftstack.dev/pair-mode-invalid-transition',
  // doc-150 item 6 — per-account profile-storage quota reached. Fires at
  // session-launch when a profile-backed session-create would grow the
  // account's stored state past its tier's hard cap (the SUM of every
  // live profile's size_bytes ≥ TIER_STORAGE_BYTES_CAP[tier]). 409
  // Conflict + `used_bytes` / `cap_bytes` extensions so the dashboard +
  // SDK consumers can render the exact overage. Enterprise is soft-only
  // and never raises this. Sessions WITHOUT a profile are never blocked.
  StorageQuotaExceeded: 'https://errors.driftstack.dev/storage-quota-exceeded',
  // Founder directive #63 — a proxy must be TESTED LIVE + validated BEFORE a
  // profile launch, not just declared. Fires at session-launch when the CP-side
  // live connectivity probe (connect THROUGH the resolved proxy + a real egress
  // round-trip) fails: the launch is BLOCKED with this 422 (zero session row,
  // zero worker spin-up) instead of dispatching a session that would dead-end at
  // the box. The `reason` extension is a machine-readable enum
  // (`unreachable` | `auth_failed` | `timeout` | `egress_blocked`) so the
  // dashboard + SDK can render a specific "fix your proxy" message; `detail`
  // carries a human one-liner. Forward-compatible with A3's W2931 post-dispatch
  // box-reported egress failure (same problem-type, surfaced post-launch).
  ProxyValidationFailed: 'https://errors.driftstack.dev/proxy-validation-failed',
} as const;

export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];
