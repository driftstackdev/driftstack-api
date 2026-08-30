// LK.6.e — synthetic-ping RTT measurement over the LiveKit
// DataChannel. The gui-client sends a `ping` InputEvent at
// LIVEKIT_PING_INTERVAL_MS cadence; Agent 1's harness-side
// RoomDataDispatcher + LatencyCollector echoes it back as a
// `ping` DataReceived event. gui-client measures the round-trip
// and exposes it via a React hook.
//
// Display: dev mode only (the v1.0 production UI doesn't surface
// latency; ops infra has it via the LK Server's own metrics).
// The hook is hooked into a small footer overlay component that
// reads `import.meta.env.DEV` to gate rendering.

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react';
import { RoomEvent, sendInputEvent, type Room } from './livekit';
import { noteRoomRtt } from './livekit-input-ack';

/** Send a ping every 2s. Tight enough that a customer with eyes
 *  on the panel sees fresh numbers; loose enough that the ping
 *  stream doesn't congest the DataChannel under load. */
export const LIVEKIT_PING_INTERVAL_MS = 2000;

/** RTT samples older than this are discarded — the displayed
 *  number always reflects the "last 6 seconds" of liveness. */
export const LIVEKIT_PING_FRESH_WINDOW_MS = 6000;

/** How often the staleness sweep runs to expire a stuck RTT once echoes
 *  stop landing. 1s is tight enough that a frozen/dead link drops the
 *  badge to "measuring…" within ~a second of the freshness window lapsing. */
export const LIVEKIT_PING_STALE_SWEEP_MS = 1000;

export interface UseLatencyPingOpts {
  room: Room | null;
  /** Disable the ping loop (e.g. when the room is disconnected
   *  OR the customer has expanded the panel into a screensaver-
   *  style fullscreen where we don't want to consume bandwidth). */
  enabled: boolean;
}

export interface LatencyState {
  /** Most-recent RTT in ms; null when no fresh sample exists. */
  rttMs: number | null;
  /** Timestamp of the last received echo (Date.now()). */
  lastSeenAt: number | null;
}

export function useLatencyPing(opts: UseLatencyPingOpts): LatencyState {
  // Destructure to primitives so the effect depends on the actual room / enabled
  // VALUES, not the opts OBJECT. A caller passing an inline `{ room, enabled }`
  // (the natural usage) makes `opts` a fresh reference every render; with a
  // `[opts]` dep the effect would tear down + re-arm the ping loop AND fire an
  // immediate ping on EVERY parent re-render — and the session panel re-renders
  // frequently while streaming, so that's a DataChannel ping flood (exactly what
  // the 2s interval is meant to avoid). Depending on the primitives re-runs the
  // effect only on a real room/enabled change.
  const { room, enabled } = opts;
  const [state, setState] = useState<LatencyState>({ rttMs: null, lastSeenAt: null });

  useEffect(() => {
    // audit wb1w3015f — drop the reading on EVERY room/enabled change (mirrors
    // useConnectionStats' setStats(EMPTY)). A freeze-recovery rebuild or manual
    // Reconnect swaps in a NEW Room; without this the badge + Copy-diagnostics kept
    // showing the DEAD room's RTT (e.g. a healthy '80ms') until the 6s staleness
    // sweep expired it — a stuck healthy number that actively lies in a bug report.
    if (room !== null) noteRoomRtt(room, null);
    setState({ rttMs: null, lastSeenAt: null });
    if (room === null || !enabled) return;

    let cancelled = false;

    // Track outstanding ping timestamps in a Map so out-of-order
    // echoes still resolve. Cardinality is bounded by the polling
    // interval and the freshness window.
    const outstanding = new Map<number, true>();

    const onData = (payload: Uint8Array): void => {
      if (cancelled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return; // non-JSON data event — ignore (e.g. binary harness msg)
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { type?: unknown }).type !== 'ping' ||
        typeof (parsed as { timestamp?: unknown }).timestamp !== 'number'
      ) {
        return;
      }
      const ts = (parsed as { timestamp: number }).timestamp;
      if (!outstanding.has(ts)) return; // stray echo — ignore
      outstanding.delete(ts);
      const rttMs = Date.now() - ts;
      // Drop stale samples (the harness was slow / network-jittered).
      if (rttMs > LIVEKIT_PING_FRESH_WINDOW_MS) return;
      // The receipt deadline reads the same measurement the badge shows, so a
      // slow link widens the ack budget instead of accusing the device.
      if (room !== null) noteRoomRtt(room, rttMs);
      setState({ rttMs, lastSeenAt: Date.now() });
    };

    (room as any).on(RoomEvent.DataReceived, onData);

    const sendPing = (): void => {
      if (cancelled) return;
      const timestamp = Date.now();
      outstanding.set(timestamp, true);
      // Garbage-collect outstanding entries older than the
      // freshness window — they're never going to land.
      for (const ts of outstanding.keys()) {
        if (timestamp - ts > LIVEKIT_PING_FRESH_WINDOW_MS) outstanding.delete(ts);
      }
      // Fire-and-forget, but .catch the publish: a ping that lands after the
      // room/engine is torn down (window close, unmount, connect/disconnect race)
      // rejects with "PC manager is closed". sendInputEvent already swallows
      // benign teardown errors, but keep an explicit guard here so NOTHING from
      // this loop can ever reach the global unhandledrejection handler.
      // Promise.resolve(...) wraps the call so .catch is safe even if a caller/
      // mock returns a non-Promise.
      void Promise.resolve(
        sendInputEvent(room, { type: 'ping', timestamp }, { reliable: false }),
      ).catch(() => undefined);
    };

    // Fire one immediately + every LIVEKIT_PING_INTERVAL_MS after.
    sendPing();
    const handle = setInterval(sendPing, LIVEKIT_PING_INTERVAL_MS);

    // Staleness sweep: the room object persists through a degraded /
    // reconnecting / frozen link, so when echoes stop coming back the last
    // good rttMs would otherwise stay pinned forever — the founder uses this
    // badge to spot "why did the session freeze", so a stuck healthy number
    // actively lies (and bakes into Copy-diagnostics). Expire it using the
    // already-tracked lastSeenAt: once the last echo is older than the
    // freshness window, null rttMs so the badge reads "measuring…" again.
    // Keep lastSeenAt so consumers still know WHEN the link last echoed.
    const sweep = (): void => {
      if (cancelled) return;
      // A stale sample stops being evidence of link quality; the deadline goes
      // back to the flat budget rather than holding a lucky old number.
      if (room !== null) noteRoomRtt(room, null);
      setState((prev) => {
        if (prev.rttMs === null || prev.lastSeenAt === null) return prev;
        if (Date.now() - prev.lastSeenAt <= LIVEKIT_PING_FRESH_WINDOW_MS) return prev;
        return { rttMs: null, lastSeenAt: prev.lastSeenAt };
      });
    };
    const sweepHandle = setInterval(sweep, LIVEKIT_PING_STALE_SWEEP_MS);

    return () => {
      cancelled = true;
      clearInterval(handle);
      clearInterval(sweepHandle);
      (room as any).off?.(RoomEvent.DataReceived, onData);
    };
  }, [room, enabled]);

  return state;
}

/** Format an RTT in ms for the dev-mode chrome. Returns a stable
 *  string the badge can render. */
export function formatRtt(state: LatencyState): string {
  if (state.rttMs === null) return '— ms';
  return `${state.rttMs.toString()} ms`;
}
