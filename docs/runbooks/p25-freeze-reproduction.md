# P-25 — reproducing the freeze (runbook)

The plan's deliverable for P-25 is **a captured flight record from an actual freeze, or a
written negative that names the conditions tried**. The fix landed (`612a88034`,
`43e7ee2eb`, `aaf88dd8b`) from a mechanism verified against the vendored livekit-client
source, not from a reproduction. This runbook is the reproduction, written so the result
is a measurement and not an impression. **Record the leg with every capture: the dev-log
does not stamp the app version.**

## The mechanism being reproduced

`livekit-client` reliable `publishData` awaits `waitForBufferStatusLow` with **no timer**
before `dc.send`. A reliable data channel that stalls while the room stays connected parks
every later input publish forever (no room-level reconnect trigger fires). The GUI's
receipt table then pins at `MAX_PENDING_INPUT_RECEIPTS` (128) and the simulator reads as
frozen; only a full restart recovers, and every live session is lost.

## Two legs

| leg       | build                                                                                                                                                       | what its dev-log can show                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| UNTREATED | installed gui-v0.1.14 (`aad99b9c5`, 2026-09-03) — has the recorder + census (`17d426154`, `53d07aca8`) and the 5 s input bound (`a51f24c5d`), lacks the fix | the MECHANISM: `receipts=128`, `[simulator] input publish exceeded 5000ms`, pending receipts climbing without acks     |
| TREATED   | ≥ gui-v0.1.15 (first tag containing `612a88034`)                                                                                                            | the FIX: `ReliableChannelStalledError` / the `stalled` badge instead of a wedge; `[tab-switch] ack` lines keep flowing |

Do the untreated leg first: if the mechanism does not appear there, the treated leg has
nothing to prove and the owner's freeze has another cause.

## Conditions (all three, in this order; stop at the first hang)

Where: the GUI legs run on the Mac where the app is installed; load/driving from the box
(`macworker`) per N-12. One live session against the fleet, real device.

1. **Sustained multi-site browsing, one tab.** 20 minutes of continuous navigation across
   ≥ 12 distinct heavy sites (news, maps, video landing pages), a navigate every 5–15 s,
   scroll/tap between navigations. This is the owner's "sustained real use".
2. **Tab churn.** Open 6 tabs, switch every 3 s for 5 minutes (`[tab-switch] ack` lines
   give elapsedMs per switch), close 3, open 3 more, repeat twice.
3. **Input storm on a stalled channel.** With the session live, throttle the Mac's uplink
   (Network Link Conditioner, "Very Bad Network" or 100 % loss for 20 s, then restore) while
   tapping/scrolling continuously. This is the precise trigger for the parked-frame
   mechanism; the treated build must surface `stalled`, the untreated build should wedge.

## What to capture

- `~/Library/Application Support/dev.driftstack.gui/recordings/dev-log-simulator.txt` and
  `dev-log.txt` — copy both immediately after the hang (the buffer is mirrored ≤ 1 s
  behind; an ERROR flushes immediately).
- The flight-record lines: `tabCount`, `pendingReceipts`, the stall watch's `onStall` line
  with its `mainThreadBlockedMs`.
- Wall-clock of the hang and which condition (1–3) was running.
- The leg (0.1.14 vs 0.1.15) by hand, at the top of the capture.

## Recording the result

- **Reproduced:** attach both dev-logs to the P-25 row with the leg, condition, and the
  `receipts=` / `stalled` line that names the mechanism. On the treated leg a `stalled`
  badge with recovery (no restart) closes the row.
- **Not reproduced:** write the negative on the P-25 row as _conditions tried_: which of
  1–3 ran, for how long, on which leg, and the max `pendingReceipts` seen. A negative with
  no conditions is not a negative.

## Not done as of 2026-09-05

The fix is on `origin/main` but in no `gui-v*` tag; gui-v0.1.15 is owed before the treated
leg exists. Neither leg has been run: the GUI legs need the installed desktop app driven on
the owner's Mac, which A2 does not launch unattended.
