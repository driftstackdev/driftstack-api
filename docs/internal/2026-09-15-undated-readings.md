# The undated reading — one defect class, five instances (2026-09-15)

## What the owner reported

A proxy's OS chip read `linux` in the profiles grid while browserleaks.com/ip,
loaded _through the same proxy_, read Mac/iOS. A second proxy read `Win`.

## What it actually was

A3 established that the first proxy's connectivity probe **fails on every
attempt**. So the `linux` on screen could not have come from a live measurement:
it was a cached reading, of unbounded age, rendered in bare present tense.

⚠️ **State this carefully when reporting it.** The value the owner saw has no
surviving measurement behind it — the probe has failed every attempt since. The
honest sentence is "it was a cached reading we could not date, and the grid now
shows `— OS` instead", **not** "we fixed the fingerprint".

## The class

A stored measurement carries a timestamp that **every writer writes and no
reader reads**. The screen then renders the value as a current fact.

A3's sharper framing, which is the reusable one:

> When two fields of different decay classes sit side by side, the fresher one's
> timestamp gets read as covering both. "Tested just now" over a days-old
> address is not a missing TTL — it is one freshness signal silently borrowed by
> a neighbour.

That explains why the bug is invisible to the person writing it: **the screen
already had a date on it.**

Two rules fell out, both load-bearing:

1. **A measurement perishes; an EXPLANATION does not.** "A VPN tunnel has no
   SOCKS5 stack to fingerprint" is a statement about the CONFIGURATION and is
   true however old it is. Expiring it replaces a true explanation with "never
   measured" and sends the customer to press Test on a row that can never
   produce a value — strictly worse than the staleness being fixed. A single TTL
   over a field holding both kinds collapses them.
2. **An UNDATABLE reading is not fresh.** Fail closed, matching the observer
   lookup's refusal of a record with no `seen_at`.

## The six instances

| #   | Where                                                                                                 | Status                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Client probe cache — `CachedOsFingerprint.at` written by every reading, read by nobody                | **Fixed** (`6d890495c`) — 30-min TTL in the derivation; a cause never ages; undatable is not fresh                                                                             |
| 2   | `deriveProbeViewWithEndpointRows` re-added the field the TTL had just dropped                         | **Fixed** (same commit) — the rule was true of SOCKS5 rows and false of VPN rows, with a 378-file green suite either way                                                       |
| 3   | Server session projection read `os_fingerprint`, ignored `os_fingerprint_at` (migration 0119)         | **Fixed** (`8028c815b`) — the stamp crosses to the customer; the cockpit says `· 3 mo ago` past the window; an undatable reading projects nothing                              |
| 4   | The EXIT ADDRESS: `exitAt` exists, `isExitIdentityFresh` gates the LAUNCH path only                   | **Fixed** (`d57d0ff71`) — we declined to _route_ through a reading past 30 min while still _showing_ it as current. The details sheet now dates it; the tile keeps the address |
| 5   | The relay verdict `quicProbe` never expires while the STRONGER evidence beside it does                | **Fixed** (`cdd527b15`) — not with a TTL; see below                                                                                                                            |
| 6   | The SERVER latency is preserved across native re-tests and shown undated beside the row's Tested time | **Fixed** (`017951076`) — the sheet dates it when it differs from the check                                                                                                    |

### Instance 5, and why the obvious fix was wrong

`proxyCapabilities` collapses two sources into one chip, strongest first: a live
session's measured HTTP/3, then the fleet Mac's relay handshake. The strong one
expires at 30 minutes (W-30). The weak one never does. So a live `h2-only`
measured through the customer's own browser ages out, and an older relay `true`
underneath it resurfaces as a green "HTTP/3 works through this exit".

⛔ **A TTL on the relay verdict would have been a real regression.** A live
verdict is re-emitted by a running session every ~300s; the relay verdict is
written _only_ when someone presses Test. A thirty-minute window on it means the
green chip is essentially never shown — which is the owner's **original**
complaint ("my proxy has QUIC but its not detecting it"), reintroduced by a fix
for a different one.

The rule that needs no window: **contradicted evidence must not outlive the
measurement that contradicted it.** Both are statements about the same _mutable_
property, so the later measurement wins and the earlier one it contradicts is
retired. Strength only breaks ties at the same instant. Agreement is kept —
corroboration is why the chip stays green after the live verdict expires.

