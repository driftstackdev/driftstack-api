// runProxyPrelaunchGate — the CP-side pre-launch proxy validation gate (#63).
//
// Covers the null-resolveForDispatch fix: a proxy whose stored config can't be
// decrypted (or is a non-dispatchable scheme) must BLOCK the launch with a clean
// 422 at create time, NOT silently 201 and dead-end at dispatch (which would open
// a simulator window that spins forever). Also pins the no-op gates (probe unwired
// / disabled) and the VPN-wire skip.

import { describe, expect, it, vi } from 'vitest';
import { runProxyPrelaunchGate } from '../../src/routes/agent-sessions.js';
import { ProxyValidationFailedError } from '../../src/lib/errors.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { ProxyConnectivityProbe } from '../../src/services/proxy-connectivity-probe.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** A probe whose `.probe()` is a captured mock so assertions don't read it off
 *  the object (which trips no-unbound-method). */
function makeOkProbe(): { probe: ProxyConnectivityProbe; probeFn: ReturnType<typeof vi.fn> } {
  const probeFn = vi.fn().mockResolvedValue({ ok: true });
  return { probe: { probe: probeFn } as unknown as ProxyConnectivityProbe, probeFn };
}

/** An account-proxies service whose `resolveForDispatch` is a captured mock. */
function makeService(resolved: unknown): {
  service: AccountProxiesService;
  resolveFn: ReturnType<typeof vi.fn>;
} {
  const resolveFn = vi.fn().mockResolvedValue(resolved);
  return {
    service: { resolveForDispatch: resolveFn } as unknown as AccountProxiesService,
    resolveFn,
  };
}

describe('runProxyPrelaunchGate — null resolveForDispatch blocks the launch (#6)', () => {
  it('throws ProxyValidationFailedError (unreachable) when resolveForDispatch returns null — no silent 201/spin', async () => {
    const { probe, probeFn } = makeOkProbe();
    const { service } = makeService(null);
    const log = logger();
    await expect(
      runProxyPrelaunchGate({
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_undecryptable',
        accountId: 'acc_1',
        logger: log,
      }),
    ).rejects.toBeInstanceOf(ProxyValidationFailedError);
    // The probe is never even dialed — we block before the live test.
    expect(probeFn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('the thrown error is a 422 with reason=unreachable (the clean create-time signal the GUI surfaces)', async () => {
    const { probe } = makeOkProbe();
    const { service } = makeService(null);
    try {
      await runProxyPrelaunchGate({
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_x',
        accountId: 'acc_1',
        logger: logger(),
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyValidationFailedError);
      const e = err as ProxyValidationFailedError;
      expect(e.status).toBe(422);
      expect(e.extensions).toMatchObject({ reason: 'unreachable', resource: 'proxy' });
    }
  });

  it('no-op when the probe is unwired — a null resolve does NOT block (the dispatch close + reaper still backstop)', async () => {
    const { service, resolveFn } = makeService(null);
    await expect(
      runProxyPrelaunchGate({
        probe: undefined,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_x',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    // We return before even resolving (the gate is inert).
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('no-op when the gate is disabled', async () => {
    const { probe } = makeOkProbe();
    const { service, resolveFn } = makeService(null);
    await expect(
      runProxyPrelaunchGate({
        probe,
        enabled: false,
        accountProxiesService: service,
        proxyId: 'prx_x',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('a resolved VPN wire SKIPS the live probe (box-side W2931 covers it)', async () => {
    const { probe, probeFn } = makeOkProbe();
    const { service } = makeService({ type: 'wireguard' });
    await expect(
      runProxyPrelaunchGate({
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_vpn',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('a resolved socks5 proxy that probes OK passes (the gate proceeds)', async () => {
    const { probe, probeFn } = makeOkProbe();
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    await expect(
      runProxyPrelaunchGate({
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_ok',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    expect(probeFn).toHaveBeenCalledTimes(1);
  });
});
