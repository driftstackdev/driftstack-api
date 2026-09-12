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
import type {
  AccountProxiesService,
  ProxyUnresolvableReason,
} from '../../src/services/account-proxies.js';
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

/** An account-proxies service whose resolve is a captured mock.
 *
 *  (V3 2026-09-12) — the gate reads `resolveForDispatchWithReason`: the same
 *  resolve, carrying WHY a null is null. The real service defines
 *  `resolveForDispatch` as that method's `.config`, so the double does the same
 *  and one mock answers both. `cause` is what the service attaches beside a null
 *  (a reason code + the sentence the customer reads). */
function makeService(
  resolved: unknown,
  cause?: { reason: ProxyUnresolvableReason; detail?: string },
): {
  service: AccountProxiesService;
  resolveFn: ReturnType<typeof vi.fn>;
} {
  const resolveFn = vi
    .fn()
    .mockResolvedValue({ config: resolved, ...(cause !== undefined ? cause : {}) });
  return {
    service: {
      resolveForDispatchWithReason: resolveFn,
      resolveForDispatch: (args: unknown) =>
        (resolveFn(args) as Promise<{ config: unknown }>).then((r) => r.config),
    } as unknown as AccountProxiesService,
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

  // (V3 2026-09-12, owner: "session not starting still") — the 422 must name the
  // CAUSE. Nine causes reached this gate as one null and got one sentence: "its
  // stored configuration could not be read. Re-add it and try again." For a
  // POLICY refusal (a `script-security 2` line, an external cert/key reference)
  // that sentence is false and its instruction is a loop — re-adding the same
  // file is refused again — which is exactly the shape of the owner's report.
  it('the 422 detail is the CAUSE’s sentence when the service named one (a refused directive names the line)', async () => {
    const { probe, probeFn } = makeOkProbe();
    const { service } = makeService(null, {
      reason: 'config_refused_directive',
      detail:
        'Line 46: "script-security 2" — Driftstack does not run scripts from VPN configs. Remove this line and try again.',
    });
    const log = logger();
    try {
      await runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_directive',
        accountId: 'acc_1',
        logger: log,
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyValidationFailedError);
      const e = err as ProxyValidationFailedError;
      expect(e.status).toBe(422);
      expect(e.detail).toContain('Line 46: "script-security 2"');
      expect(e.detail).not.toContain('could not be read');
    }
    expect(probeFn).not.toHaveBeenCalled();
    // …and the LOG carries the closed-set code, so triage names the cause
    // without a repro (it used to say only "decrypt/config").
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'config_refused_directive' }),
      expect.stringContaining('blocking launch'),
    );
  });

  it('CONTROL — a null with NO cause still gets the shipped sentence (an older/partial service is unchanged)', async () => {
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
      expect((err as ProxyValidationFailedError).detail).toContain('could not be read');
    }
  });

  // ⛔⛔ (V4 follow-up 2026-09-12) — `unreachable` WAS A FALSE CONTRACTUAL CLAIM
  // HERE, for a dial that provably never happened.
  //
  // The SDK documents that enum member as "the proxy … failed the server's LIVE
  // pre-launch connectivity test (a real egress round-trip THROUGH the proxy)",
  // and the desktop copy for it is "The proxy did not answer. Check the host and
  // port, and that it is online." This branch fires BEFORE any socket, on a
  // STORED CONFIG that could not be resolved — and for a VPN row the gate skips
  // the probe entirely (`'type' in resolved` → return), so nothing is ever
  // dialled at all. Every consumer branching on the enum as documented was told
  // a measurement had been taken from a vantage that never ran, and the customer
  // was pointed at a host and port that were never the problem.
  //
  // MUTATION (run): put `reason: 'unreachable'` back unconditionally → the first
  // arm reds; the CONTROL arms below stay green, which is what separates "the
  // gate names the right cause" from "the gate names one cause".
  it('CRITICAL a null WITH a cause is reason=config_unresolvable — never `unreachable`, which claims a round-trip', async () => {
    const { probe, probeFn } = makeOkProbe();
    const { service } = makeService(null, {
      reason: 'config_incomplete',
      detail: 'This VPN’s stored configuration is incomplete (missing: Address).',
    });
    try {
      await runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_incomplete',
        accountId: 'acc_1',
        logger: logger(),
      });
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as ProxyValidationFailedError;
      expect(e.status).toBe(422);
      expect(e.extensions).toMatchObject({ reason: 'config_unresolvable', resource: 'proxy' });
      // The cause's own sentence still rides along.
      expect(e.detail).toContain('missing: Address');
    }
    // Nothing was dialled — which is the whole reason the enum member exists.
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('CONTROL — the PROBE’s own verdict keeps `unreachable`: there a round-trip really was attempted', async () => {
    // Without this, renaming the probe's verdict too would pass the arm above.
    const probeFn = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: 'unreachable' as const }),
    );
    const probe = { probe: probeFn } as unknown as Parameters<
      typeof runProxyPrelaunchGate
    >[0]['probe'];
    const { service } = makeService({ host: '203.0.113.5', port: 1080, udp_associate: true });
    try {
      await runProxyPrelaunchGate({
        tier: 'api_builder',
        probe,
        enabled: true,
        accountProxiesService: service,
        proxyId: 'prx_socks',
        accountId: 'acc_1',
        logger: logger(),
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ProxyValidationFailedError).extensions).toMatchObject({
        reason: 'unreachable',
      });
    }
    expect(probeFn).toHaveBeenCalled();
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
  // The gate samples a failed probe up to THREE times, and only for `unreachable`.
  // The source explains each half: rotating residential exits drop a dial and
  // stream fine on the next one, so a transient miss must not fail a launch;
  // `auth_failed` means wrong credentials, where a retry cannot help and repeated
  // attempts risk the provider locking the account.
  //
  // ⛔ IT WAS TWO, AND TWO WAS MEASURABLY NOT ENOUGH. A customer-used upstream was
  // measured at 4 failed connects in 15 (27%) from the fleet node against a
  // matched control at 0 in 15, so both of two attempts failing is ~7% — a 1-in-14
  // launch REFUSAL on a proxy that carries sessions and delivers frames. Three
  // takes it to ~2%, and matches the node's own K-consecutive dead-proxy
  // threshold, which is the standard the rest of this path already follows.
  //
  // ⭐ The OLD pin's rationale — "more than one turns a dead proxy into a slow
  // create" — was right, and is answered rather than ignored: a wall-clock budget
  // gates the THIRD attempt only. A blackholed proxy fails by timeout and gets the
  // historical two dials; a flapping one refuses fast (RST) and gets all three in
  // under a second. The budget must never gate the SECOND attempt — doing so
  // regressed the very case the retry exists for, since a rotating exit fails by
  // TIMEOUT and attempt 1 alone can outlast the budget.
  //
  // That policy was previously guarded only by accident. Widening the condition
  // to retry EVERY failure did red the suite — but via the injection-detail case
  // below, which happens to count probe calls. A property nothing states is a
  // property that survives only as long as an unrelated fixture keeps its shape.

  it('CRITICAL retries up to TWICE on a transient unreachable, then blocks if it still fails', async () => {
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
      'a transient unreachable is sampled three times — one dial fails ~1 launch in 4 on a ' +
        'measured-flaky upstream, and two still fails ~1 in 14; the wall-clock budget is what ' +
        'keeps a genuinely dead proxy from becoming a slow create',
    ).toBe(3);
  });

  it('CRITICAL the wall-clock budget NEVER gates the second attempt', async () => {
    // ⛔ THE REGRESSION THIS EXISTS TO STOP, and it was live for one gate run. The
    // budget originally guarded every retry, so a rotating residential exit —
    // which fails by TIMEOUT — could spend the whole budget on attempt 1 and get
    // FEWER dials than before the change. The retry exists precisely for that
    // case. A budget of 0 is the sharpest version: even with nothing left, the
    // second attempt must still happen.
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
        retryBudgetMs: 0,
      }),
    ).rejects.toBeInstanceOf(ProxyValidationFailedError);
    expect(
      probeFn.mock.calls.length,
      'the historical one-retry guarantee is unconditional; only the THIRD dial is budgeted',
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