## The sweep's positive control — and where it came back clean

A sweep that finds defects everywhere it looks is measuring the sweeper, not the
code. This one has a control, and it passed: of the THREE stored measurements
the control plane keeps on a proxy row, two already crossed their stamp to the
customer and only one did not.

| column                  | stamp projected to the client?                         |
| ----------------------- | ------------------------------------------------------ |
| `exit_observed` (0120)  | ✅ `observed_at` — `account-me.ts:717`, `:1394`        |
| `quic_measured` (0116)  | ✅ `quic_measured_at` — `account-me.ts:703`, `:1103`   |
| `os_fingerprint` (0119) | ⛔ **`os_fingerprint_at` read by nobody** — instance 3 |

So the server side is now consistent rather than uniformly patched, and the OS
fingerprint was the outlier, not the rule. Worth knowing before the next person
assumes the whole layer was careless about time.

## How the instances were found

Not by further reports. After fixing the one that was reported, I grepped for
**other readers of the same field** and then for **other writers of the same
output key** — an overlay is a writer. Instances 2–6 came out of that in a
single pass; five of the six were never reported by anyone.

### Instance 6 — the server latency

`saveProbeResult` preserves `serverLatencyMs` across a native capability
re-test, the card PREFERS the server number when `latencyFromServer` is set, and
the background sweeper runs native probes every fifteen minutes. So a SOCKS5
row can show a fleet latency measured hours ago under a Tested stamp refreshed
minutes ago — the same borrowed-freshness shape as the exit address.

`serverProbeAt` already dates it, and `serverProbeStamps` already surfaces that
date — **but only for endpoint (VPN) rows**. That is exactly why the SOCKS5 case
went unnoticed: the code looked like it already handled this.

Fixed the same shape as instance 4 — a `serverMeasuredAt` map on the view state,
carried by BOTH derivations, rendered in the details sheet beside the Checked
row, and silent when the two dates are the same check.

⚠️ One deliberate difference from the exit: there is **no "unknown time" state**
here. The exit is an identity, and a surface that stays silent about an undatable
one reads as saying it is current; a latency is a magnitude and visibly
approximate, so a line admitting we cannot date it would cost more attention than
it is worth.

## Known limit of the fix itself

The derivation ages against `Date.now()` captured when `ProfilesView`'s memo
RECOMPUTES, and it recomputes only when the probe cache changes. A reading
therefore keeps rendering past its window until the next cache emit rather than
at the instant it expires.

Bounded, not unbounded: the background sweeper writes every fifteen minutes while
the app is open, so the worst case is ~45 minutes against a 30-minute window. The
pre-existing QUIC verdict TTL (W-30) has always had the same property.

⚠️ Deliberately not closed with a periodic tick in the memo deps: that re-renders
the whole grid every minute to buy at most fifteen minutes of accuracy on a
heuristic window. Worth doing only without a timer — recomputing on window focus,
the moment a customer is actually looking. Recorded beside the memo in the code
as well, because an unrecorded known gap is how the original one survived.

## Open / handed over

- ⛔ **Two-port OS diagnostic — BLOCKED on permissions, not design.** The plan
  was settled with A3: drive the 443 CONNECT server-side with the _same dialer_
  as the 7791 leg (the deployed `dist/services/proxy-connectivity-probe.js` on
  the origin IS that dialer; `observeOs` already takes an observer host/port and
  an injectable lookup, so two instances differing only in port — 7791 vs 443 on
  the same IP, no DNS and no CDN question — isolate port from dialer exactly).
  Mid-session the permission classifier began refusing SSH to production,
  including a plain `ls`. Not routed around. **Needs the owner to allow it.**
- ⚠️ **VerizonNY cannot be the decisive case** until its 7791 leg succeeds at
  least once (A3's correction, accepted).
- **A3 → A2 handover, shape frozen:** the harness re-verifies a live session's
  exit every ~10 min and **discards the address**. It will be emitted on the
  capability report as `exitIp` (IP literal) and `observedAt` (ISO-8601), both
  optional and both omitted when the sweep produced no measurement. ⛔ camelCase
  — the CP schema declares `exitIp`/`observedAt` with `.catch(undefined)`, so
  snake_case keys would be dropped silently and the frame would still validate.
  Landing behind A1's macworker suite window.
