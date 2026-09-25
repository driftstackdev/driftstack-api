// Owner item 3 (2026-09-24): "Simulator view, should expand more to match
// screen, assuming we auto scale and the original resolution stays the same and
// not change with the browser, and only for local more easily viewed, should be
// make larger to match nicely with the screen. And remember previous positions
// from user to auto reopen the same kind of way."
//
// WHAT WAS THERE. T-12 remembered the window SIZE per screen (settings.json,
// `simulatorWindowSize`, keyed by the work area) — and then undid it: every fit
// capped the phone at the device's 1:1 size ("a 27-inch display does not get a
// 2x phone"), so a customer who dragged the phone larger got it shrunk back on
// the next open, and on the first video frame of every session. Nothing
// remembered WHERE the window was or on WHICH screen: the separate macOS app
// opens its first window wherever the OS puts it and cascades the rest from
// (120, 120); the in-process window opens beside the main window.
//
// WHAT THIS ADDS.
//   • Scale: the phone is a picture of the device, drawn at whatever size the
//     window is. The device's own resolution never changes — the video is
//     scaled locally and taps are mapped back through it (pointerToViewport) —
//     so the window may be larger than 1:1. A fresh open with nothing
//     remembered fills a comfortable share of the screen's height.
//   • Placement: the window's position, size and screen are remembered when the
//     customer stops moving or resizing it, and a new window reopens there —
//     when that screen is still connected. On a different set of screens it
//     falls back to the per-screen size and the default position.
//
// Everything here is pure except `loadPlacement` / `savePlacement`, which keep
// the one record in the Simulator's own store file (never settings.json, whose
// whole-object writers belong to the main window, and never the keychain).

import {
  SCREEN_EDGE_MARGIN,
  SMALL_SCREEN_HEIGHT,
  SMALL_SCREEN_SHARE,
} from './simulator-window-fit';

/** The store file the placement lives in (plugin-store; `store:default` is
 *  granted to both Simulator window capabilities). */
export const SIMULATOR_PLACEMENT_STORE_FILE = 'simulator-window.json';
const PLACEMENT_KEY = 'placement';

/** The share of a big screen's height a fresh phone takes. Small screens keep
 *  T-12's own share (SMALL_SCREEN_SHARE), which is also their ceiling. */
export const COMFORTABLE_SCREEN_SHARE = 0.88;

/** A monitor, as the placement remembers it: its name and its PHYSICAL rect
 *  on the desktop. Physical, because a desktop of mixed-DPI screens has one
 *  physical coordinate space and no single logical one. */
