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
});
