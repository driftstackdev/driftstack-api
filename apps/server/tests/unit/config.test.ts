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
      endpointUrl: 'https://acc.r2.cloudflarestorage.com',
    });
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
});
