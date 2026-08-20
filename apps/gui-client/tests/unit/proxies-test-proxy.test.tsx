// Unit coverage for testProxy (proxies.ts) — the typed wrapper over the
// native `proxy_test` Tauri command. The command itself (SOCKS5
// handshake + UDP-associate probe) is exercised by the Rust unit tests
// in src-tauri; here we pin the JS-side contract: the wrapper forwards
// host/port/username/password under the exact arg names the Rust
// command binds, and returns the structured result verbatim.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));

// Imported after the mock is registered so the module binds the stub.
const { testProxy } = await import('../../src/lib/proxies');

describe('testProxy (gui-client/lib/proxies)', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('invokes the proxy_test command with the exact arg names the Rust side binds', async () => {
    invoke.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 42,
      message: 'ok',
    });

    await testProxy({ host: 'proxy.example.com', port: 1080, username: 'u', password: 'p' });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('proxy_test', {
      host: 'proxy.example.com',
      port: 1080,
      username: 'u',
      password: 'p',
    });
  });

  it('forwards null credentials unchanged (no auth offered)', async () => {
    invoke.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: false,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 10,
      message: 'ok',
    });

    await testProxy({ host: '10.0.0.1', port: 9050, username: null, password: null });

    expect(invoke).toHaveBeenCalledWith('proxy_test', {
      host: '10.0.0.1',
      port: 9050,
      username: null,
      password: null,
    });
  });

  it('returns the structured ProxyTestResult from the command verbatim', async () => {
    const result = {
      reachable: true,
      auth_ok: false,
      udp_associate: false,
      can_route: false,
      connect_reply: 0xff,
      latency_ms: 88,
      message: 'Connected, but the proxy rejected the username/password.',
    };
    invoke.mockResolvedValue(result);

    await expect(
      testProxy({ host: 'h', port: 1080, username: 'bad', password: 'creds' }),
    ).resolves.toEqual(result);
  });
});
