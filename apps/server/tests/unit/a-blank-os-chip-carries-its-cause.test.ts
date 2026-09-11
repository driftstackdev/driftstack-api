// (o) O1 — the CROSS-FILE half of "an absent OS fingerprint carries its cause".
//
// The route distinguishes `observer_off` from `not_observed` by matching the
// `reason` string `ProxyConnectivityProbe.observeOs` returns when no raw-socket
// observer is configured. That is a coupling between two files, and the failure
// it invites is silent in the worst direction: reword the probe's literal and
// EVERY deployment with the observer off starts answering `not_observed`, which
// tells the customer to retry a Test that cannot possibly produce a value — the
// exact dead-end hint this whole item removes. Nothing would go red.
//
// So the literal is pinned HERE, against the REAL probe, from both ends:
//   1. the probe with NO osObserver returns exactly that reason (a behavioural
//      assertion, not a grep — it constructs the class and calls the method);
//   2. the route module holds the same literal in
//      `OBSERVER_NOT_CONFIGURED_REASON`.
// Either side drifting reds arm 1 or arm 2.
//
// PRODUCTION LINES THIS GUARDS:
//   * `services/proxy-connectivity-probe.ts` — the
//     `if (this.osObserver === undefined) return { observed: false, reason:
//     'observer not configured' }` early return. Reword the string and arm 1
//     reds; delete the early return and arm 1 reds on the changed shape.
//   * `routes/account-me.ts` — `const OBSERVER_NOT_CONFIGURED_REASON = ...`.
//     Change it to anything else and arm 2 reds.
//
// ⚠️ Arm 3 is the vacuity control and it fails in the direction the real failure
// goes: a probe that answered "observer not configured" for EVERY miss would
// make the pin above meaningless (every refused tunnel would report
// `observer_off`, and no retry would ever be offered). Arm 3 asserts a CONFIGURED
// observer that simply recorded nothing says something else.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ProxyConnectivityProbe,
  type ProbeProxyDescriptor,
} from '../../src/services/proxy-connectivity-probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, '..', '..', 'src', 'routes', 'account-me.ts');

const PROXY: ProbeProxyDescriptor = { protocol: 'socks5', host: 'proxy.example', port: 1080 };

describe('the observer-off cause is pinned to the probe that produces it', () => {
  it('CRITICAL a probe with NO osObserver answers `observed:false` with the exact reason the route matches on — and reaches the network for nothing', async () => {
    // No `dial` is supplied: if the early return were removed, this would try to
    // open a real socket rather than answering, so the arm also pins that the
    // off case never touches the network.
    const probe = new ProxyConnectivityProbe({});
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    expect(r.reason).toBe('observer not configured');
  });

  it('CRITICAL the route matches THAT literal — the two files cannot drift apart silently', () => {
    const src = readFileSync(ROUTE, 'utf8');
    expect(src).toContain("const OBSERVER_NOT_CONFIGURED_REASON = 'observer not configured';");
    // And it is actually CONSULTED — a constant nothing reads would satisfy the
    // line above while every observer-off deployment reported `not_observed`.
    expect(src).toContain('os.reason === OBSERVER_NOT_CONFIGURED_REASON');
    // Both outcomes of that comparison exist, so the branch is a real fork.
    expect(src).toContain("('observer_off' as const)");
    expect(src).toContain("('not_observed' as const)");
  });

  it('CONTROL a CONFIGURED observer that recorded nothing reports a DIFFERENT reason — otherwise every refused tunnel would claim the observer is off and no retry would ever be offered', async () => {
    const probe = new ProxyConnectivityProbe({
      // A dial that always fails: the observer IS configured, so the off-branch
      // must not be taken and the reason must name the dial, not the config.
      dial: () => Promise.reject(new Error('connection refused')),
      osObserver: {
        host: 'observer.example',
        port: 7791,
        lookup: () => Promise.resolve({ kind: 'absent' as const }),
      },
    });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    expect(r.reason).not.toBe('observer not configured');
  });
});
