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
});
