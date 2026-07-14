import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

describe('loadConfig', () => {
  it('uses defaults when env is sparse', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.port).toBe(3000);
    expect(cfg.driver).toBe('mock');
    expect(cfg.mockNavigateLatencyMs).toBe(120);
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      PORT: '8080',
      MOCK_NAVIGATE_LATENCY_MS: '50',
    });

    expect(cfg.port).toBe(8080);
    expect(cfg.mockNavigateLatencyMs).toBe(50);
  });

  it('agentUploadMaxAccountInFlightBytes — prod default is EXACTLY 512 MiB; AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES tunes it', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    // Founder safeguard (2026-06-24): the prod default MUST stay 512 MB. This is
    // a regression gate — externalising the threshold must NOT change the
    // unset/prod posture (512 * 1024 * 1024 = 536870912).
    expect(loadConfig(base).agentUploadMaxAccountInFlightBytes).toBe(512 * 1024 * 1024);
    // Operator override is coerced from the env string to a number.
    expect(
      loadConfig({ ...base, AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES: '12288' })
        .agentUploadMaxAccountInFlightBytes,
    ).toBe(12_288);
  });

  it('concurrent-relay + concurrent-upload COUNT caps — prod defaults 16 / 4; tunable via env (hardening 2026-06-24)', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    // Defaults (the prod posture) when the env vars are unset.
    expect(loadConfig(base).agentRelayMaxAccountInFlight).toBe(16);
    expect(loadConfig(base).agentUploadMaxAccountInFlightCount).toBe(4);
    // Operator overrides coerced from env strings to numbers.
    expect(
      loadConfig({ ...base, AGENT_RELAY_MAX_ACCOUNT_INFLIGHT: '2' }).agentRelayMaxAccountInFlight,
    ).toBe(2);
    expect(
      loadConfig({ ...base, AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT: '1' })
        .agentUploadMaxAccountInFlightCount,
    ).toBe(1);
  });

  it('bundledTurnMaxConcurrency — prod default 3; tunable via BUNDLED_TURN_MAX_CONCURRENCY (billing-integrity TOCTOU bound)', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    expect(loadConfig(base).bundledTurnMaxConcurrency).toBe(3);
    expect(
      loadConfig({ ...base, BUNDLED_TURN_MAX_CONCURRENCY: '5' }).bundledTurnMaxConcurrency,
    ).toBe(5);
  });

  it('agentTurnMaxAccountInFlight — prod default 3; tunable via AGENT_TURN_MAX_ACCOUNT_INFLIGHT (cross-session fleet fairness)', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    expect(loadConfig(base).agentTurnMaxAccountInFlight).toBe(3);
    expect(
      loadConfig({ ...base, AGENT_TURN_MAX_ACCOUNT_INFLIGHT: '5' }).agentTurnMaxAccountInFlight,
    ).toBe(5);
  });

  it('globalIpRateLimitPerMin — prod default 600/min/IP; tunable via GLOBAL_IP_RATE_LIMIT_PER_MIN; 0 disables (DoS hardening)', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    // Default posture when the env var is unset.
    expect(loadConfig(base).globalIpRateLimitPerMin).toBe(600);
    // Operator override coerced from the env string to a number.
    expect(
      loadConfig({ ...base, GLOBAL_IP_RATE_LIMIT_PER_MIN: '1200' }).globalIpRateLimitPerMin,
    ).toBe(1200);
    // 0 is a valid (disable) value — nonnegative, not positive.
    expect(loadConfig({ ...base, GLOBAL_IP_RATE_LIMIT_PER_MIN: '0' }).globalIpRateLimitPerMin).toBe(
      0,
    );
  });

  it('boolean env vars use strict === \'true\' parsing (NOT z.coerce.boolean which makes "false" → true)', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };
    // The security-relevant one: AUTH_EXPOSE_DEBUG_TOKEN gates plaintext-token
    // leakage in auth responses. Setting it to "false" MUST disable it (the old
    // z.coerce.boolean() coerced "false" → true → leak-when-meant-to-disable).
    expect(
      loadConfig({ ...base, AUTH_EXPOSE_DEBUG_TOKEN: 'false' }).authFlowUrls.exposeDebugToken,
    ).toBe(false);
    expect(
      loadConfig({ ...base, AUTH_EXPOSE_DEBUG_TOKEN: '0' }).authFlowUrls.exposeDebugToken,
    ).toBe(false);
    expect(
      loadConfig({ ...base, AUTH_EXPOSE_DEBUG_TOKEN: 'true' }).authFlowUrls.exposeDebugToken,
    ).toBe(true);
    expect(loadConfig(base).authFlowUrls.exposeDebugToken).toBe(false); // unset → default false
    // Same fix for PLAYWRIGHT_HEADED.
    expect(loadConfig({ ...base, PLAYWRIGHT_HEADED: 'false' }).playwrightHeaded).toBe(false);
    expect(loadConfig({ ...base, PLAYWRIGHT_HEADED: 'true' }).playwrightHeaded).toBe(true);
    // V-820 — FLEET_CONTROL_PLANE_ENABLED gates the live /v1/fleet/events
    // WS route. Default-off; "false" must stay false (a coerce-inversion
    // here would activate an unguarded prod WS endpoint with no consumer).
    expect(loadConfig(base).fleetControlPlaneEnabled).toBe(false); // unset → default false
    expect(
      loadConfig({ ...base, FLEET_CONTROL_PLANE_ENABLED: 'false' }).fleetControlPlaneEnabled,
    ).toBe(false);
    expect(
      loadConfig({ ...base, FLEET_CONTROL_PLANE_ENABLED: 'true' }).fleetControlPlaneEnabled,
    ).toBe(true);
  });

  it('rejects invalid driver', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        DRIVER: 'puppeteer',
      }),
    ).toThrow();
  });

  it('rejects missing database url', () => {
    expect(() => loadConfig({})).not.toThrow();
    // default fallback applies — verifies graceful default for dev
  });

  it('parses R2 config when all five vars are set', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_RECORDINGS: 'recordings',
      R2_ENDPOINT_URL: 'https://acc.r2.cloudflarestorage.com',
    });
    expect(cfg.r2).toEqual({
      accountId: 'acc',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucketRecordings: 'recordings',
      bucketPublic: null,
      endpointUrl: 'https://acc.r2.cloudflarestorage.com',
    });
  });

  it('reads R2_BUCKET_PUBLIC when set', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_RECORDINGS: 'recordings',
      R2_BUCKET_PUBLIC: 'driftstack-public',
      R2_ENDPOINT_URL: 'https://acc.r2.cloudflarestorage.com',
    });
    expect(cfg.r2?.bucketPublic).toBe('driftstack-public');
  });

  it('returns r2: null when any R2 var is missing', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_RECORDINGS: 'recordings',
      // R2_ENDPOINT_URL missing
    });
    expect(cfg.r2).toBeNull();
  });

  it('V-079.B derives authFlowUrls from DASHBOARD_ORIGIN when per-URL vars are missing', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
    });
    expect(cfg.authFlowUrls.verifyEmail).toBe('https://app.driftstack.dev/verify-email');
    expect(cfg.authFlowUrls.magicLink).toBe('https://app.driftstack.dev/auth/magic-link');
    expect(cfg.authFlowUrls.passwordReset).toBe('https://app.driftstack.dev/reset-password');
  });

  it('V-079.B per-URL env var wins over DASHBOARD_ORIGIN derivation', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
      AUTH_VERIFY_EMAIL_URL: 'https://custom.example/verify',
    });
    expect(cfg.authFlowUrls.verifyEmail).toBe('https://custom.example/verify');
    expect(cfg.authFlowUrls.magicLink).toBe('https://app.driftstack.dev/auth/magic-link');
  });

  it('V-079.B fails fast in production when an auth URL still points at localhost', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'production',
        // No DASHBOARD_ORIGIN and no per-URL overrides → would fall back to localhost.
        AUTH_VERIFY_EMAIL_URL: 'http://localhost:5173/auth/verify-email',
      }),
    ).toThrow(/localhost/);
  });

  it('V-079.B fails fast in production when DASHBOARD_ORIGIN is unset', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'production',
        // No DASHBOARD_ORIGIN at all → zod falls back to localhost.
      }),
    ).toThrow(/DASHBOARD_ORIGIN/);
  });

  it('V-079.B production boot succeeds when DASHBOARD_ORIGIN resolves to a real host', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'production',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
    });
    expect(cfg.authFlowUrls.verifyEmail).toBe('https://app.driftstack.dev/verify-email');
  });

  it('refuses to expose plaintext auth-flow tokens in production', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'production',
        DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
        AUTH_EXPOSE_DEBUG_TOKEN: 'true',
      }),
    ).toThrow(
      /AUTH_EXPOSE_DEBUG_TOKEN=true is development\/test-only.*plaintext one-time authentication tokens/,
    );
  });

  it.each(['false', '0', 'no', 'off'])('keeps production debug tokens disabled for %s', (raw) => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'production',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
      AUTH_EXPOSE_DEBUG_TOKEN: raw,
    });
    expect(cfg.authFlowUrls.exposeDebugToken).toBe(false);
  });

  it.each(['development', 'test'])('retains the debug-token escape hatch in %s', (nodeEnv) => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: nodeEnv,
      AUTH_EXPOSE_DEBUG_TOKEN: 'true',
    });
    expect(cfg.authFlowUrls.exposeDebugToken).toBe(true);
  });

  it.each([undefined, 'production'])(
    'refuses the LLM fallback flag for %s deployment',
    (deployEnv) => {
      expect(() =>
        loadConfig({
          DATABASE_URL: 'postgres://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          NODE_ENV: 'production',
          ...(deployEnv === undefined ? {} : { DRIFTSTACK_DEPLOY_ENV: deployEnv }),
          DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
          DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK: 'true',
        }),
      ).toThrow(
        /DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK=true is staging-only.*BYOK or bundled-LLM consent/,
      );
    },
  );

  it('retains the explicit fallback-key demo path for the staging deployment', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'production',
      DRIFTSTACK_DEPLOY_ENV: 'staging',
      DASHBOARD_ORIGIN: 'https://staging.driftstack-customer-dashboard.pages.dev',
      DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK: 'true',
    });
    expect(cfg.agentDecomposer?.useFallbackForUnconfiguredCustomers).toBe(true);
  });

  it.each(['false', '0', 'no', 'off'])('keeps the LLM fallback disabled for %s', (raw) => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'production',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev',
      DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK: raw,
    });
    expect(cfg.agentDecomposer?.useFallbackForUnconfiguredCustomers).toBe(false);
  });

  it('W190 strips trailing slash from DASHBOARD_ORIGIN so `${dashboardOrigin}/billing` is clean', () => {
    // Operator pastes the env var with a trailing slash. Without the
    // schema-level strip, every URL built via template literals would
    // pick up a stray double slash (e.g. https://app.…//billing). The
    // V-079.B auth-flow URL derivation has its own strip; this guard
    // covers every OTHER consumer of `config.dashboardOrigin`.
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev/',
    });
    expect(cfg.dashboardOrigin).toBe('https://app.driftstack.dev');
    // Auth-flow derivation already handled the strip — sanity check
    // that both layers agree.
    expect(cfg.authFlowUrls.verifyEmail).toBe('https://app.driftstack.dev/verify-email');
  });

  it('W190 collapses multiple trailing slashes on DASHBOARD_ORIGIN', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DASHBOARD_ORIGIN: 'https://app.driftstack.dev///',
    });
    expect(cfg.dashboardOrigin).toBe('https://app.driftstack.dev');
  });

  it('Arc 4 Wave 2.B sub-slice 8.18 METRICS_SCRAPE_TOKEN passes through to config', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      METRICS_SCRAPE_TOKEN: 'abcdef0123456789abcdef',
    });
    expect(cfg.metricsScrapeToken).toBe('abcdef0123456789abcdef');
  });

  it('Arc 4 Wave 2.B sub-slice 8.18 METRICS_SCRAPE_TOKEN undefined when env-var unset', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(cfg.metricsScrapeToken).toBeUndefined();
  });

  it('Arc 4 Wave 2.B sub-slice 8.18 METRICS_SCRAPE_TOKEN < 16 chars is rejected', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        METRICS_SCRAPE_TOKEN: 'tooshort',
      }),
    ).toThrow();
  });

  it('Arc 7 obs.1 — Sentry release auto-tags from GIT_SHA when SENTRY_RELEASE is unset', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_DSN: 'https://abc@de.ingest.de.sentry.io/123',
      SENTRY_ENVIRONMENT: 'production',
      GIT_SHA: '1234567abcdef',
    });
    expect(cfg.sentry?.release).toBe('1234567abcdef');
  });

  it('Arc 7 obs.1 — explicit SENTRY_RELEASE overrides GIT_SHA (operator override wins)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_DSN: 'https://abc@de.ingest.de.sentry.io/123',
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'v1.2.3-rc.4',
      GIT_SHA: '1234567abcdef',
    });
    expect(cfg.sentry?.release).toBe('v1.2.3-rc.4');
  });

  it('Arc 7 obs.1 — neither SENTRY_RELEASE nor GIT_SHA set → release stays undefined (no misleading sentinel)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_DSN: 'https://abc@de.ingest.de.sentry.io/123',
      SENTRY_ENVIRONMENT: 'production',
    });
    expect(cfg.sentry?.release).toBeUndefined();
  });

  it('V-353b MFA_ENCRYPTION_KEY accepts a valid base64 32-byte AES-256 key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      MFA_ENCRYPTION_KEY: key,
    });
    expect(cfg.mfaEncryptionKey).toBe(key);
  });

  it('V-353b MFA_ENCRYPTION_KEY undefined when unset (MFA + BYOK + LiveKit + gui-control routes disabled)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(cfg.mfaEncryptionKey).toBeUndefined();
  });

  it('V-353b MFA_ENCRYPTION_KEY that base64-decodes to != 32 bytes is rejected EAGERLY at config-parse (boot fails, not a lazy first-customer 500)', () => {
    // 16 bytes → valid base64 but wrong AES-256 length. Pre-hardening this
    // booted fine + registered the routes, then threw inside decodeKey the
    // first time a customer enrolled MFA / saved a BYOK key.
    const shortKey = Buffer.alloc(16, 7).toString('base64');
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        MFA_ENCRYPTION_KEY: shortKey,
      }),
    ).toThrow(/32 bytes/);
  });

  it('PROFILE_MASTER_KEY accepts a valid base64 32-byte AES-256 key (profile DEK hierarchy, file 57)', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      PROFILE_MASTER_KEY: key,
    });
    expect(cfg.profileMasterKey).toBe(key);
  });

  it('PROFILE_MASTER_KEY undefined when unset (profile-backed sessions inert)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(cfg.profileMasterKey).toBeUndefined();
  });

  it('PROFILE_MASTER_KEY that base64-decodes to != 32 bytes is rejected EAGERLY at config-parse', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        PROFILE_MASTER_KEY: Buffer.alloc(16, 3).toString('base64'),
      }),
    ).toThrow(/32 bytes/);
  });

  it('V-156 DB_STATEMENT_TIMEOUT_MS coerces to dbStatementTimeoutMs (opt-in pool statement_timeout)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      DB_STATEMENT_TIMEOUT_MS: '30000',
    });
    expect(cfg.dbStatementTimeoutMs).toBe(30000);
  });

  it('V-156 dbStatementTimeoutMs undefined when unset (OFF by default — no statement_timeout, zero behaviour change)', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(cfg.dbStatementTimeoutMs).toBeUndefined();
  });

  it('V-156 DB_STATEMENT_TIMEOUT_MS rejects non-positive (must be a positive int ms)', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        DB_STATEMENT_TIMEOUT_MS: '0',
      }),
    ).toThrow();
  });
});
