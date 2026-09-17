# A2 2026-09-17 — the Proxies tab, and readings that looked missing

Two requests from the owner: a proxy missing its UDP / QUIC / device-stack reading should be
checked automatically; and the Proxies tab had too many columns, forcing sideways scrolling —
fix it without removing useful information. Shipped in `62eaec4f7`, `332d56f67`, `e0ec4c598`,
`4d82f3bad`. This file records what was found, what was decided, and what is left to the owner.

## The readings were mostly HIDDEN, not missing

Measured on production before writing any code (12 proxies): 9 with a stored exit, 8 with a
device-stack reading, 6 with a QUIC reading, and **no stored UDP reading at all**. Three separate
causes sat under one symptom:

| Reading      | How it was filled                                        | Why it looked missing                                                                                                                       |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Device stack | server job, every 6 h, running fine (195 runs, 0 failed) | the desktop hid any reading older than **30 min**, server-seeded ones included — 7 of 8 were fresh by the server's rule, 4 by the desktop's |
| QUIC         | only a live session that happened to negotiate HTTP/3    | a Test measured it and **never stored it**; `quic_measured` was served by the list and read by nothing in the app                           |
| UDP          | nowhere server-side                                      | lived only in the cache of whichever Mac pressed Test                                                                                       |

And one trap under all three: the schema allowed a stored "no" (`h2-only`) but nothing ever wrote
one, so a measured negative was indistinguishable from "never measured". A naive "check when
missing" would have re-probed a proxy that genuinely lacks QUIC on every visit, for ever.

## What shipped

- **Server** (migration `0124`): a Test stores each measured leg — true AND false — dated at the
  moment of measurement; a skipped leg stores nothing. Written with one conditional `UPDATE` whose
  `WHERE` carries the identity the reading was taken through, so a stale "no" cannot land on a
  repointed row. Verified on prod: four nullable columns, 125 migrations, 12 existing rows untouched.
- **A third display state, AGED**: "✓ QUIC · 5 h ago", muted, dashed, past tense. The 30-minute
  freshness rules are load-bearing (a present-tense chip must be current; a launch acts on a fresh
  exit) and were NOT stretched — the fresh maps and the launch path are byte-for-byte as before,
  and two tests compare the current chips' markup with HEAD's to prove it.
- **Adoption**: the desktop now takes what the server holds. The wire's `quic_probe` (stored,
  possibly weeks old) collided with a client field of the same name meaning the opposite (THIS
  test's fresh result), so stored readings are renamed at the wire boundary.
- **A bounded automatic check** for saved proxies with missing readings: at most 3 rows / 1 tunnel
  per 15 minutes across every trigger, 6 h backoff per row (24 h after a plan refusal), never
  beside a sweep, never holding the claim a launch or a manual Test waits on.
- **The table**: 11 columns → 6 grouped ones (Proxy · Exit · Network · Health · actions) plus a
  detail row showing MORE than before (full endpoint, exit network + timezone, both latencies with
  when they were taken, every capability as a sentence, the full failure message). Fits the 960px
  minimum window. The tab is now under the visual audit; its 32 text-quality failures (8px labels,
  3.0:1 contrast) are fixed and the gate reports 0 findings across 32 scene×theme cells.

## ⛔ The consent rule, unchanged

No automatic path uploads credentials. A proxy with no `serverId` is refused at four independent
places, and the pinned "never probes a proxy that has never been tested" arm is untouched. Four
independent reviewers tried to break this first; all reported HOLDS. **Consequence the owner should
know:** a proxy that lives only on this Mac and was never tested is NOT auto-checked against the
server — measuring it would mean uploading its credentials on a timer's say-so. It shows "not
measured" with Test one click away. Everything tested at least once is covered.

## Left to the owner

1. **The desktop changes reach nobody until a desktop release is cut.** The server half is live
   now; the table, the aged state and the automatic check ship with the next `gui-v*` tag.
2. **One failed address lookup retires a row's readings until re-measured.** A DNS blip on a VPN
   row blanks its QUIC/UDP/device-stack readings (they return via the automatic check, within its
   budget). Both reviewers suggested skipping the write when the machine is plainly offline; that
   changes the sweep's behaviour, so it was not done silently.
3. **Should the observed exit obey the same retirement rule?** Left exempt, deliberately: a launch
   reads the timezone from it and only a live session can re-date it.
4. **A VPN row in "tunnel down" is now re-tested automatically at most every 6 h** (it was every
   15 min through the sweep's failure retry). Cheaper for the customer's tunnel; a transient
   failure stays red longer. A manual Check is still immediate.
5. **At the 960px minimum window the capability chips still stack**, because the exit address and
   the longest status label cannot shrink. At the 1280 default they sit three to a line.
6. **`config.udp_capable`**, which the session dispatch reads, is still a second home for a fact
   `udp_probe` now holds. Pointing the dispatch at the stored reading changes session behaviour and
   was left alone.

## How it was built, because the method is the reusable part

Four workflow rounds, each implement → adversarial review → repair. The first cut of the
automatic check drew **14 majors**, then 3, then 2 — each fixed and proven by mutation. Two of the
fourteen were caused by the orchestrator's own spec, not the implementer: "wire the dormant sweep
path" silently chose a cadence (up to five tunnels per window focus), and ageing a shared field
broke the profile cards, which the spec never listed.

Three things no measurement caught and only LOOKING at the render did: capability chips stacked
one per line beside an empty gap (every overflow check passed); a truncated host eating the port;
and an aged chip breaking mid-phrase inside its own border.
