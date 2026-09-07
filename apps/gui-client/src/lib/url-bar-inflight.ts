/**
 * Pure helpers for the address-bar "navigation in flight" state.
 *
 * Owner item T-10: "URL Bar not always updating to new website. Especially when
 * proxy slow, it's very annoying." MEASURED: the address bar (liveUrl) is derived
 * from the active tab's stored url, which is written ONLY by a box-confirmed
 * page_state (a data-channel frame or the ~2s poll). An address-bar navigate is
 * optimistic (the GUI sets the url immediately because it typed it). But a TAPPED
 * link or a redirect is NOT — the GUI cannot know a tap's destination — so on a slow
 * proxy the bar keeps showing the OLD url until the box's first page_state arrives,
 * seconds later, with nothing on screen saying work is happening.
 *
 * This models that WAIT explicitly: after a forwarded tap, if no page_state confirms
 * within a short window, the bar shows a loading treatment over the (dimmed, never
 * fabricated) stale url; the first page_state for that tab clears it. It NEVER
 * invents a destination, because the GUI does not know it.
 *
 * T-23 — the TYPED half of the same report ("the URL in our simulator doesn't show the
 * new URL … but still the old one for a while"). MEASURED: the typed navigate IS
 * optimistic (the bar shows the target at once), but the ~2s page-state poll — and any
 * data-channel frame — still describes the page the box is CURRENTLY on until the new
 * load commits. Those frames carry the PRE-navigation url and were written straight
 * into the tab, so within ~2s the bar reverted to the old address and stayed there
 * until the box's `loading` frame for the new url landed. The policy is now: while a
 * GUI-initiated navigation is pending on a tab, a frame for that tab whose url is the
 * pre-navigation url is HELD (it is provably stale — the GUI knows where it asked the
 * box to go and that this is not it); anything that shows the box moved (the target,
 * a redirect, an error) or the ceiling resolves the pending navigation and the bar
 * follows the box again. See `judgePendingNavigationFrame`.
 *
 * Kept OUT of SimulatorWindow.tsx (a ~9k-line file mocked by ~17 suites with
 * hand-listed factories) so the constants + predicates are unit-testable on their own
 * and a new SimulatorWindow export can't break those mocks.
 */

/**
 * How long to wait after a forwarded tap before the bar admits it is in flight. Short
 * enough to feel responsive on a slow proxy, long enough that a fast local page_state
 * (a tap whose destination the box confirms immediately) never flashes the indicator.
 */
export const URL_BAR_INFLIGHT_ARM_MS = 300;

/**
 * Hard ceiling: clear the in-flight treatment even if NO page_state ever arrives, so a
 * tap that did not navigate (or one whose confirming frame was dropped) can never spin
 * forever.
 */
export const URL_BAR_INFLIGHT_CEILING_MS = 20_000;

/**
 * A box page_state that RESOLVES an in-flight tap-navigation: the box has committed to
 * (loading), finished (loaded), or failed (errored / stalled) a page for the tab, so
 * the wait is over. `capture_stalled` is deliberately EXCLUDED — it reports that the
 * VIDEO capture died, not that a navigation resolved, so it must not clear a still
 * pending page load's indicator.
 */
export function pageStateResolvesInFlight(state: string | null | undefined): boolean {
  return state === 'loading' || state === 'loaded' || state === 'errored' || state === 'stalled';
}

/**
 * T-23 — a navigation the GUI itself issued (typed address / Retry) that the box has
 * not yet confirmed. Set at navigate time, cleared by `judgePendingNavigationFrame`
 * returning 'resolve' (or by whatever supersedes the navigation: a tab switch, a
 * history step, a new session, a failed send).
 */
export interface PendingNavigation {
  /** The requested destination, in the same normalized form as the nav-target ref. */
  target: string;
  /**
   * The tab's box-confirmed url when the navigate was issued — the url a stale frame
   * will carry. A re-navigate while one is already pending keeps THIS value rather
   * than the optimistic url of the superseded request: the box is still on the page it
   * was on, and that is the url that must be recognised as stale.
   */
  fromUrl: string;
  /** The tab the navigation was issued on; frames for other tabs are never held. */
  tabId: string;
  /** `Date.now()` at issue; the ceiling is measured from here. */
  startedAt: number;
}

/**
 * What a page-state frame (poll OR data channel) may do to a tab's stored url/title
 * while a GUI-initiated navigation is pending on it.
 *
 *   'pass'    — nothing pending for this tab (or no url to judge): write as usual.
 *   'hold'    — the frame carries the PRE-navigation url: it describes the page the
 *               box is still on, not where it was sent, so it must not overwrite the
 *               optimistic target (the T-23 revert). The navigation stays pending.
 *   'resolve' — the frame shows the box moved (the target in any state, a `loading`
 *               for some OTHER url = a redirect the bar should show, an error), or the
 *               ceiling has passed: write as usual and forget the pending navigation.
 *
 * The hold is deliberately narrow — ONLY the pre-navigation url is refused. A frame
 * for a third url is real information about where the box is and passes through, so
 * the bar can never be pinned to a destination the box demonstrably left. The ceiling
 * reuses URL_BAR_INFLIGHT_CEILING_MS: after it, a box that never confirmed anything
 * gets its old url back rather than the bar lying indefinitely.
 */
export type PendingNavigationVerdict = 'pass' | 'hold' | 'resolve';

export function judgePendingNavigationFrame(
  pending: PendingNavigation | null,
  frame: { tabId: string; url: unknown; state: unknown },
  now: number,
  normalize: (url: unknown) => string,
): PendingNavigationVerdict {
  if (pending === null) return 'pass';
  if (frame.tabId !== pending.tabId) return 'pass';
  if (now - pending.startedAt >= URL_BAR_INFLIGHT_CEILING_MS) return 'resolve';
  if (frame.state === 'errored') return 'resolve';
  const url = typeof frame.url === 'string' ? frame.url : '';
  // A url-less (title-only) frame carries nothing the hold is about.
  if (url === '') return 'pass';
  const norm = normalize(url);
  // Target first: a Reload re-navigates to the page the box is already on, so the
  // target and the pre-navigation url coincide — that frame confirms, never stalls.
  if (norm === pending.target) return 'resolve';
  if (url === pending.fromUrl || norm === normalize(pending.fromUrl)) return 'hold';
  return 'resolve';
}
