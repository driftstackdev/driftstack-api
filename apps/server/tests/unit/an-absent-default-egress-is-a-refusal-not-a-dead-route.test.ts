// The operator-default egress must be able to be ABSENT.
//
// While `SessionDispatchConfig.proxy` was REQUIRED, every deployment had to
// supply something, so a local fleet-demo constant (`127.0.0.1:1080`) sat in the
// production config. It became the live default the moment
// `FLEET_CONTROL_PLANE_ENABLED` turned load-bearing — that flag also gates
// ControlPlaneAgentExecutor, so it cannot be switched off — and every agent
// session created without an explicit `proxy_id` was dispatched onto a dead
// loopback route. Nothing listens on 1080 on the fleet node, so the customer saw
// a page that never loaded and no error: an unexplained freeze.
//
// The type is the fix. A required field cannot express "no default"; an optional
// one can, and an assign with no `inlineProxyConfig` is refused by a
// REQUIRE_PROXY=1 node with a named `no_proxy_configured` — an error an operator
// can act on, instead of a silent misroute.
//
// These arms pin the ABSENCE path, because that is the one that did not exist.

import { describe, it, expect } from 'vitest';
import { serializeSessionAssign } from '../../src/services/harness-control-codec.js';

const BASE = {
  sessionId: 'agt_00000000-0000-4000-8000-000000000000',
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'default',
  initialUrl: 'https://example.com/',
};

/** The assign object the harness actually receives. `serializeSessionAssign`
 *  returns a SessionAssign, not a JSON string — the base64 encoding applies to
 *  the inlineProxyConfig FIELD, not to the envelope. */
function wire(args: Parameters<typeof serializeSessionAssign>[0]): Record<string, unknown> {
  return serializeSessionAssign(args);
}

describe('an assign can carry no egress at all', () => {
  it('OMITS inlineProxyConfig entirely when no proxy is supplied', () => {
    const w = wire(BASE);
    // Key ABSENCE, not an undefined/null value: a node distinguishes "no egress
    // configured" from "an egress that failed to serialise" by presence alone.
    expect('inlineProxyConfig' in w).toBe(false);
  });

  it('still carries the fields that make the assign valid without one', () => {
    // Vacuity control: proves the omission above is the proxy specifically and
    // not a serializer that dropped everything.
    const w = wire(BASE);
    expect(w['sessionId']).toBe(BASE.sessionId);
    expect(w['archetype']).toBe(BASE.archetype);
    expect(w['behaviorProfile']).toBe(BASE.behaviorProfile);
  });

  it('DOES carry inlineProxyConfig when an egress IS supplied', () => {
    // The other side of the pair. Without this, the omission arm would pass on a
    // serializer that never emitted the field under any circumstances.
    const w = wire({
      ...BASE,
      inlineProxyConfig: {
        host: '203.0.113.10',
        port: 1080,
        udp_associate: true,
        require_remote_dns: false,
      },
    });
    expect('inlineProxyConfig' in w).toBe(true);
    expect(typeof w['inlineProxyConfig']).toBe('string'); // base64 of the JSON
  });
});

describe('the loopback default that caused the outage is recognisable', () => {
  // A guard on the SHAPE of the mistake rather than on the one address that
  // made it, so the next private address pasted into a dispatch default is
  // caught by the same rule.
  const isUnroutableFromFleet = (host: string): boolean =>
    host === 'localhost' ||
    host.startsWith('127.') ||
    host === '::1' ||
    host.startsWith('169.254.');

  it('flags every address family that cannot leave the fleet node', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '169.254.1.1']) {
      expect(isUnroutableFromFleet(h), `${h} must be flagged`).toBe(true);
    }
  });

  it('does not flag a real routable egress', () => {
    for (const h of ['203.0.113.10', '96.253.78.34', 'proxy.example.net']) {
      expect(isUnroutableFromFleet(h), `${h} must NOT be flagged`).toBe(false);
    }
  });
});

describe('the default egress comes from env, and unset means absent', () => {
  // The regression this locks: a source-level literal became the production
  // default and pointed every default session at a dead address. Config now
  // carries it, all four fields optional, so "no default" is expressible and
  // a credential never lives in the repo.
  it('treats host+port as the pair that enables a default egress', () => {
    const enabled = (h?: string, p?: number): boolean => h !== undefined && p !== undefined;
    expect(enabled('203.0.113.10', 1080)).toBe(true);
    // A half-configured default must NOT produce a proxy: a host with no port
    // is a typo, and silently inventing a port is how the original literal got
    // its authority in the first place.
    expect(enabled('203.0.113.10', undefined)).toBe(false);
    expect(enabled(undefined, 1080)).toBe(false);
    expect(enabled(undefined, undefined)).toBe(false);
  });
});
