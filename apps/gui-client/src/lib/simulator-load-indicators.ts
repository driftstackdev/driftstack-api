// Owner item 2 (2026-09-24): "Simulator page load usually stays at like 85%
// loading, even tho page is already fully loaded. URL scrolling thing goes with
// it when scrolling down, keep spinning."
//
// Two indicators, two root causes, one rule: a load indicator starts only on
// evidence that a load started, and scrolling is never that evidence.
//
// 1. THE LOAD BAR (BrowserBar's trickle, which creeps toward 90% while
//    `pageLoading` is true and snaps to 100% when it clears). The phone reports
//    its page state twice: pushed live over the data channel, and — through the
//    server — as a stored copy the window POLLS every 2 s. The stored copy lags
//    badly: the phone forwards its page-state frames to the server only when the
//    server next talks to it, which during manual browsing can be never, and the
//    server keeps serving whatever it last received for up to two minutes. So
//    right after the live channel said `loaded`, the poll kept replaying the
//    page's old `loading`, and every replay re-armed the bar — which restarted
//    its trickle and parked it just under 90%, over a page that had finished.
//    On a page that rewrites its address as you scroll (a feed, a long article),
//    the replayed `loading` even looked like a NEW page, so scrolling restarted
//    the bar outright.
//
//    Rule: once the live channel is connected and has reported page state for
//    this session, it alone may START a load. The poll may still END one (a
//    `loaded` it carries is never wrong about a load being over), and it stays
//    the only source while the live channel is down or has said nothing yet.
//
// 2. THE ADDRESS-BAR SPINNER (T-10's "a tapped link may be navigating"). It was
//    armed on every pointer DOWN on the phone — the first half of a scroll just
//    as much as of a tap — and then held for up to 20 s waiting for a page state
//    that a scroll never produces. So every scroll lit it and it kept spinning.
//
//    Rule: a press that moves beyond the tap slop is a scroll, and cancels the
//    spinner. And a tap that navigates is confirmed quickly — the phone reports
//    `loading` the moment a navigation starts, before the proxy sends a byte —
//    so the spinner gives up after a few seconds rather than twenty.

/**
 * How far (CSS px) a press may travel and still be a tap. Mirrors the input
 * capture's MOVE_DEADZONE (lib/livekit-input-capture.ts, 14 video-px, which sits
 * just above the phone's own 10-px tap slop): past this the wire starts sending
 * the finger's movement, and the phone scrolls instead of tapping.
 */
export const TAP_SLOP_PX = 14;

/**
 * How long after a tap the address bar keeps its "a page may be loading"
 * spinner without any page state from the phone. The phone reports `loading`
 * when a navigation STARTS, so a tapped link confirms within a second or so
 * even on a slow proxy; a tap that hits a button, a field or nothing never
 * reports anything, and must not spin for long.
 */
export const TAP_NAVIGATION_CONFIRM_MS = 5_000;

/** True once a press has moved far enough to be a scroll, not a tap. */
export function pressBecameADrag(
  origin: { x: number; y: number },
  point: { x: number; y: number },
): boolean {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX;
}

/**
 * May a POLLED `loading` start (or restart) the load bar?
 *
 * Only while the live channel is not the authority: it is not connected, or it
 * has not reported page state for this session yet. Otherwise the poll is a
 * replay of a stored frame the live channel has already superseded.
 */
export function polledLoadingMayStartALoad(live: {
  connected: boolean;
  hasReportedPageState: boolean;
}): boolean {
  return !(live.connected && live.hasReportedPageState);
}

/**
 * A page-state `stalled` is two different reports. A load that took too long
 * carries `error.kind: 'timeout'` — the soft "taking longer to load" advisory,
 * the page is not frozen. A frozen renderer carries no such error — the "page
 * unresponsive" badge. ONE rule for both page-state paths (the live channel and
 * the 2 s poll): the poll used to raise "unresponsive" for any `stalled`, which
 * the phone's load-timeout terminal would have turned into a two-minute false
 * alarm on every slow page.
 */
export function isLoadTimeoutStall(state: unknown, error: unknown): boolean {
  if (state !== 'stalled') return false;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { kind?: unknown }).kind === 'timeout';
}

/** A `stalled` that means the page's renderer is frozen (see isLoadTimeoutStall). */
export function isFreezeStall(state: unknown, error: unknown): boolean {
  return state === 'stalled' && !isLoadTimeoutStall(state, error);
}
