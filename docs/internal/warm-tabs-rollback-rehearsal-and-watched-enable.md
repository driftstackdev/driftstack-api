# Warm tabs: rehearse the rollback, then a watched enable

> ⛔⛔ **CORRECTION 2026-08-27 (V-1996) — this plan's premise was false when it was written.**
> Warm tabs was **already enabled on the box, and had been for four days**: `DRIFTSTACK_WARM_TABS=1`,
> durable in `node.env` (found by A2). Everything below that says "the flag is still off" is wrong,
> and **Phase 0 as written would have flipped a flag that was already set** while capturing a
> before-state that never existed.
>
> ⭐ The "unresolved" question at the end of Phase 0 is now answered, and it resolved the way the
> stale ledger did not: **it ran enabled; the ops record was simply never written.** `ops=0` meant
> "nobody wrote a record", not "the flag was never on" — which is exactly why those two claims were
> kept separate rather than collapsed into the ledger's silence.
>
> ⚠️ Those four enabled days overlap the root-cryptominer window on the same host
> (`docs/runbooks/box-access-and-2026-08-27-incident.md`; ~600% of twelve cores, 08-23 → 08-27), so
> warm tabs ran on a machine missing half its CPU. **Any conclusion about its behaviour under load
> from that period is contaminated** — which is not a reason to skip a watched enable, it is the
> reason to do one against a clean host and get a baseline that means something.
>
> **What survives unchanged:** the rehearse-the-rollback-first argument below. A rollback that has
> never executed is still a plan rather than a control, and that is _more_ true now that the feature
> has been live and unwatched for four days on a compromised host. Phase 0 should be re-scoped from
> "rehearse while off" to "rehearse the disable path against a host that is currently serving with it
> ON" — the same steps, with a real blast radius, which is what the rehearsal was always for.

Owner decision, 2026-08-27. Warm tabs (`DRIFTSTACK_WARM_TABS`, doc-151 Route A) is built, gated
default-OFF, and **never validated under load**. The chosen path is: **prove the rollback works while
the flag is still off, and only then enable on one node under watch.** ⛔ **(The premise is false — it was already on; see the correction above.)**

⛔ **Why the rehearsal comes first, in one sentence:** a rollback that has never executed is a plan, not
a control — and this repo produced three separate cases in a single day of a documented mechanism that
was never actually built (a "v1.1 classifier" that does not exist, a "GET + DEL fallback" that was never
written, a `credentials: true` justified by a cookie session that does not exist). **The escape hatch is
exactly the kind of artifact that gets written down and never run.**

## Phase 0 — rehearse the rollback ⛔ (heading is wrong: the flag was ON — see the correction above)

The documented procedure is `DRIFTSTACK_WARM_TABS=0` + kickstart + revert. Run it end to end **now**,
while warm tabs is off, so a failure costs nothing:

1. Record the daemon's current env and PID **before** touching anything. This is also the artifact that
   settles an open question (below), so capture it even if the rehearsal is otherwise uneventful.
2. Execute the documented rollback exactly as written — no improvised steps. **If a step does not work
   as documented, that is the finding, and it is worth more than the enable.**
3. Confirm the daemon comes back with the flag readable as `0` and sessions still serving.
4. **Post-condition, not a derivation:** assert the running daemon's env shows `DRIFTSTACK_WARM_TABS=0`
   — do not infer it from "the command exited 0".

⛔ **RESOLVED 2026-08-27 — see the correction at the top.** This section read: a bus post records a
daemon carrying `DRIFTSTACK_WARM_TABS=1`, but the flag appears in **zero** ops records (`ops=0 bus=8`),
so "off on the box" and "never ran anywhere" are different claims and only the first is established.
**The answer is that it was ON, for four days.** The bus post was a fact, not an intent; `ops=0` meant
the record was never written. The instruction that still stands is the last one: whatever is captured
of the daemon env **must** be written to an ops record, because the missing record is what made a live
flag look unset for four days.

## Phase 1 — watched enable, ONE node

Only after Phase 0 succeeds:

1. Enable on a single node. Keep the rehearsed rollback within reach, not within a document.
2. **Watch these three, and stop on any of them:**
   - **Memory at N=2 on heavy pages.** A canary previously OOMed below 1800 MB, which is the origin of
     the reap-guard sizing. Memory is the failure mode most likely to arrive slowly and be missed.
   - **`-1004` / `ECONNREFUSED errno 61`.** This was reproduced on a deployed fork on 2026-07-11 and
     root-caused to the fork not tearing down the WebDriver listen socket. ⛔ **Confirm the
     accept-teardown guard is present in the build being enabled** — it is the one blocker with a
     reproduction behind it rather than an unvalidated status.
   - **Tab-switch correctness**: no reload on switch, and the switched-to tab shows its own content.
     That is the complaint this exists to fix, so it is also the acceptance test.
3. **Boundary to state in whatever gets reported:** a clean single-node run establishes that this build,
   on that hardware, under that traffic, did not regress. It does not establish fleet-wide safety.

## What is NOT established, and should not be asserted while doing this

- That the "never validated" status is stale. That assessment is recorded in the private repo's
  `OPEN-ITEMS.md` under A3's name, but was **transcribed from A3's messages rather than written by A3**,
  and its specifics (a 1400 MB reap guard, an LRU, memory-pressure eviction) are unverified by A3.
- That the `-1004` teardown guard landed and holds. It lives in the fork repo.

**Both are checkable by whoever runs this. Neither should be carried as settled.**
