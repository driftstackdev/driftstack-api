import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  driver: z.enum(['mock', 'webkit', 'playwright']).default('mock'),
  mockNavigateLatencyMs: z.coerce.number().int().nonnegative().default(120),
  mockInteractLatencyMs: z.coerce.number().int().nonnegative().default(40),
  // V-333b — Playwright driver channel. Consulted only when
  // driver === 'playwright'. Defaults to webkit (closest to iPhone
  // Safari for non-stealth E2E smoke testing on Mac).
  playwrightBrowser: z.enum(['webkit', 'chromium', 'firefox']).default('webkit'),
  // V-333b — true = visible window (Mac dev), false = headless (CI).
  playwrightHeaded: z.coerce.boolean().default(false),
  // V-113: Slow-query log threshold. When set, queries at or above this
  // duration emit a warn-level structured log via postgres-js client
  // instrumentation. Unset = disabled (default for dev/test).
  slowQueryLogThresholdMs: z.coerce.number().int().positive().optional(),
  // Cloudflare R2 — recordings durability + cross-device access. All
  // four required to enable R2; if any is missing, R2 is disabled and
  // the readiness probe skips the R2 check (logged at boot).
  r2: z
    .object({
      accountId: z.string().min(1),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      bucketRecordings: z.string().min(1),
      /**
       * V-295c2 — separate public-readable bucket for the status-page
       * snapshot. MUST be a different bucket from bucketRecordings —
       * recordings contain Customer Data and must remain private. The
       * public bucket holds operational JSON only (incident snapshots).
       * Optional: when null, status-snapshot writer is disabled.
       */
      bucketPublic: z.string().min(1).nullable(),
      endpointUrl: z.string().url(),
    })
    .nullable(),
  // Postmark — transactional email. All three required to enable.
  // Fire-and-forget; readiness does NOT gate on Postmark connectivity
  // (per founder direction V-054 follow-up: SDK init failures logged
  // clearly at boot, then service operates degraded — no email path
  // is in the request critical-path).
  postmark: z
    .object({
      apiToken: z.string().min(1),
      from: z.string().email(),
      replyTo: z.string().email(),
    })
    .nullable(),
  // Sentry — error tracking. EU region required: DSN must contain
  // `.de.` (per docs/deployment/env-vars.md validation checklist).
  // Fire-and-forget; readiness does NOT gate on Sentry connectivity.
  sentry: z
    .object({
      dsn: z
        .string()
        .url()
        .refine((u) => u.includes('.de.') || u.includes('.ingest.de.sentry.io'), {
          message: 'SENTRY_DSN must use the EU region (.de.) per data-residency policy',
        }),
      environment: z.string().min(1),
      release: z.string().min(1).optional(),
      tracesSampleRate: z.coerce.number().min(0).max(1).default(0),
    })
    .nullable(),
  // V-080 / V-082 / V-088: Stripe configuration.
  // `webhookSecret` (whsec_...) gates the inbound webhook route.
  // `secretKey` (sk_live_... or sk_test_...) gates the production
  // BillingProvider — when present, the StripeBillingProvider replaces
  // the in-memory stub. Sub-fields are individually optional so dev
  // can run without any Stripe config (routes simply don't register).
  // `tierPrices` maps each self-serve paid tier to its monthly +
  // annual Stripe price ids (price_...). The one-time trial_pack was
  // retired 2026-05-27 (perpetual free tier replaced it).
  stripe: z
    .object({
      webhookSecret: z.string().min(1).optional(),
      publishableKey: z.string().min(1).optional(),
      secretKey: z.string().min(1).optional(),
      apiVersion: z.string().min(1).optional(),
      tierPrices: z
        .record(z.string(), z.object({ monthly: z.string(), annual: z.string() }))
        .optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
      portalReturnUrl: z.string().url().optional(),
    })
    .optional(),
  // AI-D — AI chat agent layer (planning 132 §"Phase 7"; founder
  // 2026-05-16 BYOK Anthropic locked for v1.0 launch).
  //
  // `byokAnthropic.fallbackApiKey` is the optional Driftstack-side
  // fallback key used ONLY when a customer hasn't supplied their
  // own. Per the Tier-3 verdict, BYOK is the v1.0 path — most
  // customers bring their own; the fallback is for the founder's
  // own demos + integration tests. Bundled-LLM billing (where
  // Driftstack absorbs the cost + bills the customer) is deferred
  // to v1.1.
  //
  // Until the founder shares the actual key, this stays unset; the
  // AgentRuntime stays activation-gated (503 stub posture).
  byokAnthropic: z
    .object({
      fallbackApiKey: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
  // Q.1 verdicts 2026-05-17 — agent-decomposer bootstrap selection
  // controls. See docs/internal/ai-b1b-activation-design.md §"verdicts".
  agentDecomposer: z
    .object({
      /**
       * Operator escape hatch (Q.1.a open-answer verdict). When set to
       * 'deterministic', bootstrap wires DeterministicAgentDecomposer
       * regardless of BYOK key availability. Useful for staging-only
       * deterministic-path testing AND for prod incidents where the
       * operator needs to fall back to the heuristic decomposer without
       * unwiring the Anthropic key path. Empty / unset = no override
       * (auto-selection per Q.1.a verdict applies).
       */
      forceImpl: z.enum(['deterministic']).optional(),
      /**
       * Staging-only opt-in to using the deployment fallback key as
       * the default for unauthenticated demo flows (Q.1.d open-answer
       * verdict). PROD must keep this `false` so the BYOK-for-v1.0
       * Tier-3 verdict (2026-05-16) holds — fallback key is for
       * staging + integration tests ONLY.
       */
      useFallbackForUnconfiguredCustomers: z.boolean().default(false),
    })
    .optional(),
  // V-079: where the user-facing auth-flow links point. The plaintext
  // single-use token gets appended as `?token=<...>` to each. Defaults
  // are dev-friendly localhost URLs; production sets these to the real
  // dashboard origin.
  // V-079.B/C — dashboard route paths. The customer-dashboard
  // (apps/customer-dashboard) serves these at:
  //   /verify-email, /reset-password, /auth/magic-link
  // Cross-app parity is pinned by
  // apps/customer-dashboard/tests/unit/auth-url-paths-parity.test.ts.
  authFlowUrls: z.object({
    verifyEmail: z.string().url().default('http://localhost:5173/verify-email'),
    magicLink: z.string().url().default('http://localhost:5173/auth/magic-link'),
    passwordReset: z.string().url().default('http://localhost:5173/reset-password'),
    /**
     * When true, signup / magic-link / password-reset responses include
     * a `debug_token` field containing the plaintext token. ENABLE ONLY
     * in dev / test — production must never leak these tokens via the
     * response body. Default false.
     */
    exposeDebugToken: z.coerce.boolean().default(false),
  }),
  /**
   * V-266 — origin of the customer dashboard. Used to build the
   * browser_url returned by /v1/auth/cli-authorize/initiate so the
   * GUI's deep link points at the right host (dev / staging / prod).
   */
  // W190 — strip any trailing slash so consumers can safely do
  // `${dashboardOrigin}/billing` etc. without producing `https://…//billing`.
  // The zod schema is the single normalisation point; cli-authorize.ts
  // and the other call sites no longer need to re-strip.
  dashboardOrigin: z
    .string()
    .url()
    .default('http://localhost:5173')
    .transform((s) => s.replace(/\/+$/, '')),
  /**
   * V-353b — base64-encoded 32-byte AES-256-GCM key used to encrypt
   * TOTP secrets at rest. When unset, /v1/account/mfa/* routes are
   * not registered (MFA disabled). Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   * Rotation is a future runbook item — changing the key invalidates
   * every existing enrollment (customers must re-enroll).
   *
   * Validated eagerly here (length-checked at config-parse), not just
   * lazily in each crypto module's decodeKey: a wrong-length key would
   * otherwise boot fine + register the routes, then 500 the first
   * customer who enrolls MFA / saves a BYOK key / mints a LiveKit token
   * (one key backs all four AES-256-GCM surfaces). Failing the boot
   * config-parse surfaces the misconfig to the operator on deploy.
   * Mirrors the eager .min(16) on metricsScrapeToken + fleetInternalToken.
   */
  mfaEncryptionKey: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message:
        'MFA_ENCRYPTION_KEY must base64-decode to exactly 32 bytes (AES-256). ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    })
    .optional(),
  /**
   * Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus /metrics
   * scrape bearer token. Required for the /metrics endpoint to
   * activate; without it the route returns 503 + the registry is
   * dropped from AppDeps (counters silently no-op).
   *
   * Convention: generate with
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   * and rotate alongside other internal credentials.
   */
  metricsScrapeToken: z.string().min(16).optional(),
  /**
   * Wave 29-400 §8.5 — internal fleet bearer token. Gates the
   * /v1/internal/atlas-priority/* observability endpoints called by
   * Agent 1's harvester + bs-atlas-priority.sh + atlas-priority-
   * append.py callbacks. NOT customer-facing. When unset, those
   * routes return 503 (registerInternalAtlasPriorityDisabledRoutes
   * path); when set, the routes activate with constant-time bearer
   * comparison (lib/internal-fleet-auth.ts). Same env-var-only
   * provisioning convention as the other shared secrets — SSH-write
   * to /etc/driftstack/api.env, never commit, never echo.
   */
  fleetInternalToken: z.string().min(16).optional(),
  /**
   * V-487 — NowPayments crypto-rail scaffold. Conditional, opt-in
   * sub-processor (Estonia EEA-internal per the V-308a legal
   * scaffolding). When `apiKey` + `ipnSecret` are unset, the
   * `/v1/billing/crypto/*` route stubs return 501 Not Implemented;
   * the code is wired but inactive until the founder creates the
   * NowPayments account and SSH-writes the credentials. This lets
   * launch-day flip the rail on without redeploying.
   *
   * `apiKey` — issued in the NowPayments dashboard; gates outbound
   * calls to api.nowpayments.io.
   * `ipnSecret` — separate HMAC secret for inbound webhook (IPN)
   * signature verification. NowPayments signs payloads with this
   * shared secret; the verifier in `lib/nowpayments-signing.ts`
   * (V-487-followup) checks the `x-nowpayments-sig` header.
   */
  nowpayments: z
    .object({
      apiKey: z.string().min(1).optional(),
      ipnSecret: z.string().min(1).optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
    })
    .optional(),

  /**
   * V-531.B — LiveKit SFU credentials for the real-WebRTC swap.
   *
   * `apiKey` + `apiSecret` are issued in the LiveKit Cloud dashboard
   * (or self-hosted equivalent) and are used to mint short-lived
   * JWT access tokens via `livekit-server-sdk`. The token-mint
   * endpoint hands a token to a client (gui-client publisher or
   * customer-dashboard subscriber) which then opens a WebSocket
   * directly to `wsUrl` for media exchange.
   *
   * `wsUrl` must use the `wss://` scheme — LiveKit refuses plain ws
   * outside dev. All three fields are required together: the
   * route-gate at `app.ts` mirrors the nowpayments pattern (route
   * stays unregistered unless every field is present).
   */
  livekit: z
    .object({
      apiKey: z.string().min(1).optional(),
      apiSecret: z.string().min(1).optional(),
      wsUrl: z.string().url().optional(),
    })
    .optional(),

  /**
   * V-667.C — OAuth-CLIENT (sign-in-with-Google/GitHub) configuration.
   * Driftstack-AS-OAuth-client (NOT to be confused with V-667.B
   * OAuth-server). Per-provider client_id + client_secret are
   * env-derived; signingSecret (≥32 chars) HMACs both the state JWT
   * + the PKCE-verifier cookie.
   *
   * The /v1/auth/oauth-client/* routes register only when at least
   * one provider has both clientId + clientSecret + the signingSecret
   * is set. Otherwise the routes stay unregistered (same all-or-
   * nothing posture as V-487 NowPayments + V-665 Postmark +
   * V-531.B LiveKit).
   */
  oauthClient: z
    .object({
      signingSecret: z.string().min(32).optional(),
      /**
       * Base origin+prefix the per-provider callback URL is derived
       * from. The full URL passed to the IDP at authorize time is
       * `${callbackUrlBase}/${provider}/callback`. Must match the
       * redirect URL registered in each provider's developer console.
       *
       * Production: `https://api.driftstack.dev/v1/auth/oauth`.
       * Trailing slash is normalised away at parse time.
       */
      callbackUrlBase: z
        .string()
        .url()
        .optional()
        .transform((v) => (typeof v === 'string' ? v.replace(/\/+$/, '') : v)),
      google: z
        .object({
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
        })
        .optional(),
      github: z
        .object({
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type R2Config = NonNullable<Config['r2']>;
export type PostmarkConfig = NonNullable<Config['postmark']>;
export type SentryConfig = NonNullable<Config['sentry']>;
export type LivekitConfig = NonNullable<Config['livekit']>;
export type OAuthClientConfig = NonNullable<Config['oauthClient']>;

function readR2Config(env: NodeJS.ProcessEnv): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucketRecordings = env.R2_BUCKET_RECORDINGS;
  const bucketPublic = env.R2_BUCKET_PUBLIC ?? null;
  const endpointUrl = env.R2_ENDPOINT_URL;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketRecordings || !endpointUrl) {
    return null;
  }
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketRecordings,
    bucketPublic,
    endpointUrl,
  };
}

/**
 * V-079.B — derive the three auth-flow URLs from a single
 * `DASHBOARD_ORIGIN` env var when the per-URL overrides aren't set.
 *
 * Why: deploys that only set `DASHBOARD_ORIGIN=https://app.…` would
 * previously still emit verify-email / magic-link / password-reset
 * URLs pointing at `http://localhost:5173` (the zod default for the
 * per-URL fields). Real customers received emails with broken links.
 *
 * Resolution order for each URL:
 *   1. explicit per-URL env var (AUTH_VERIFY_EMAIL_URL etc.)
 *   2. DASHBOARD_ORIGIN + the conventional path
 *   3. dev-friendly localhost default (final fallback, dev-only)
 *
 * In production, any resolved URL still pointing at localhost is a
 * misconfiguration — the boot-time guard at the bottom rejects it
 * rather than letting customers receive broken links again.
 */
function deriveAuthFlowUrls(env: NodeJS.ProcessEnv): {
  verifyEmail?: string;
  magicLink?: string;
  passwordReset?: string;
  exposeDebugToken?: string;
} {
  const origin = env.DASHBOARD_ORIGIN?.replace(/\/+$/, '');
  const fromOrigin = (path: string): string | undefined =>
    origin !== undefined && origin.length > 0 ? `${origin}${path}` : undefined;
  const resolved = {
    // V-079.C — paths match the customer-dashboard's actual file-based
    // routes (`/verify-email`, `/reset-password`). The previous
    // `/auth/<flow>` paths landed on 404s because no such pages
    // existed; the bug surfaced in a real customer's verify-email
    // when Postmark approval landed (2026-05-12).
    verifyEmail: env.AUTH_VERIFY_EMAIL_URL ?? fromOrigin('/verify-email'),
    magicLink: env.AUTH_MAGIC_LINK_URL ?? fromOrigin('/auth/magic-link'),
    passwordReset: env.AUTH_PASSWORD_RESET_URL ?? fromOrigin('/reset-password'),
    exposeDebugToken: env.AUTH_EXPOSE_DEBUG_TOKEN,
  };
  if (env.NODE_ENV === 'production') {
    for (const [name, value] of Object.entries({
      DASHBOARD_ORIGIN: env.DASHBOARD_ORIGIN,
      AUTH_VERIFY_EMAIL_URL: resolved.verifyEmail,
      AUTH_MAGIC_LINK_URL: resolved.magicLink,
      AUTH_PASSWORD_RESET_URL: resolved.passwordReset,
    })) {
      if (value !== undefined && /\blocalhost\b/.test(value)) {
        throw new Error(
          `Refusing to boot: ${name} resolves to a localhost URL ("${value}") in production. ` +
            `Set DASHBOARD_ORIGIN (or the per-URL env var) to the customer-facing dashboard origin.`,
        );
      }
    }
    // Reject the "no DASHBOARD_ORIGIN at all" case too — the zod
    // default would otherwise land on the localhost fallback and the
    // CLI-authorize browser URL (cli-authorize.ts) would point there.
    if (env.DASHBOARD_ORIGIN === undefined || env.DASHBOARD_ORIGIN.length === 0) {
      throw new Error(
        'Refusing to boot: DASHBOARD_ORIGIN must be set in production (drives auth-flow URLs + CLI-authorize browser URL).',
      );
    }
  }
  return resolved;
}

function readPostmarkConfig(env: NodeJS.ProcessEnv): PostmarkConfig | null {
  const apiToken = env.POSTMARK_API_TOKEN;
  const from = env.POSTMARK_FROM;
  const replyTo = env.POSTMARK_REPLY_TO;
  if (!apiToken || !from || !replyTo) {
    return null;
  }
  return { apiToken, from, replyTo };
}

function parseTierPrices(raw: string): Record<string, { monthly: string; annual: string }> {
  // Expected JSON shape: {"api_starter":{"monthly":"price_xxx","annual":"price_yyy"}, ...}
  // Accepts either the new nested shape (monthly + annual per tier) or the
  // legacy flat shape from the env-vars.md placeholder (single price id per
  // tier — synthesised as monthly only). Throws on malformed input so a
  // misconfigured deploy fails fast at boot.
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('DRIFTSTACK_TIER_PRICE_IDS must be a JSON object');
  }
  const out: Record<string, { monthly: string; annual: string }> = {};
  for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[tier] = { monthly: value, annual: value };
    } else if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { monthly?: unknown }).monthly === 'string' &&
      typeof (value as { annual?: unknown }).annual === 'string'
    ) {
      const v = value as { monthly: string; annual: string };
      out[tier] = { monthly: v.monthly, annual: v.annual };
    } else {
      throw new Error(`DRIFTSTACK_TIER_PRICE_IDS.${tier} must be a string or {monthly, annual}`);
    }
  }
  return out;
}

