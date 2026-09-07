// T-25 (owner: the on-screen keyboard should auto-open on text-input focus).
//
// Unit test for the shared decision the two page-state transports (the LiveKit
// data channel and the ~2s control-plane poll) both apply through
// applyInputFocusFromPageState. The whole reason the helper exists is that the
// two paths must NOT drift — so this pins the decision itself, independent of a
// rendered window.

import { describe, expect, it } from 'vitest';
import {
  applyInputFocusFromPageState,
  type KeyboardFocusActuator,
  type KeyboardFocusContext,
  type KeyboardFocusFrame,
} from '../../src/lib/keyboard-focus';

const ACTIVE = 'tab_active';

/** A recording actuator: captures every setVisible/setSuppressedTab call so a
 *  test can assert the keyboard was (or was not) driven, seeded with a starting
 *  suppression + a starting visibility. */
function makeActuator(
  suppressed: string | null = null,
): KeyboardFocusActuator & { visibleCalls: boolean[]; suppressed: string | null } {
  const rec = {
    suppressed,
    visibleCalls: [] as boolean[],
    getSuppressedTab: () => rec.suppressed,
    setSuppressedTab: (t: string | null) => {
      rec.suppressed = t;
    },
    setVisible: (v: boolean) => {
      rec.visibleCalls.push(v);
    },
  };
  return rec;
}

/** A frame + context for the ACTIVE tab, owning authority, outside grace, not
 *  suppressed — the "everything is authoritative" baseline; each test overrides
 *  exactly the field it is about. */
function ctx(over: Partial<KeyboardFocusContext> = {}): KeyboardFocusContext {
  return {
    targetId: ACTIVE,
    activeTabId: ACTIVE,
    hasManualAuthority: true,
    withinSwitchGrace: false,
    ...over,
  };
}
function frame(over: Partial<KeyboardFocusFrame> = {}): KeyboardFocusFrame {
  return { inputFocused: true, tabId: ACTIVE, ...over };
}

describe('applyInputFocusFromPageState (T-25 shared keyboard-focus decision)', () => {
  it('opens the keyboard on a focus frame for the active tab', () => {
    const a = makeActuator();
    applyInputFocusFromPageState(frame({ inputFocused: true }), ctx(), a);
    expect(a.visibleCalls).toEqual([true]);
  });

  it('closes the keyboard on a blur frame for the active tab (and clears its suppression)', () => {
    const a = makeActuator(ACTIVE);
    applyInputFocusFromPageState(frame({ inputFocused: false }), ctx(), a);
    expect(a.visibleCalls).toEqual([false]);
    expect(a.suppressed).toBeNull();
  });

  // VACUITY CONTROL — a frame that carries no input_focused must leave the
  // keyboard untouched. If this fired setVisible, "no field = no-op" would be false.
  it('is a no-op for a frame without input_focused (vacuity control)', () => {
    const a = makeActuator();
    applyInputFocusFromPageState(frame({ inputFocused: undefined }), ctx(), a);
    applyInputFocusFromPageState(frame({ inputFocused: null }), ctx(), a);
    expect(a.visibleCalls).toEqual([]);
  });

  it('is a no-op for a non-active / stale tab target (foreground-focus fence)', () => {
    const a = makeActuator();
    applyInputFocusFromPageState(frame({ inputFocused: true }), ctx({ targetId: 'tab_other' }), a);
    // targetId null (unknown renderer, fenced out) is inert the same way.
    applyInputFocusFromPageState(frame({ inputFocused: true }), ctx({ targetId: null }), a);
    expect(a.visibleCalls).toEqual([]);
  });

  it('is a no-op without manual-input authority (AI-mode / non-owner gate)', () => {
    const a = makeActuator();
    applyInputFocusFromPageState(
      frame({ inputFocused: true }),
      ctx({ hasManualAuthority: false }),
      a,
    );
    expect(a.visibleCalls).toEqual([]);
  });

  it('ignores a legacy tabId-less frame inside the post-switch grace, then trusts it after', () => {
    const a = makeActuator();
    // tabId-less (undefined) + within grace → not authoritative for focus.
    applyInputFocusFromPageState(
      frame({ inputFocused: true, tabId: undefined }),
      ctx({ withinSwitchGrace: true }),
      a,
    );
    expect(a.visibleCalls).toEqual([]);
    // Same frame outside the grace is trusted (legacy fallback still works).
    applyInputFocusFromPageState(
      frame({ inputFocused: true, tabId: undefined }),
      ctx({ withinSwitchGrace: false }),
      a,
    );
    expect(a.visibleCalls).toEqual([true]);
  });

  it('does not re-open the keyboard while the active tab is suppressed (manual Hide / warm return)', () => {
    const a = makeActuator(ACTIVE);
    applyInputFocusFromPageState(frame({ inputFocused: true }), ctx(), a);
    expect(a.visibleCalls).toEqual([]);
  });
});
