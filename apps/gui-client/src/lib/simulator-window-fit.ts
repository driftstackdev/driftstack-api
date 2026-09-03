// T-12 — "On small screens, the simulator may take almost all of the screen; we
// may want it smaller." (owner, 2026-09-03)
//
// MEASURED: `fitWindow` and `resetToActualSize` in views/SimulatorWindow.tsx each
// carried their own copy of one clamp — `if (height > avail - 24) height = avail
// - 24` — and nothing else bounded the window. On a 13" laptop (work area ≈ 875px
// tall) that is an 851px phone: the whole screen minus a hairline, with the main
// window somewhere underneath it. The two copies were hand-written and had
// already drifted once (the keyboard-in-chrome bug, #75b).
//
// One pure helper for both sites, so the rule is written once:
//   • a SMALL screen (work area shorter than SMALL_SCREEN_HEIGHT) gives the phone
//     at most SMALL_SCREEN_SHARE of the work area — and still never more than
//     `availHeight - SCREEN_EDGE_MARGIN`;
//   • a big screen keeps today's `availHeight - SCREEN_EDGE_MARGIN`;
//   • on ANY screen the phone is never drawn larger than the device at 1:1
//     (`nativeLogicalHeight`, the window height at iPhone CSS-logical size) — a
//     27" display does not get a 2× phone, it gets a life-size one.
//
// Width is not this helper's business: every caller re-derives it from the
// device aspect exactly as before, so the phone still fills the frame edge to
// edge (the letterbox guarantee the sizing sites make).

/** Work areas shorter than this are "small" — a 13"/14" laptop, not a desktop. */
export const SMALL_SCREEN_HEIGHT = 900;
/** The share of a small work area the phone may take. */
export const SMALL_SCREEN_SHARE = 0.82;
/** Breathing room kept below the window on every screen — the historical `- 24`. */
export const SCREEN_EDGE_MARGIN = 24;

/**
 * The window height the simulator may actually take.
 *
 * `desired` is the aspect-correct height the caller wants; `availHeight` is the
 * screen work area (0 or negative = unknown, and then no screen clamp applies —
 * exactly as before); `nativeLogicalHeight` is the window height at 1:1 device
 * scale and, when given, is an absolute ceiling.
 */
export function fitSimulatorHeight(args: {
  desired: number;
  availHeight: number;
  nativeLogicalHeight?: number;
}): number {
  const { desired, availHeight, nativeLogicalHeight } = args;
  let cap = Number.POSITIVE_INFINITY;
  if (availHeight > 0) {
    cap = availHeight - SCREEN_EDGE_MARGIN;
    if (availHeight < SMALL_SCREEN_HEIGHT) {
      cap = Math.min(cap, Math.round(availHeight * SMALL_SCREEN_SHARE));
    }
  }
  if (nativeLogicalHeight !== undefined && nativeLogicalHeight > 0) {
    cap = Math.min(cap, nativeLogicalHeight);
  }
  return Math.min(desired, cap);
}

/** A window size in logical px — the shape remembered per screen in settings. */
export interface SimulatorWindowSize {
  width: number;
  height: number;
}

/**
 * Which screen a remembered size belongs to.
 *
 * Keyed by the work area's logical size (`availWidth`×`availHeight`) rather than
 * a monitor name: it is what BOTH ends can read — the simulator window when it
 * remembers a size, and the main window when it opens one — and a monitor that
 * changes resolution is, for sizing purposes, a different screen. jsdom, a
 * headless preview, or a window with no `screen` at all report 0×0 → `null`, and
 * nothing is remembered or read.
 */
export function simulatorScreenKey(
  screen: { availWidth?: number; availHeight?: number } | null | undefined,
): string | null {
  const w = screen?.availWidth;
  const h = screen?.availHeight;
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${Math.round(w).toString()}x${Math.round(h).toString()}`;
}

/**
 * The size to open the window at: the remembered size for this screen when it
 * is usable, else the default. A remembered size below the window's minimum (a
 * hand-edited store, or one written by a build with a different minimum) is not
 * "the size the customer chose" — it is ignored rather than clamped, so the
 * window opens at a size that was designed rather than one that was invented.
 */
export function initialSimulatorSize(args: {
  remembered: SimulatorWindowSize | null | undefined;
  fallback: SimulatorWindowSize;
  min: SimulatorWindowSize;
}): SimulatorWindowSize {
  const { remembered, fallback, min } = args;
  if (remembered === null || remembered === undefined) return fallback;
  if (!Number.isFinite(remembered.width) || !Number.isFinite(remembered.height)) return fallback;
  if (remembered.width < min.width || remembered.height < min.height) return fallback;
  return { width: Math.round(remembered.width), height: Math.round(remembered.height) };
}
