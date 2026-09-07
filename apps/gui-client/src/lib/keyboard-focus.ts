// T-25 (owner: the on-screen keyboard should auto-open on text-input focus).
//
// The single decision the GUI makes when a page-state frame reports the box's
// editable-input focus. TWO paths carry that frame — the LiveKit data-channel
// handler and the ~2s control-plane page-state poll — and they MUST apply it
// with identical authority/grace/suppression rules, or the keyboard behaves
// differently depending on which transport happened to deliver the frame. This
// helper is the one place that decision lives, so the two paths cannot drift.
//
// It is deliberately pure (no React, no refs): the caller resolves the tab
// target and the manual-input authority, then hands the result here along with
// a small actuator the caller wires to its own keyboard state. That keeps the
// rule unit-testable without a rendered window, and keeps the actuation (which
// refs a specific path mutates) at the call site.

/** The focus-carrying slice of a page-state frame, from either transport. */
export interface KeyboardFocusFrame {
  /** The box's editable-input focus: true on focus, false on blur. A frame that
   *  omits it (undefined/null, or a non-boolean) is a no-op — the keyboard's
   *  current visibility is left exactly as it was. */
  inputFocused?: boolean | null;
  /** The tab the frame is attributed to. Absent/null marks a legacy (tabId-less)
   *  frame, which is only trusted for focus outside the post-switch grace. */
  tabId?: string | null;
}

/** Everything the caller has already resolved for this frame. */
export interface KeyboardFocusContext {
  /** resolvePageStateTabTarget(...) — the tab this frame owns, or null if it
   *  owns none of this window's tabs (then it is never authoritative for focus). */
  targetId: string | null;
  /** The active tab; focus is authoritative only for the ACTIVE tab. */
  activeTabId: string;
  /** The manual-input authority check for this frame's session/room/epoch. This
   *  is ALSO the AI-mode gate: it is false whenever the session is not in
   *  confirmed manual mode, so agent-owned focus never raises the keyboard. */
  hasManualAuthority: boolean;
  /** True when Date.now() - lastSwitchAt < PAGE_STATE_GRACE_MS: a tabId-less
   *  frame this soon after a switch is still describing the tab we left. */
  withinSwitchGrace: boolean;
}

/** The caller-supplied keyboard state this helper reads + drives. `setVisible`
 *  is expected to update both the live ref mirror(s) and the React state so the
 *  two transports observe the same value synchronously. */
export interface KeyboardFocusActuator {
  /** The tab whose auto-show is currently suppressed (a warm tab that kept DOM
   *  focus in the background, or a tab the operator explicitly hid), or null. */
  getSuppressedTab(): string | null;
  setSuppressedTab(tab: string | null): void;
  setVisible(visible: boolean): void;
}

/**
 * Apply a frame's editable-input focus to the keyboard, or do nothing.
 *
 * A frame is authoritative for focus only when it carries a boolean
 * `inputFocused`, the caller owns manual-input authority (which excludes AI
 * mode), AND it targets the ACTIVE tab outside the tabId-less switch grace. A
 * `false` clears any suppression on the active tab and hides the keyboard; a
 * `true` shows it unless the active tab's auto-show is suppressed (a returning
 * warm tab, or an explicit manual Hide) — a fresh blur→focus edge is what lifts
 * that suppression. Anything else leaves the keyboard untouched.
 */
export function applyInputFocusFromPageState(
  frame: KeyboardFocusFrame,
  ctx: KeyboardFocusContext,
  actuator: KeyboardFocusActuator,
): void {
  // A frame without the field is a no-op — never a synthesized blur/focus.
  if (typeof frame.inputFocused !== 'boolean') return;
  // Non-owner / AI-mode / revoked authority: agent focus must not raise it.
  if (!ctx.hasManualAuthority) return;
  const isLegacyTablessFrame = frame.tabId === undefined || frame.tabId === null;
  const inTablessSwitchGrace = isLegacyTablessFrame && ctx.withinSwitchGrace;
  const focusIsAuthoritative = ctx.targetId === ctx.activeTabId && !inTablessSwitchGrace;
  if (!focusIsAuthoritative) return;
  if (frame.inputFocused === false) {
    if (actuator.getSuppressedTab() === ctx.activeTabId) actuator.setSuppressedTab(null);
    actuator.setVisible(false);
  } else if (actuator.getSuppressedTab() !== ctx.activeTabId) {
    actuator.setVisible(true);
  }
}
