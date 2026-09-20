// ⛔ A SESSION ASKS THE DEVICE FOR A BEHAVIOUR PROFILE IT KNOWS.
//
// The device resolves `behaviorProfile` as a persona name (casual | regular |
// power_user) or as a speed on the regular persona (fast | balanced | careful).
// A value outside those six is NOT refused — the wire is an open string, so it
// falls to the device's fallback without a word. That is how every AI session
// came to send the literal 'default': nothing on either side could go red.
//
// Two facts are held here, because either one drifting reopens the hole:
//   1. every profile a customer can choose is one the device resolves;
//   2. the default the server applies is one of them too.
// The third fact — the value bootstrap writes — is held by the TYPE of
// SessionDispatchConfig.behaviorProfile (a free string cannot be assigned to it)
// and pinned in lib-bootstrap-content-parity.
import { describe, expect, it } from 'vitest';
import { BehavioralProfileSchema, DEFAULT_BEHAVIORAL_PROFILE } from '@driftstack/api-types';
import {
  DEVICE_BEHAVIOR_PROFILES,
  SessionAssignSchema,
} from '../../src/schemas/harness-control-protocol.js';
import type { SessionDispatchConfig } from '../../src/routes/agent-sessions.js';

describe('the behaviour profile a session asks the device for', () => {
  it('every profile a customer can choose is one the device resolves', () => {
    const known = new Set<string>(DEVICE_BEHAVIOR_PROFILES);
    const unknown = BehavioralProfileSchema.options.filter((p) => !known.has(p));
    expect(unknown).toEqual([]);
  });

  it('the default the server applies is one the device resolves', () => {
    expect(DEVICE_BEHAVIOR_PROFILES).toContain(DEFAULT_BEHAVIORAL_PROFILE);
  });

  it("'default' is NOT one of them — the name that was sent for months names nothing", () => {
    expect(DEVICE_BEHAVIOR_PROFILES as readonly string[]).not.toContain('default');
    expect(DEVICE_BEHAVIOR_PROFILES as readonly string[]).not.toContain('custom');
  });

  it('the dispatch config cannot hold a free string (the type is the guard)', () => {
    // @ts-expect-error — 'default' is not a profile the device resolves.
    const bad: SessionDispatchConfig['behaviorProfile'] = 'default';
    expect(bad).toBe('default');
  });

  it('the WIRE stays an open string, so a newer device name is not rejected on decode', () => {
    const frame = SessionAssignSchema.safeParse({
      type: 'sessionAssign',
      sessionId: 's-1',
      archetype: 'iphone16pro_ios18_6_safari18_6',
      behaviorProfile: 'a-name-a-newer-device-learned',
    });
    expect(frame.success).toBe(true);
  });
});
