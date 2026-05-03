import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  driver: z.enum(['mock', 'webkit']).default('mock'),
  mockNavigateLatencyMs: z.coerce.number().int().nonnegative().default(120),
  mockInteractLatencyMs: z.coerce.number().int().nonnegative().default(40),
  // Cloudflare R2 — recordings durability + cross-device access. All
  // four required to enable R2; if any is missing, R2 is disabled and
  // the readiness probe skips the R2 check (logged at boot).
  r2: z
    .object({
      accountId: z.string().min(1),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      bucketRecordings: z.string().min(1),
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
  const endpointUrl = env.R2_ENDPOINT_URL;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketRecordings || !endpointUrl) {
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucketRecordings, endpointUrl };
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
    r2: readR2Config(env),
    postmark: readPostmarkConfig(env),
    sentry: readSentryConfig(env),
    authFlowUrls: {
      verifyEmail: env.AUTH_VERIFY_EMAIL_URL,
      magicLink: env.AUTH_MAGIC_LINK_URL,
      passwordReset: env.AUTH_PASSWORD_RESET_URL,
      exposeDebugToken: env.AUTH_EXPOSE_DEBUG_TOKEN,
    },
  });
}
