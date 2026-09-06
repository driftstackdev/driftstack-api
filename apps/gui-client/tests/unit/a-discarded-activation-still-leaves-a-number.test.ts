// P-26 — a tab switch that gives up must still leave a number, and the record
// that makes that possible must not grow without limit.
//
// This is a BEHAVIOUR test, deliberately, because its sibling
// (`a-tab-switch-leaves-its-latency-in-the-dev-log`) is a source-text guard and
// says so: the ack handler sits 5,000 lines into a 9,000-line component whose
// render needs a live Room. Source pins stay green against unreachable code —
// which is exactly how the `hold-expired` branch shipped with a classification
// arm that could never be taken. The bounded tombstone was pulled into its own
// module so the part that CAN be executed is executed here.
//
// The retention rule is not arbitrary. A wedged session re-issues activations
// without ever acking, so an unbounded tombstone map is a leak that grows for as
// long as the customer keeps trying — an instrument that makes the freeze it was
// added to measure slightly worse.

import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVATION_TOMBSTONES,
  rememberDiscardedActivation,
  type DiscardedActivation,
} from '../../src/lib/activation-tombstones';

function tomb(n: number): DiscardedActivation {
  return { tabId: `tab_${n}`, startedAt: n * 1000, attempts: 3, ackSeen: false };
}

describe('P-26 — a discarded activation still leaves a number', () => {
  it('CRITICAL keeps what a late ack needs: the tab and when the switch began', () => {
    const map = new Map<string, DiscardedActivation>();
    rememberDiscardedActivation(map, 'req_1', {
      tabId: 'tab_a',
      startedAt: 1_000,
      attempts: 3,
      ackSeen: false,
    });
    const kept = map.get('req_1');
    expect(kept).toBeDefined();
    // The 102,431 ms ack A3 measured on the fleet box is exactly this subtraction.
    expect(103_431 - (kept as DiscardedActivation).startedAt - 0).toBe(102_431);
    expect((kept as DiscardedActivation).tabId).toBe('tab_a');
    expect((kept as DiscardedActivation).attempts).toBe(3);
  });

  it('CRITICAL is bounded — a session that never acks cannot grow it without limit', () => {
    const map = new Map<string, DiscardedActivation>();
    for (let i = 0; i < MAX_ACTIVATION_TOMBSTONES * 3; i += 1) {
      rememberDiscardedActivation(map, `req_${i}`, tomb(i));
    }
    expect(map.size).toBe(MAX_ACTIVATION_TOMBSTONES);
  });

  it('evicts oldest-first, so the most recent switches are the ones still measurable', () => {
    const map = new Map<string, DiscardedActivation>();
    for (let i = 0; i < MAX_ACTIVATION_TOMBSTONES + 2; i += 1) {
      rememberDiscardedActivation(map, `req_${i}`, tomb(i));
    }
    expect(map.has('req_0')).toBe(false);
    expect(map.has('req_1')).toBe(false);
    expect(map.has('req_2')).toBe(true);
    expect(map.has(`req_${MAX_ACTIVATION_TOMBSTONES + 1}`)).toBe(true);
  });

  it('re-writing a key refreshes it rather than leaving it queued for eviction', () => {
    const map = new Map<string, DiscardedActivation>();
    rememberDiscardedActivation(map, 'req_keep', tomb(0));
    for (let i = 1; i < MAX_ACTIVATION_TOMBSTONES; i += 1) {
      rememberDiscardedActivation(map, `req_${i}`, tomb(i));
    }
    // Touch it again: it is now the newest thing we know, not the oldest.
    rememberDiscardedActivation(map, 'req_keep', tomb(999));
    rememberDiscardedActivation(map, 'req_overflow', tomb(1000));
    expect(map.size).toBe(MAX_ACTIVATION_TOMBSTONES);
    expect(map.has('req_keep')).toBe(true);
    expect(map.get('req_keep')?.startedAt).toBe(999_000);
    // The oldest untouched entry went instead.
    expect(map.has('req_1')).toBe(false);
  });

  it('vacuity control — an UNBOUNDED implementation of the same shape fails the bound arm', () => {
    // Proves the bound arm measures the bound and not "a Map is small". Same
    // writes, no eviction: the size must diverge.
    const naive = new Map<string, DiscardedActivation>();
    for (let i = 0; i < MAX_ACTIVATION_TOMBSTONES * 3; i += 1) naive.set(`req_${i}`, tomb(i));
    expect(naive.size).toBe(MAX_ACTIVATION_TOMBSTONES * 3);
    expect(naive.size).toBeGreaterThan(MAX_ACTIVATION_TOMBSTONES);
  });
});
