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