export interface PlacementMonitor {
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SimulatorWindowPlacement {
  v: 1;
  /** The window's outer top-left, PHYSICAL desktop px. */
  x: number;
  y: number;
  /** The phone's size, LOGICAL px: the window without any open side panel
   *  (the same phone-only convention T-12's per-screen size uses). */
  width: number;
  height: number;
  monitor: PlacementMonitor;
}

/** The slice of Tauri's `Monitor` this reads. */
export interface MonitorLike {
  name: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
  scaleFactor: number;
}

export function placementMonitorOf(m: MonitorLike): PlacementMonitor {
  return {
    name: m.name,
    x: Math.round(m.position.x),
    y: Math.round(m.position.y),
    width: Math.round(m.size.width),
    height: Math.round(m.size.height),
  };
}

function finite(...values: unknown[]): boolean {
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** A stored record, validated. Anything malformed reads as "nothing remembered". */
export function placementFrom(raw: unknown): SimulatorWindowPlacement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const m = r.monitor as Record<string, unknown> | undefined;
  if (r.v !== 1 || typeof m !== 'object' || m === null) return null;
  if (!finite(r.x, r.y, r.width, r.height, m.x, m.y, m.width, m.height)) return null;
  if ((r.width as number) <= 0 || (r.height as number) <= 0) return null;
  if ((m.width as number) <= 0 || (m.height as number) <= 0) return null;
  if (m.name !== null && typeof m.name !== 'string') return null;
  return {
    v: 1,
    x: Math.round(r.x as number),
    y: Math.round(r.y as number),
    width: Math.round(r.width as number),
    height: Math.round(r.height as number),
    monitor: {
      name: m.name,
      x: Math.round(m.x as number),
      y: Math.round(m.y as number),
      width: Math.round(m.width as number),
      height: Math.round(m.height as number),
    },
  };
}

function sameMonitor(a: PlacementMonitor, b: PlacementMonitor): boolean {
  return (
    a.name === b.name && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/**
 * The comfortable default height for a phone on a screen whose work area is
 * `availHeight` logical px tall, or null when the screen is unknown. Larger
 * than 1:1 on a big screen — that is the point (see the header).
 */
export function comfortableSimulatorHeight(availHeight: number): number | null {
  if (!(availHeight > 0)) return null;
  const share = availHeight < SMALL_SCREEN_HEIGHT ? SMALL_SCREEN_SHARE : COMFORTABLE_SCREEN_SHARE;
  return Math.min(Math.round(availHeight * share), availHeight - SCREEN_EDGE_MARGIN);
}

export interface PlacementPlan {
  /** Where to move the window's outer top-left, PHYSICAL px. */
  position: { x: number; y: number };
  /** The phone height to size to, LOGICAL px, already within the screen. */
  height: number;
  /** That screen's work-area height, LOGICAL px (for the sizing clamp). */
  availHeight: number;
}

/**
 * Where and how to reopen, from the remembered placement and the screens that
 * are connected NOW — or null when there is nothing to restore (nothing
 * remembered, or its screen is not connected).
 *
 * `windowWidthFor(height)` is the caller's own width rule (the phone's aspect
 * plus any side panel), so the clamp keeps the WHOLE window on that screen's
 * work area rather than trusting a remembered corner that might now hang off
 * it (a dock or taskbar that moved, a panel that is open this time).
 */
export function planPlacementRestore(args: {
  remembered: SimulatorWindowPlacement | null;
  monitors: readonly MonitorLike[];
  windowWidthFor: (height: number) => number;
}): PlacementPlan | null {
  const { remembered, monitors } = args;
  if (remembered === null) return null;
  const monitor = monitors.find((m) => sameMonitor(placementMonitorOf(m), remembered.monitor));
  if (monitor === undefined) return null;
  const sf = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
  const availHeight = Math.round(area.size.height / sf);
  const height = Math.max(1, Math.min(remembered.height, availHeight - SCREEN_EDGE_MARGIN));
  const outerW = Math.round(args.windowWidthFor(height) * sf);
  const outerH = Math.round(height * sf);
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
  const x = clamp(remembered.x, area.position.x, area.position.x + area.size.width - outerW);
  const y = clamp(remembered.y, area.position.y, area.position.y + area.size.height - outerH);
  return { position: { x: Math.round(x), y: Math.round(y) }, height, availHeight };
}

/**
 * Is `other` another Simulator window of the same app as `self`? The separate
 * macOS app labels its windows `main` and `sim-<session>`; the in-process
 * window (Windows, Linux) is `simulator-<session>` beside the app's own `main`.
 * A second phone must not open exactly on top of the first, so it keeps its
 * default (cascaded) position and restores only the size.
 */
export function isSiblingSimulatorWindow(self: string, other: string): boolean {
  if (other === self) return false;
  if (self.startsWith('simulator-')) return other.startsWith('simulator-');
  return other === 'main' || other.startsWith('sim-');
}

interface StoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

let storePromise: Promise<StoreLike> | null = null;
async function placementStore(): Promise<StoreLike> {
  if (storePromise === null) {
    storePromise = import('@tauri-apps/plugin-store').then(
      ({ LazyStore }) => new LazyStore(SIMULATOR_PLACEMENT_STORE_FILE) as unknown as StoreLike,
    );
  }
  return storePromise;
}

/** The remembered placement, or null (nothing remembered, or unreadable). */
export async function loadPlacement(): Promise<SimulatorWindowPlacement | null> {
  try {
    const store = await placementStore();
    return placementFrom(await store.get<unknown>(PLACEMENT_KEY));
  } catch (err) {
    console.warn('[simulator] could not read where the window was left (ignored):', err);
    return null;
  }
}

let lastSaved = '';
/** Remember the placement. Never rejects; an unchanged record is not rewritten. */
export async function savePlacement(p: SimulatorWindowPlacement): Promise<void> {
  const serialized = JSON.stringify(p);
  if (serialized === lastSaved) return;
  try {
    const store = await placementStore();
    await store.set(PLACEMENT_KEY, p);
    await store.save();
    lastSaved = serialized;
  } catch (err) {
    console.warn('[simulator] could not remember where the window was left (ignored):', err);
  }
}

/** Test seam: forget the memoised store and the last-saved record. */
export function resetPlacementStoreForTests(): void {
  storePromise = null;
  lastSaved = '';
}
