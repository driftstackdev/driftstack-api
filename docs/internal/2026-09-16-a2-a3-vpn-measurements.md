# A2 → A3 measurements, 2026-09-16 (VPN egress, phase ladder, network pane)

Durable copy of what went over the cross-session socket tonight. The socket dies
with either session and leaves no artefact; these are the numbers, so a later
reader does not have to take the conclusions on trust.

`docs/internal/OPEN-ITEMS.md` is named in CLAUDE.md as the A2↔A3 channel and does
not exist in this repo — it was carved out to `driftstack` in `c99b4e75e`, which
A2 does not write. This file is the substitute, not a new convention.

## 1. The "stays connecting, cannot take control" fault — CLOSED

Cause was A3's: `buildCapabilityReport` opened with a guard on `proxyHandles`,
but VPN handles live in `userspaceEgressHandles`, so the builder returned nil for
every VPN session and the emit arm's optional binding skipped the frame silently.
Fixed in `a43d28832`.

Verified by A2 against a **manual-mode** session on the account's own OpenVPN
proxy — the owner's exact mode and proxy, not a generalisation from an AI session:

| moment                                  | elapsed |
| --------------------------------------- | ------- |
| dispatched                              | 0.0s    |
| tunnel up, session active               | 7.5s    |
| `manual_input_available: true` reported | 7.5s    |
| stream live                             | 18.3s   |

Needs no desktop-client update: the released client already gates on that field.

## 2. The phase ladder — A2 WAS WRONG, and the real defect is delivery lag

A2 first reported "seven phases inside one millisecond, the node batches its
phases". That was read off pino's **receive** time. The projection had dropped
the frame's own `timestamp`, which `SessionStatusSchema` makes required — the
instrument could not express the answer and returned a confident one anyway.

With the frame clock logged (session `agt_7d0951fb`):

| phase                  | fired    | received     |
| ---------------------- | -------- | ------------ |
| vpn_egress_bringing_up | 22:38:44 | 22:38:44.944 |
| resolving              | 22:38:44 | 22:38:46.893 |
| handshaking            | 22:38:45 | 22:38:46.893 |
| assigning_address      | 22:38:47 | 22:38:57.744 |
| configuring_routes     | 22:38:47 | 22:38:57.744 |
| starting_proxy         | 22:38:47 | 22:38:57.745 |
| verifying              | 22:38:47 | 22:38:57.745 |
| vpn_egress_active      | 22:38:48 | 22:38:57.745 |
| browser_spawning       | 22:38:48 | 22:38:57.745 |
| active                 | 22:38:49 | 22:38:57.745 |

The phases fire across ~5s. `pushVPNPhaseFrame` stamps at append, as A3 said, so
there is no batched-occurrence bug.

⛔ **`active` fires at 22:38:49 and arrives at 22:38:57.745 — 8.7s late.** For
those 8.7s the session is running and nothing downstream can know it. That is not
the reported bug, but it is the same experience on every VPN session and it is
exactly the kind of noise that made a real fault take five reports to isolate.
**Open, A3: drain the outbound queue sooner, or on append of a terminal-ish
phase.** A2 is deliberately not rendering a progress bar off this — it would
animate nine seconds after the thing it describes finished.

## 3. Network pane — every artefact present, nothing arriving. Open, A3.

Measured with A2's new success-path log live (`networkRequests accepted: rows
appended`, counts and session id only, never a URL):

- manual session `agt_7d0951fb`: **0 batches**
- AI session `agt_f8313c55`, navigated to driftstack.io: **0 batches**

⚠️ Earlier in the day a production search for this feature returned zero lines and
that proved NOTHING, because the relay could only log failures. Six of eight
relays had the same shape. The zero above is a measurement; the earlier one was
not.

Artefacts confirmed present, so this is not a build gap:

- fork `WebKit.framework` on the node contains the `[Driftstack-NET` emit marker;
- the running daemon (inode-verified against the built artifact) contains both
  the parse literal and the `networkRequests` frame tag;
- A2's receiving half — wire schema, ring, owner-scoped read, GUI pane — is built
  and idle.

A2 is not asserting where it stops.

## 4. Safeguards — fail-open closed by A3, A2 wiring pending

`safeguardChecks` always seeds 3 layers and appends `screen_recording` only when
checked, so A2's `length > 0 && every(passed)` returned **true** for a
never-checked safeguard. A2 had this backwards twice (thought it failed closed,
then proposed a nullable field that would not have fixed it).

A3's fix is better than either option A2 offered: the producer declares
`safeguardLayersExpected`, so the control plane asserts reported ⊇ expected. A2
reads it off the frame and never mirrors the list. Live and reporting: 4 layers,
0 failures.

**Open, A2:** wire the superset check; treat an ABSENT expected set as "cannot
verify completeness", never as an empty one, so a rollback degrades honestly.

## 5. `dns_remote_resolve` — agreed shape, A3 building

A2's relay hardcodes `true`; nothing measures it per session and the frame has no
DNS field. The customer-facing warning it gates ("DNS resolved outside the
proxy" — named in its own doc as the classic proxy leak) can therefore never
fire, and the published webhook example shows a value no writer can emit.

Agreed split: the ATYP=DOMAINNAME measurement is a property of the PROXY and goes
on the validation result; the session frame carries only the structural fact. A2
does not derive the customer boolean until the third input — whether the fork
pre-resolves, which is A1's — exists. Two of three inputs is how the hardcoded
value came to exist.

A3 landed `7c332f405` / `e7a9e36d5`: three-valued, `false` on SOCKS5 REP=0x08
only, nil for every other refusal and all unreachability.
