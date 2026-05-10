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
  // annual Stripe price ids (price_...). `trialPackPriceId` is the
  // one-time price for ADR-003 trial-pack purchases.
  stripe: z
    .object({
      webhookSecret: z.string().min(1).optional(),
      publishableKey: z.string().min(1).optional(),
      secretKey: z.string().min(1).optional(),
      apiVersion: z.string().min(1).optional(),
      tierPrices: z
        .record(z.string(), z.object({ monthly: z.string(), annual: z.string() }))
        .optional(),
      trialPackPriceId: z.string().min(1).optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
      portalReturnUrl: z.string().url().optional(),
    })
    .optional(),
  // V-079: where the user-facing auth-flow links point. The plaintext
  // single-use token gets appended as `?token=<...>` to each. Defaults
  // are dev-friendly localhost URLs; production sets these to the real
  // dashboard origin.
  authFlowUrls: z.object({
    verifyEmail: z.string().url().default('http://localhost:5173/auth/verify-email'),
    magicLink: z.string().url().default('http://localhost:5173/auth/magic-link'),
    passwordReset: z.string().url().default('http://localhost:5173/auth/password-reset'),
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
  dashboardOrigin: z.string().url().default('http://localhost:5173'),
  /**
   * V-353b — base64-encoded 32-byte AES-256-GCM key used to encrypt
   * TOTP secrets at rest. When unset, /v1/account/mfa/* routes are
   * not registered (MFA disabled). Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   * Rotation is a future runbook item — changing the key invalidates
   * every existing enrollment (customers must re-enroll).
   */
  mfaEncryptionKey: z.string().optional(),
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
});

export type Config = z.infer<typeof ConfigSchema>;
export type R2Config = NonNullable<Config['r2']>;
export type PostmarkConfig = NonNullable<Config['postmark']>;
export type SentryConfig = NonNullable<Config['sentry']>;

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
  const release = env.SENTRY_RELEASE;
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
            ...(env.STRIPE_TRIAL_PACK_PRICE_ID
              ? { trialPackPriceId: env.STRIPE_TRIAL_PACK_PRICE_ID }
              : {}),
            ...(env.STRIPE_SUCCESS_URL ? { successUrl: env.STRIPE_SUCCESS_URL } : {}),
            ...(env.STRIPE_CANCEL_URL ? { cancelUrl: env.STRIPE_CANCEL_URL } : {}),
            ...(env.STRIPE_PORTAL_RETURN_URL
              ? { portalReturnUrl: env.STRIPE_PORTAL_RETURN_URL }
              : {}),
          }
        : undefined,
    authFlowUrls: {
      verifyEmail: env.AUTH_VERIFY_EMAIL_URL,
      magicLink: env.AUTH_MAGIC_LINK_URL,
      passwordReset: env.AUTH_PASSWORD_RESET_URL,
      exposeDebugToken: env.AUTH_EXPOSE_DEBUG_TOKEN,
    },
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY,
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
  });
}
