// How long a MEASURED proxy reading may speak in the present tense — derived
// from how often anything re-measures it, never hand-typed.
//
// ⛔ WHY THIS MODULE EXISTS (the owner, 2026-09-17: "sometimes a proxy was green
// on quic, and later not green box … Has QUIC and Apple, but it aint green
// sometimes"). Three windows said thirty minutes and the only thing that re-takes
// those readings unasked runs every six hours. A HEALTHY proxy whose QUIC and
// stack readings are TRUE was therefore green for 30 of every ~360 minutes — about
// 8% of the time — and muted for the rest, through no fault of the proxy. Measured
// in production on 2026-09-17: six proxies held a live-session HTTP/3 reading and
// NONE was under thirty minutes old; eight held a device reading that would have
// rendered green and ONE was.
//
// THE INVARIANT, stated once here and enforced by
// `tests/unit/a-display-window-outlasts-the-refresh-that-feeds-it.test.ts`:
//
//     W  >=  C + S
//
//   W = the DISPLAY window — how long a reading renders in the present tense.
//   C = the REFRESH cadence — how old a reading may get before anything re-takes it.
//   S = one scheduler slack — the re-take is planned by a sweep that only wakes
//       every `SWEEP_INTERVAL_MS`, so a reading that crosses C at the wrong moment
//       waits a whole slot before anyone looks at it.
//
// Below that line the green state is unreachable in steady state, which is the
// defect. Above it a healthy proxy stays green continuously and only a proxy that
// really stopped answering goes quiet.
//
// ⛔ These are DISPLAY windows only. A window a DECISION consumes (the launch
// path's exit identity, the simulator's clock) is deliberately NOT derived from
// here — see `EXIT_IDENTITY_TTL_MS` in proxy-probe-cache.ts.
//
// ⛔ NO IMPORTS, on purpose. Both the cache (which drags the Tauri store in) and
// the import-free os-fingerprint-verdict must age the same reading by the same
// number, and neither may import the other. One definition, no cycle.

/** How often the driver attempts a sweep — the scheduler slot every automatic
 *  re-measurement is planned in, and therefore the slack term `S` above.
 *  Re-exported by proxy-probe-sweeper, which owns the sweep itself. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** How old a capability reading may be before the app re-takes it unasked —
 *  the cadence `C` above. Six hours: Driftstack's own re-check cadence, settled
 *  on after rejecting thirty minutes as too costly for the customer's bandwidth
 *  (one check dials the customer's proxy for ~11 s, a VPN row up to 95 s). */
export const CAPABILITY_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

/** How long after ANY automatic attempt on a row before the next one. The
 *  outcome is deliberately not consulted: "no machine free", "a session is using
 *  this VPN" and "the server did not answer" are each a reason to come back
 *  later, and none is a reason to come back in fifteen minutes. */
export const CAPABILITY_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** `S` — one scheduler slot of slack, named so the arithmetic below reads as the
 *  invariant rather than as two numbers that happen to be added. */
const DISPLAY_SLACK_MS = SWEEP_INTERVAL_MS;

/**
 * Head-room beyond `C + S`, because a re-take that is DUE is not a re-take that
 * HAPPENED: the automatic check is budgeted (three rows a run, one of them a VPN
 * row), backed off per row, and needs an API key. One hour buys a row four more
 * sweep slots to win a place in that budget before its chip goes quiet.
 */
const DISPLAY_MARGIN_MS = HOUR_MS;

/**
 * `W` — the display window for every reading Driftstack re-takes on the
 * capability cadence: the Test relay verdict (`quicProbe`), the UDP-relay verdict
 * (`udpProbe`) and the passive OS fingerprint.
 *
 * THE ARITHMETIC, spelled out so a reader can check it against today's numbers:
 *
 *     C 6 h  +  S 15 min  +  margin 1 h  =  7 h 15 min  ->  rounded up  =  8 h
 *
 * Rounded UP to a whole hour so the number a customer could compute from a chip
 * ("4 h ago") lands on an hour boundary, and so the window can only ever grow when
 * the rounding moves. ⛔ DERIVED, not typed: moving `CAPABILITY_REFRESH_AFTER_MS`
 * moves this, which is the whole point — the three hand-typed thirty-minute
 * literals this replaces could not follow the cadence when it changed from thirty
 * minutes to six hours, and did not.
 */
export const MEASURED_READING_TTL_MS =
  Math.ceil((CAPABILITY_REFRESH_AFTER_MS + DISPLAY_SLACK_MS + DISPLAY_MARGIN_MS) / HOUR_MS) *
  HOUR_MS;
