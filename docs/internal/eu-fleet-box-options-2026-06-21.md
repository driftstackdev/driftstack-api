# EU fleet box — streaming-latency unlock (options brief)

**Date:** 2026-06-21 · **Author:** Agent 2 · **For:** founder decision + A3 (fleet) / A1 (fingerprint) input

## Why

The founder (NL) reports the live simulator stream is "very slow" — worse than an
EU→US RDP, and far from the "remote-gaming-possible" feel intended. Root cause
(A3 deep investigation wpiyo8v6x, confirmed): the LiveKit SFU is **co-located on
each Mac box** and the desktop client connects **directly** to it with no edge in
between. The only box today is in the **US** (MacStadium 199.7.163.49), so every
tap-to-render round-trip pays the full **~150–180 ms** trans-Atlantic RTT. This is
geography, not codec/bitrate/relay — the GUI subscribe side is already maxed
(adaptiveStream off, playoutDelay 0, dynacast) and the new transport diagnostic
will confirm `udp · direct`.

**The unlock is an EU Mac box.** NL→Paris/Frankfurt is ~**10–20 ms** RTT — roughly
a **10× reduction**, into the sub-30 ms range that feels local.

## Options

### 1. Scaleway — Apple silicon, PAR-1 (Paris) — RECOMMENDED

Transparent EUR pricing, hourly or monthly, **no minimum commitment**, launch from
the console, VNC/CLI access. Closest EU region to NL (~10–15 ms RTT).

| Model           | Chip                       | RAM   | Storage | Price              |
| --------------- | -------------------------- | ----- | ------- | ------------------ |
| Mac mini M2 Pro | M2 Pro (10c CPU / 16c GPU) | 16 GB | 512 GB  | €139/mo · €0.21/hr |
| Mac mini M4-M   | M4 (10c CPU / 10c GPU)     | 32 GB | 1.02 TB | €199/mo · €0.29/hr |
| Mac mini M4 Pro | M4 Pro (14c CPU / 20c GPU) | 64 GB | 2.05 TB | €335/mo · €0.49/hr |

(M1 / M2 / M4-S also exist but are under-spec for the fork build + render.)

### 2. AWS EC2 Mac — eu regions (alternative)

EC2 Mac (mac2 = M2 Pro, plus M4/M4 Pro) runs on Dedicated Hosts, **per-second with
a 24-hour minimum** (Apple license). Historically available in eu-west-1 (Ireland)
and eu-central-1 (Frankfurt) — **verify current region availability in the
console**; the public page doesn't enumerate it. More expensive and more
operational overhead than Scaleway; only worth it if we standardize on AWS.

## Two caveats to resolve before picking (A3 / A1)

1. **macOS 26 + Xcode 26.5 on the image (A3).** The fork build needs macOS 26.x +
   Xcode 26.5. Confirm the provider image ships (or can upgrade to) macOS 26
   before committing. The bring-up toolkit (`operations/mac-fleet-bringup/`) is
   already parameterized and the font surface is now macOS-version-independent
   (W2196 / macOS-26.4 descriptor fix), so a fresh 26.x box should come up clean.

2. **Chip-family fingerprint match (A1).** The current fleet gold-truth is **M2
   Pro**. The canvas / WebGPU GPU fingerprint can differ by chip generation (the
   open "M2-vs-M3 GPU" gap). So for fidelity the EU box should ideally be **M2 Pro**
   (Scaleway €139/mo) — but that tier is **16 GB** vs the current box's 32 GB,
   which may be tight for an on-box WebKit build. Mitigation: build the binary on a
   32 GB box (or CI) and deploy it to the 16 GB M2 Pro runtime box; or accept M4
   Pro and have A1 re-baseline the GPU fingerprint for that chip. **This is the key
   tradeoff: fingerprint fidelity (M2 Pro, 16 GB) vs headroom/newness (M4 Pro,
   64 GB).**

## Prerequisite — region-aware dispatch (server, A2 lane) — ✅ DONE (5e7b8614)

An EU box only helps EU users if session dispatch actually _routes_ them to it.
Dispatch **was** region-blind (`findAnyWithLivekit`); it is now region-aware and
deployed, so the EU box is plug-and-play the moment it registers. `accounts.region`
(`us | eu | apac | null`) + `fleet_nodes.region` now drive selection via
`DrizzleFleetNodesRepo.findNearestWithLivekit(region)`: prefer a non-revoked livekit
node in the viewer's home region, fall back to any livekit node when the region has
none (single-region fleet / regional outage → a far box still beats no box).
`dispatchSessionAssignOnCreate` threads `ctx.account.region`. The harness
`sessionAssign` payload / W298 contract is unchanged — only _which_ connected node
receives it. **No behavior change for the current single US box** (findNearest falls
back to findAny). Tested: dispatch threads the region + picks the EU node for an EU
viewer (unit); repo prefers-region / skips-revoked / within-region-livekit-filter /
fallback (integration vs real Postgres). So the only remaining EU-box work is the
provisioning decision + bring-up below.

## Recommendation

Start with a **Scaleway PAR-1 M2 Pro** (€139/mo, matches the M2 Pro gold-truth,
no commitment so it's cheap to trial) for the founder's own low-latency sessions,
building the binary off-box if 16 GB is tight. Measure the real RTT with the new
transport overlay; if it lands ~10–20 ms `udp · direct`, that confirms the EU box
is the streaming unlock and we scale the EU fleet from there. If 16 GB proves too
tight and A1 can re-baseline, step up to M4 Pro (64 GB).

**Decision needed from founder:** approve a Scaleway EU trial box (which tier),
then A3 brings it up via the existing toolkit and A1 confirms the fingerprint.