function readSentryConfig(env: NodeJS.ProcessEnv): SentryConfig | null {
  const dsn = env.SENTRY_DSN;
  const environment = env.SENTRY_ENVIRONMENT;
  if (!dsn || !environment) {
    return null;
  }
  // Arc 7 obs.1 — Sentry release auto-tagging. Prefer the explicit
  // SENTRY_RELEASE env when set; otherwise fall back to GIT_SHA so
  // every deploy gets a release tag without manual env config. The
  // deploy bridge already writes GIT_SHA to /etc/driftstack/api.env
  // for the /version endpoint; this slice re-uses the same source
  // of truth so the Sentry release matches the git_sha surfaced on
  // GET /version. No fallback to 'unknown' here — better to emit
  // events with `release: undefined` than to ship a misleading
  // sentinel that pretends to identify a build.
  const release = env.SENTRY_RELEASE ?? env.GIT_SHA;
  const tracesSampleRate = env.SENTRY_TRACES_SAMPLE_RATE;
  return {
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate: tracesSampleRate !== undefined ? Number(tracesSampleRate) : 0,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    driver: env.DRIVER,
    mockNavigateLatencyMs: env.MOCK_NAVIGATE_LATENCY_MS,
    mockInteractLatencyMs: env.MOCK_INTERACT_LATENCY_MS,
    playwrightBrowser: env.PLAYWRIGHT_BROWSER,
    playwrightHeaded: env.PLAYWRIGHT_HEADED,
    slowQueryLogThresholdMs: env.SLOW_QUERY_LOG_THRESHOLD_MS,
    r2: readR2Config(env),
    postmark: readPostmarkConfig(env),
    sentry: readSentryConfig(env),
    stripe:
      env.STRIPE_WEBHOOK_SECRET ||
      env.STRIPE_PUBLISHABLE_KEY ||
      env.STRIPE_SECRET_KEY ||
      env.DRIFTSTACK_TIER_PRICE_IDS
        ? {
            ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
            ...(env.STRIPE_PUBLISHABLE_KEY ? { publishableKey: env.STRIPE_PUBLISHABLE_KEY } : {}),
            ...(env.STRIPE_SECRET_KEY ? { secretKey: env.STRIPE_SECRET_KEY } : {}),
            ...(env.STRIPE_API_VERSION ? { apiVersion: env.STRIPE_API_VERSION } : {}),
            ...(env.DRIFTSTACK_TIER_PRICE_IDS
              ? { tierPrices: parseTierPrices(env.DRIFTSTACK_TIER_PRICE_IDS) }
              : {}),
            ...(env.STRIPE_SUCCESS_URL ? { successUrl: env.STRIPE_SUCCESS_URL } : {}),
            ...(env.STRIPE_CANCEL_URL ? { cancelUrl: env.STRIPE_CANCEL_URL } : {}),
            ...(env.STRIPE_PORTAL_RETURN_URL
              ? { portalReturnUrl: env.STRIPE_PORTAL_RETURN_URL }
              : {}),
          }
        : undefined,
    // AI-D BYOK Anthropic — read from env only (per memory rule
    // "Credentials via env vars only"). Founder shared the fallback
    // key 2026-05-17 (orchestrator handoff post-AUTO #1). Canonical
    // env var name is BYOK_ANTHROPIC_FALLBACK_KEY (per the handoff);
    // DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY accepted as a deprecation-
    // window alias for existing dev shells.
    byokAnthropic:
      env.BYOK_ANTHROPIC_FALLBACK_KEY ||
      env.DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY ||
      env.DRIFTSTACK_ANTHROPIC_MODEL
        ? {
            ...((env.BYOK_ANTHROPIC_FALLBACK_KEY ?? env.DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY)
              ? {
                  fallbackApiKey: (env.BYOK_ANTHROPIC_FALLBACK_KEY ??
                    env.DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY) as string,
                }
              : {}),
            ...(env.DRIFTSTACK_ANTHROPIC_MODEL ? { model: env.DRIFTSTACK_ANTHROPIC_MODEL } : {}),
          }
        : undefined,
    // Q.1 verdicts 2026-05-17 — agent-decomposer bootstrap controls.
    agentDecomposer:
      env.DRIFTSTACK_AGENT_DECOMPOSER_FORCE || env.DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK
        ? {
            ...(env.DRIFTSTACK_AGENT_DECOMPOSER_FORCE === 'deterministic'
              ? { forceImpl: 'deterministic' as const }
              : {}),
            useFallbackForUnconfiguredCustomers:
              env.DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK === 'true',
          }
        : undefined,
    authFlowUrls: deriveAuthFlowUrls(env),
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY,
    metricsScrapeToken: env.METRICS_SCRAPE_TOKEN,
    fleetInternalToken: env.DRIFTSTACK_FLEET_INTERNAL_TOKEN,
    // V-487 — NowPayments scaffold. All fields optional; presence of
    // BOTH apiKey + ipnSecret is what the route registration checks.
    nowpayments:
      env.NOWPAYMENTS_API_KEY ||
      env.NOWPAYMENTS_IPN_SECRET ||
      env.NOWPAYMENTS_SUCCESS_URL ||
      env.NOWPAYMENTS_CANCEL_URL
        ? {
            ...(env.NOWPAYMENTS_API_KEY ? { apiKey: env.NOWPAYMENTS_API_KEY } : {}),
            ...(env.NOWPAYMENTS_IPN_SECRET ? { ipnSecret: env.NOWPAYMENTS_IPN_SECRET } : {}),
            ...(env.NOWPAYMENTS_SUCCESS_URL ? { successUrl: env.NOWPAYMENTS_SUCCESS_URL } : {}),
            ...(env.NOWPAYMENTS_CANCEL_URL ? { cancelUrl: env.NOWPAYMENTS_CANCEL_URL } : {}),
          }
        : undefined,
    // V-531.B — LiveKit SFU. All three fields must be present together;
    // route-gate at app.ts treats partial config as "not configured".
    livekit:
      env.LIVEKIT_API_KEY || env.LIVEKIT_API_SECRET || env.LIVEKIT_WS_URL
        ? {
            ...(env.LIVEKIT_API_KEY ? { apiKey: env.LIVEKIT_API_KEY } : {}),
            ...(env.LIVEKIT_API_SECRET ? { apiSecret: env.LIVEKIT_API_SECRET } : {}),
            ...(env.LIVEKIT_WS_URL ? { wsUrl: env.LIVEKIT_WS_URL } : {}),
          }
        : undefined,
    // V-667.C — OAuth-CLIENT (sign-in-with-Google/GitHub). All
    // fields optional; route-registration at app.ts checks at least
    // one fully-configured provider + signingSecret + callbackUrlBase.
    //
    // ENV migration (2026-05-16): callback URL switched from a single
    // SPA URL (`OAUTH_CLIENT_CALLBACK_URL`) to a per-provider URL
    // derived from a base (`OAUTH_CLIENT_CALLBACK_URL_BASE`). The new
    // value MUST match the provider-console redirect registration:
    //   https://api.driftstack.dev/v1/auth/oauth
    //
    // No silent fallback from the old env name to the new field: the
    // OLD env value (an SPA URL ending in `/auth/oauth-client/callback`)
    // is the wrong SHAPE for the new field — using it would compose
    // wrong per-provider URLs (`SPA/google/callback`) and reproduce
    // the redirect_uri_mismatch bug via a different code path. Safer
    // to flip oauthClient to false (route un-registers) until the
    // operator updates env than to silently produce broken URLs.
    oauthClient:
      env.OAUTH_CLIENT_SIGNING_SECRET ||
      env.OAUTH_CLIENT_CALLBACK_URL_BASE ||
      env.GOOGLE_OAUTH_CLIENT_ID ||
      env.GITHUB_OAUTH_CLIENT_ID
        ? {
            ...(env.OAUTH_CLIENT_SIGNING_SECRET
              ? { signingSecret: env.OAUTH_CLIENT_SIGNING_SECRET }
              : {}),
            ...(env.OAUTH_CLIENT_CALLBACK_URL_BASE
              ? { callbackUrlBase: env.OAUTH_CLIENT_CALLBACK_URL_BASE }
              : {}),
            ...(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
              ? {
                  google: {
                    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
                    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
                  },
                }
              : {}),
            ...(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
              ? {
                  github: {
                    clientId: env.GITHUB_OAUTH_CLIENT_ID,
                    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
                  },
                }
              : {}),
          }
        : undefined,
  });
}
