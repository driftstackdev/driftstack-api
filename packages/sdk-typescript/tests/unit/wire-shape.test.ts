// Wire-shape lock tests for InteractAction + WaitCondition.
//
// Built into the contract audit pass (V-037) after Go's `time_ms`
// vs `time` bug shipped silently in 0.1.0–0.1.1 — the kind of typo
// that corrupts every wait call without ever throwing. Pinning the
// exact JSON shape here means the next time the schema shifts, this
// test breaks before customers do.
//
// These are unit tests against Zod-validated shapes; if a future
// change introduces a discriminator typo or renames a field, the
// `parse()` step will throw and the test fails loudly.

import { describe, expect, it } from 'vitest';
import {
  InteractActionSchema,
  InteractRequestSchema,
  NavigateRequestSchema,
  WaitConditionSchema,
  WaitRequestSchema,
} from '@driftstack/api-types';

describe('InteractAction wire shape', () => {
  it('tap variant', () => {
    const action = InteractActionSchema.parse({ kind: 'tap', selector: '#go' });
    expect(action).toEqual({ kind: 'tap', selector: '#go' });
  });

  it('tap rejects offset (L-001 — coordinate primitive removed)', () => {
    // tap.offset was on the public surface in 0.1.x → 0.1.4. Same L-001
    // failure mode as tap_at — bounded coordinates are still coordinates.
    // Removed in 0.1.5; selector specificity is the intent-shaped answer.
    const parsed = InteractActionSchema.parse({
      kind: 'tap',
      selector: '#go',
      offset: { x: 4, y: -2 },
    });
    // Zod strips unknown keys by default on object schemas — assert the
    // parsed shape has no `offset` field, regardless of input.
    expect(parsed).toEqual({ kind: 'tap', selector: '#go' });
    expect('offset' in parsed).toBe(false);
  });

  it('type variant', () => {
    const action = InteractActionSchema.parse({
      kind: 'type',
      selector: 'input[name=email]',
      text: 'hello@example.com',
    });
    expect(action.kind).toBe('type');
    if (action.kind === 'type') {
      expect(action.selector).toBe('input[name=email]');
      expect(action.text).toBe('hello@example.com');
    }
  });

  it('scroll variant uses delta_x / delta_y, not x / y', () => {
    const action = InteractActionSchema.parse({
      kind: 'scroll',
      delta_x: 0,
      delta_y: 200,
    });
    expect(action.kind).toBe('scroll');
    if (action.kind === 'scroll') {
      expect(action.delta_x).toBe(0);
      expect(action.delta_y).toBe(200);
    }
  });

  it('press variant', () => {
    const action = InteractActionSchema.parse({ kind: 'press', key: 'Enter' });
    expect(action).toEqual({ kind: 'press', key: 'Enter' });
  });

  it('rejects coordinate primitives (L-001 — gui_control plane only)', () => {
    expect(() => InteractActionSchema.parse({ kind: 'tap_at', x: 100, y: 100 })).toThrow();
    expect(() => InteractActionSchema.parse({ kind: 'type_focused', text: 'x' })).toThrow();
  });

  it('InteractRequest serialises action + optional timeout', () => {
    const req = InteractRequestSchema.parse({
      action: { kind: 'tap', selector: '#go' },
      timeout_ms: 5000,
    });
    expect(JSON.parse(JSON.stringify(req))).toEqual({
      action: { kind: 'tap', selector: '#go' },
      timeout_ms: 5000,
    });
  });
});

describe('WaitCondition wire shape', () => {
  it('selector variant', () => {
    expect(WaitConditionSchema.parse({ kind: 'selector', selector: '#ready' })).toEqual({
      kind: 'selector',
      selector: '#ready',
    });
  });

  it('selector_hidden variant', () => {
    expect(WaitConditionSchema.parse({ kind: 'selector_hidden', selector: '#spinner' })).toEqual({
      kind: 'selector_hidden',
      selector: '#spinner',
    });
  });

  it('url_matches variant', () => {
    expect(
      WaitConditionSchema.parse({ kind: 'url_matches', pattern: 'https://.*\\.example\\.com' }),
    ).toEqual({ kind: 'url_matches', pattern: 'https://.*\\.example\\.com' });
  });

  it('time variant uses kind="time" not "time_ms"', () => {
    // This is the bug Go shipped in 0.1.0–0.1.1: `kind: "time_ms"`
    // would parse against a now-removed schema variant. Pin the
    // canonical name here so any drift fails fast.
    expect(WaitConditionSchema.parse({ kind: 'time', ms: 5000 })).toEqual({
      kind: 'time',
      ms: 5000,
    });
    expect(() => WaitConditionSchema.parse({ kind: 'time_ms', ms: 5000 })).toThrow();
  });

  it('WaitRequest serialises condition + optional timeout', () => {
    const req = WaitRequestSchema.parse({
      condition: { kind: 'time', ms: 1000 },
      timeout_ms: 10_000,
    });
    expect(JSON.parse(JSON.stringify(req))).toEqual({
      condition: { kind: 'time', ms: 1000 },
      timeout_ms: 10_000,
    });
  });
});

describe('NavigateRequest wire shape', () => {
  it('full request', () => {
    const req = NavigateRequestSchema.parse({
      url: 'https://example.com',
      wait_until: 'load',
      timeout_ms: 15_000,
    });
    expect(JSON.parse(JSON.stringify(req))).toEqual({
      url: 'https://example.com',
      wait_until: 'load',
      timeout_ms: 15_000,
    });
  });
});
