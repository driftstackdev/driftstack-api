# V-542 — backup + DR verification checklist

**Date:** 2026-05-11
**Wave:** 21
**Status:** CHECKLIST — manual verification artifact. Automation deferred to
V-542.B (scheduled job that runs the checklist + posts results to admin
status).

## Purpose

`scripts/dr-rehearse.sh` (already exists from V-510) rehearses a disaster-
recovery scenario: spin up a fresh Postgres + Redis, run migrations,
optionally seed, and verify the control plane boots cleanly. The rehearsal
_can_ run; but until V-542 nobody had a structured pass/fail checklist for
deciding "did the rehearse actually work end-to-end?".

This checklist closes that gap.

## When to run

- **Weekly during pre-launch** — until the first paying customer, weekly
  rehearsal catches schema drift early.
- **After every Drizzle migration that touches data tables** — confirms
  the migration applies cleanly against a backup snapshot.
- **Before each marketing-site launch wave** — confirms the production-
  shape state restorable.
- **Quarterly post-launch** — production rehearsal cadence.

## Checklist

### A. Pre-rehearsal state

- [ ] **A1.** Production HEAD recorded: `git -C /Users/john/code/driftstack-api
rev-parse HEAD` → stored at `/tmp/dr-rehearse-pre-head.txt`.
- [ ] **A2.** Postgres production snapshot available within last 24h.
      Snapshot location: Neon's automated daily snapshot (auto-managed) OR
      `pg_dump` from the rehearsal harness against the running production
      DB.
- [ ] **A3.** R2 object listing exported. The recapture / capture buckets
      should have a current object count + total bytes recorded for the
      restore-completeness check.
- [ ] **A4.** No active sessions on production at rehearsal start (or
      rehearsal runs against a copy, not prod directly).

### B. Rehearsal execution

- [ ] **B1.** `bash scripts/dr-rehearse.sh` runs end-to-end without
      non-zero exit.
- [ ] **B2.** Postgres container starts within 30s; Drizzle migrations
      apply cleanly (no `ERROR` lines in output).
- [ ] **B3.** Redis container starts; control-plane connects without
      reconnection loop.
- [ ] **B4.** Control plane boots; `/health` returns 200 with the expected
      shape `{ "ok": true }`.
- [ ] **B5.** Control plane registers every route. Do NOT eyeball this
      against a remembered number — derive both sides:
      `ls apps/server/src/routes/*.ts | wc -l` for the module count and
      `curl /openapi.json | jq '.paths | keys | length'` for the paths,
      and require the restored instance to MATCH the same two commands
      run against production. At the time of writing that is 60 modules
      and 208 paths.

      V-819 — this step named a module count from the V-540.A audit and
      a minimum path count, and both were roughly half of reality. A
      disaster-recovery completeness check whose floor sits that far
      below the truth cannot detect the thing it exists for: a restore
      that brought up a third of the control plane would clear ~80 paths
      comfortably and be ticked off as complete. A floor is only a check
      when it is close to the ceiling, which is why this now compares
      restored against production rather than against a number somebody
      has to remember to update.

- [ ] **B6.** Optional seed data applied if rehearsal mode = `seeded`.
- [ ] **B7.** Rehearsal cleanup runs without orphaning containers /
      volumes.

### C. Restore-completeness verification

- [ ] **C1.** Account count in restored DB matches production account
      count (or count from snapshot manifest).
- [ ] **C2.** Sample 5 random accounts — restored profile counts + API
      key counts match production for each.
- [ ] **C3.** R2 object count match — sample 10 random object keys from
      the production listing and verify presence in the restored bucket
      (or skip if R2 not restored in rehearsal mode, which is the default
      since R2 is content-addressed + has its own multi-region durability).
- [ ] **C4.** Sub-processor configuration sanity — Postmark / Sentry /
      Stripe env vars are placeholders in rehearsal (NOT real production
      tokens). The rehearsal must NOT use production sub-processor
      credentials.

### D. Roll-forward decision

- [ ] **D1.** Latest production migration applies on top of the restored
      snapshot. If migration introduces a schema-incompatible change with
      pre-snapshot data, this rehearsal flags it before the production
      migration runs.
- [ ] **D2.** Rehearsal duration recorded — full A→C path should
      complete in under 5 minutes. Above 10 min indicates infra drift
      that future restore SLAs may breach.

### E. Post-rehearsal cleanup

- [ ] **E1.** Rehearsal containers + volumes destroyed.
- [ ] **E2.** Temp files in `/tmp/dr-rehearse-*` cleaned.
- [ ] **E3.** Checklist results logged with date + pass/fail per item to
      `docs/runbooks/incidents.md` OR a fresh
      `docs/runbooks/dr-rehearsal-history.md` (creates if missing).

## Pass/fail criteria

The rehearsal **PASSES** when every B + C item ticks. A and D items are
informational — they may legitimately not apply (e.g. D1 when no migration
is pending). E items are cleanup hygiene; failing one is an issue but
doesn't invalidate the rehearsal.

The rehearsal **FAILS** when any B or C item doesn't tick. Failure must
be logged with a root-cause note and a follow-up V-NNN slice to fix the
underlying issue before the next rehearsal.

## Automation target (V-542.B — later wave)

A scheduled BullMQ job runs the rehearsal weekly during pre-launch (then
quarterly post-launch). On completion:

- Pass: log to status page admin view "DR rehearsal passed YYYY-MM-DD".
- Fail: Postmark alert to admin email with the failing item + harness
  log tail.

Automation requires:

1. `scripts/dr-rehearse.sh` extended with structured pass/fail output
   (JSON to stdout) instead of just exit code.
2. Job runner (`apps/server/src/services/jobs/dr-rehearsal-job.ts`)
   invoking the script + parsing output + emitting alerts.
3. Migration adding `dr_rehearsal_log` table (date + pass/fail + harness
   log link).

Scope for V-542.B — out of scope for V-542 (this design wave).

## V-542.A this wave

This document is the V-542.A artifact. No code changes; the checklist is
the deliverable. V-542.B automates it. V-542.C (later) integrates the
results into the admin status surface.

## Verification

- File written.
- V-205 + V-211 regex sweep: zero hits.
- Cross-reference: `scripts/dr-rehearse.sh` exists at expected path.
