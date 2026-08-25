// V-1611 #13 — reopening a chat used to abandon a session that was still
// running: a second session would be created against the same profile while the
// first kept its device. These arms pin the DECISION to reattach, which is the
// half that can be wrong silently.
import { describe, it, expect } from 'vitest';
import { adoptionOutcome } from '../../src/lib/use-agent-chat';

describe('adoptionOutcome', () => {
  it('reattaches a chat whose session is still active', () => {
    expect(adoptionOutcome('active', false)).toBe('adopt');
  });

  it('refuses a paused session — resume cannot rescue it', () => {
    // The server rejects a non-active resume with 409, so there is no retry to
    // fall back on. Documented in D-7's sibling finding.
    expect(adoptionOutcome('paused', false)).toBe('not-active');
  });

  it('refuses a closed session', () => {
    expect(adoptionOutcome('closed', false)).toBe('not-active');
  });

  it('DISCARDS a stale answer even when it says active', () => {
    // The dangerous one. A GET issued for chat A can land after the customer
    // opened chat C; adopting then binds C's view to A's server session. The
    // staleness check must therefore outrank the status check, not follow it.
    expect(adoptionOutcome('active', true)).toBe('stale');
  });

  it('discards a stale answer for every status, not just active', () => {
    for (const s of ['active', 'paused', 'closed'] as const) {
      expect(adoptionOutcome(s, true), s).toBe('stale');
    }
  });

  it('never returns adopt for anything but an active, current session', () => {
    // Exhaustive over the real status union × the staleness axis, so a new
    // status member cannot quietly acquire adoption rights.
    const all = (['active', 'paused', 'closed'] as const).flatMap((s) =>
      [true, false].map((moved) => ({ s, moved, out: adoptionOutcome(s, moved) })),
    );
    const adopting = all.filter((r) => r.out === 'adopt');
    expect(adopting).toEqual([{ s: 'active', moved: false, out: 'adopt' }]);
  });
});
