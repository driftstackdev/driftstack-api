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
import type {
  ProbeExitIdentity,
  ProxyConnectivityProbe,
} from '../../src/services/proxy-connectivity-probe.js';
import { InMemoryExitIdentityCache } from '../../src/services/exit-identity-cache.js';

const PROBED_IDENTITY: ProbeExitIdentity = {
  ip: '203.0.113.7',
  country: 'US',
  region: 'California',
  city: 'San Jose',
  timezone: 'America/Los_Angeles',
};

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
        tier: 'api_builder',
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
        tier: 'api_builder',
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
        tier: 'api_builder',
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
        tier: 'api_builder',
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
        tier: 'api_builder',
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
        tier: 'api_builder',
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

  // #128 — the gate is the WRITE side of the exit-identity bridge: on a clean probe
  // that observed the exit identity, it stashes it keyed by (accountId, proxyId) so
  // the later dispatch build can emit exit_identity for the box new-tab IP panel.
  it('SETs the exit-identity cache when the probe observed one (bridge write side)', async () => {
    const probeFn = vi.fn().mockResolvedValue({ ok: true, exitIdentity: PROBED_IDENTITY });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    const cache = new InMemoryExitIdentityCache();
    await runProxyPrelaunchGate({
      tier: 'api_builder',
      probe,
      enabled: true,
      accountProxiesService: service,
      proxyId: 'prx_ok',
      accountId: 'acc_1',
      logger: logger(),
      exitIdentityCache: cache,
    });
    expect((await cache.get('acc_1', 'prx_ok'))?.identity).toEqual(PROBED_IDENTITY);
  });

  it('does NOT cache when the probe passed but observed no exit identity (optional block stays absent)', async () => {
    const { probe } = makeOkProbe(); // resolves { ok: true } — no exitIdentity
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    const cache = new InMemoryExitIdentityCache();
    await runProxyPrelaunchGate({
      tier: 'api_builder',
      probe,
      enabled: true,
      accountProxiesService: service,
      proxyId: 'prx_ok',
      accountId: 'acc_1',
      logger: logger(),
      exitIdentityCache: cache,
    });
    expect(await cache.get('acc_1', 'prx_ok')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('does NOT cache on a probe FAILURE even if an identity rode along (a blocked launch caches nothing)', async () => {
    const probeFn = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'unreachable', exitIdentity: PROBED_IDENTITY });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    const cache = new InMemoryExitIdentityCache();
    await expect(
      runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_down',
        accountId: 'acc_1',
        logger: logger(),
        exitIdentityCache: cache,
      }),
    ).rejects.toBeInstanceOf(ProxyValidationFailedError);
    expect(cache.size()).toBe(0);
  });

  // ── retry policy ────────────────────────────────────────────────
  //
  // The gate retries a failed probe exactly once, and only for `unreachable`.
  // The source explains both halves: rotating residential exits drop a dial and
  // stream fine on the next one, so a single transient miss must not fail a
  // launch; `auth_failed` means wrong credentials, where a retry cannot help and
  // repeated attempts risk the provider locking the account.
  //
  // That policy was previously guarded only by accident. Widening the condition
  // to retry EVERY failure did red the suite — but via the injection-detail case
  // below, which happens to count probe calls. A property nothing states is a
  // property that survives only as long as an unrelated fixture keeps its shape.

  it('CRITICAL retries ONCE on a transient unreachable, then blocks if it fails again', async () => {
    const probeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'unreachable' });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    await expect(
      runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_flaky',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).rejects.toBeInstanceOf(ProxyValidationFailedError);
    expect(
      probeFn.mock.calls.length,
      'a transient unreachable must be retried exactly once — no retry fails launches on rotating ' +
        'residential exits, more than one turns a dead proxy into a slow create',
    ).toBe(2);
  });

  it('CRITICAL a transient unreachable that succeeds on the retry lets the launch through', async () => {
    const probeFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable' })
      .mockResolvedValueOnce({ ok: true });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    await expect(
      runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_flaky',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    expect(probeFn.mock.calls.length, 'the retry is what makes this pass').toBe(2);
  });

  it('CRITICAL NEVER retries auth_failed — wrong credentials, and repeats risk a provider lockout', async () => {
    const probeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'auth_failed' });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });
    await expect(
      runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_badcreds',
        accountId: 'acc_1',
        logger: logger(),
      }),
    ).rejects.toBeInstanceOf(ProxyValidationFailedError);
    expect(
      probeFn.mock.calls.length,
      'auth_failed was retried. A retry cannot fix wrong credentials, and repeated failed auth is ' +
        'how a provider locks the customer’s account',
    ).toBe(1);
  });

  it('never forwards remote-controlled probe detail into the customer 422', async () => {
    const hostile = `HTTP/1.1 599 ${'remote prose '.repeat(30_000)}secret=do-not-reflect`;
    const probeFn = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'egress_blocked',
      detail: hostile,
    });
    const probe = { probe: probeFn } as unknown as ProxyConnectivityProbe;
    const { service } = makeService({ host: '203.0.113.7', port: 1080 });

    try {
      await runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_hostile',
        accountId: 'acc_1',
        logger: logger(),
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyValidationFailedError);
      const problem = (err as ProxyValidationFailedError).toProblem();
      expect(problem.detail).toBe(
        'The proxy connected but could not reach the internet — its upstream egress is blocked.',
      );
      expect(JSON.stringify(problem)).not.toContain('remote prose');
      expect(JSON.stringify(problem)).not.toContain('do-not-reflect');
    }
    expect(probeFn).toHaveBeenCalledTimes(1);
  });
});
