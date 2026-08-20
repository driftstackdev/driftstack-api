// The proxy test reported success for proxies that could not carry traffic at all.
//
// `run_socks5_probe` did three things: TCP connect → `reachable`, username/password auth
// → `auth_ok`, then a UDP-ASSOCIATE probe → `udp_associate`. It never issued a SOCKS5
// CONNECT to any destination. And the GUI's definition of healthy was
// `reachable && auth_ok`, spelled out separately in three places.
//
// Authenticating and ROUTING are separate permissions on every commercial proxy. An
// endpoint whose plan has lapsed, or whose ruleset forbids a destination, authenticates
// perfectly and then refuses every CONNECT.
//
// Measured live on 2026-08-18: all five NodeMaven endpoints (gate.nodemaven.com:1080)
// authenticated and answered CONNECT REFUSED 0x02 — "not allowed by ruleset". The
// desktop Test button called every one of them healthy, and profiles launched through
// them reached nothing. Reported as bus note #6 and never answered.
//
// ── why this file exists separately ───────────────────────────────────────────
//
// The view suites that render the health pill all `vi.mock('../../src/lib/proxies')`,
// so they exercise a stubbed predicate, not the real one. Mutating `isProxyUsable` left
// all 18 of them green — verified, not assumed. A predicate that decides whether a
// customer's traffic leaves the machine needs a guard that actually imports it.

import { describe, expect, it } from 'vitest';
import { isProxyUsable, type ProxyTestResult } from '../../src/lib/proxies';

const base: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: '',
};

describe('a proxy that authenticates is not a proxy that works', () => {
  it('CRITICAL a fully working proxy is usable. Every other arm here reports a REFUSAL, and a predicate that returned false for everything would satisfy them all while marking every proxy dead — so this is the arm that makes the rest mean something.', () => {
    expect(isProxyUsable(base), 'a healthy proxy was rejected').toBe(true);
  });

  it('CRITICAL a proxy that authenticates but cannot ROUTE is NOT usable. This is the whole defect: five endpoints passed auth and refused every CONNECT with 0x02, and the old definition — reachable && auth_ok — called them healthy while nothing could reach the internet through them.', () => {
    const authOkNoRoute: ProxyTestResult = {
      ...base,
      can_route: false,
      connect_reply: 0x02,
    };
    expect(
      isProxyUsable(authOkNoRoute),
      'a proxy that refuses every CONNECT is still reported as usable — the exact state that shipped',
    ).toBe(false);
  });

  it('CRITICAL routing is required, not merely preferred, whatever the other signals say. A proxy can be reachable, authenticated AND relay UDP while refusing TCP CONNECT; UDP support is a qualifier on a working proxy, never a substitute for one.', () => {
    expect(isProxyUsable({ ...base, can_route: false, udp_associate: true })).toBe(false);
    expect(isProxyUsable({ ...base, can_route: false, udp_associate: false })).toBe(false);
  });

  it('CRITICAL the earlier signals still gate. Adding routing to the definition must not accidentally make an unreachable or auth-rejected proxy usable just because a stale can_route survived from a previous probe.', () => {
    expect(isProxyUsable({ ...base, reachable: false }), 'an unreachable proxy passed').toBe(false);
    expect(isProxyUsable({ ...base, auth_ok: false }), 'an auth-rejected proxy passed').toBe(false);
  });

  it('CRITICAL a usable verdict requires all three together. Spelled as a matrix so a future refactor cannot satisfy the arms above by checking any two of them.', () => {
    for (const reachable of [true, false]) {
      for (const auth_ok of [true, false]) {
        for (const can_route of [true, false]) {
          const expected = reachable && auth_ok && can_route;
          expect(
            isProxyUsable({ ...base, reachable, auth_ok, can_route }),
            `reachable=${String(reachable)} auth_ok=${String(auth_ok)} can_route=${String(can_route)}`,
          ).toBe(expected);
        }
      }
    }
  });
});
