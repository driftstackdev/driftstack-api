import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GUI audit #17 — the exit-location check through a proxy always asked the
 * production API, whatever server the app was configured for: a staging or
 * self-hosted customer's proxy exits went to production, and where production
 * was unreachable through the proxy the exit read as unknown. The check now
 * hands the native side the configured server; the native side accepts https
 * only (its own test: `the_exit_probe_asks_the_configured_server_not_production`).
 */

const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>) =>
  Promise.resolve({ ip: '203.0.113.7', country: 'NL', city: null, region: null, timezone: null }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const disk = new Map<string, unknown>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get<T>(k: string): Promise<T | undefined> {
      return Promise.resolve(disk.get(k) as T | undefined);
    }
    set(k: string, v: unknown): Promise<void> {
      disk.set(k, v);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { probeProxyExit } = await import('../../src/lib/proxies');

beforeEach(() => {
  invoke.mockClear();
  disk.clear();
});

describe('the exit-location check through a proxy', () => {
  it('CRITICAL asks the server the app is configured for', async () => {
    disk.set('driftstack', { baseUrl: 'https://staging.driftstack.dev' });
    await probeProxyExit({ host: '203.0.113.10', port: 1080, username: 'u', password: 'p' });
    expect(invoke).toHaveBeenCalledWith('proxy_exit_probe', {
      host: '203.0.113.10',
      port: 1080,
      username: 'u',
      password: 'p',
      apiBase: 'https://staging.driftstack.dev',
    });
  });

  it('a self-hosted server is asked too, never production', async () => {
    disk.set('driftstack', { baseUrl: 'https://driftstack.internal.acme.com' });
    await probeProxyExit({ host: 'h', port: 1, username: null, password: null });
    expect(invoke.mock.calls[0]?.[1]?.apiBase).toBe('https://driftstack.internal.acme.com');
  });
});
