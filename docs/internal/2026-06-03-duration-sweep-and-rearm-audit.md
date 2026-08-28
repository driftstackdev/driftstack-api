# Session-duration sweep + self-re-arm audit (2026-06-03, Agent-2)

Fresh audit of `services/session-duration-sweeper.ts` (the free-tier 20-min session auto-destroy) and
the `services/scheduled-jobs.ts` poller that drives all self-re-arming background jobs. Verdict: the
sweep + poller are well-built; two **latent** findings are surfaced below (neither auto-changed — both
touch documented and/or incident-prone behavior, so they want a founder/maintainer call).

## Clean (don't re-audit)

- **Per-session destroy isolation:** `tickOnce` wraps each `autoDestroyExpired` in try/catch + logs, so a
  single stuck driver call doesn't abort the batch (the row stays eligible, retried next tick).
- **Cutoff math:** `durationCutoffsFor(now)` iterates the full `AccountTierSchema.options`, emitting a
  `(tier, now-maxMinutes)` cutoff only for tiers with a non-null `maxSessionMinutesFor`. A future capped
  paid tier is picked up automatically. Paid tiers (null cap) are never swept.
- **Transient-failure resilience:** if `tickOnce` throws (e.g. a DB blip on `listExpiredForAutoDestroy`),
  the poller's `runOne` retries the job with exponential backoff (`markRetry`) up to `maxAttempts`; a
  retry that succeeds reaches the re-arm, so a transient failure does not kill the chain. Only
  `maxAttempts` consecutive failures (a deep outage) end the chain, and bootstrap-on-restart recovers it.
- **Re-arm dedup posture:** the in-handler re-arm uses `dedup:false` deliberately (the still-locked,
  not-yet-completed current job would otherwise look like a pending duplicate and kill the chain) — the
  RESOLVED reasoning from the earlier dedup incident (`project_scheduled_job_rearm_dedup_bug`).

## Finding 1 — `minCapFor` records the wrong cap once a 2nd tier is capped (latent; documented in-code)

> ⚠️ **Still latent, and the precondition is now ENFORCED rather than described (V-1523,
> re-verified 2026-08-27).** `session-duration-sweeper.test.ts` carries a CRITICAL arm that
> reads `MAX_SESSION_MINUTES_PER_TIER`, filters to capped tiers, and reds the moment a second
> one appears — naming the consequence and the fix. So "no current incorrectness" is asserted
> by the suite, not left to a reader to re-check.

`tickOnce` resolves the destroy-event `max_session_minutes` payload as `minCapFor(cutoffTiers)` — the
**smallest** cap across all capped tiers — and applies it to **every** candidate, because the candidate's
own tier isn't carried on `SessionRecord`. Today only `free` is capped, so this is always `20` and
correct. The moment a second tier gets a cap (e.g. `free=20`, a paid tier`=60`), a 60-min-cap session
destroyed for exceeding its cap would record `max_session_minutes: 20` — misleading audit data.

The code comments already flag this ("kept general so a future second capped tier degrades safely"). The
accurate fix is to carry each candidate's tier (e.g. `listExpiredForAutoDestroy` returns `{row, tier}`)
so the payload uses the candidate's own cap — a repo-shape change + in-mem + parity. Deferred: it's
future-proofing a latent issue with no current incorrectness, so wiring it now would be churn. Do it
when/if a second tier gains a cap.

## Finding 2 — self-re-arm + `dedup:false` can fan out under a poller retry (latent; incident-prone area)

> ✅ **RESOLVED since — verified 2026-08-27 (V-2066), annotated here because this is the
> heading a reader stops at.** `dedup: false` no longer appears anywhere in `apps/server/src`.
> The re-arms pass `dedupOnAccountAndType: true` **plus** `dedupAfterRunAt: currentRunAt`, and
> the repo reads it — `gt(scheduledJobs.runAt, input.dedupAfterRunAt)` in the dedup predicate.
> That is this section's proposed fix in a run-time-cohort form rather than the by-id form
> suggested: the in-flight job (runAt ≤ current) is excluded so the re-arm is never blocked
> (the chain-death risk `dedup:false` existed for), while a prior pending successor (runAt >
> current) DOES collapse, so the retry in step 3 below creates no second chain. Applied to
> **16 self-re-arming services**, not only this one.

The self-re-arming jobs (duration-sweep, auth-tokens sweeper, …) run, inside one handler:
`await tickOnce()` → `await enqueueNext({ dedup:false })` → handler returns → poller `markComplete(job)`.
The re-arm's JSDoc argues it "can't fan out into duplicate chains" because "a single locked executor
processes this job, so one handler run produces exactly one next enqueue."

That reasoning is correct **per run** but **omits retries**. The poller (`runOne`) wraps
`handler(job); markComplete(job)` in one try/catch and `markRetry`s on any throw. So:

1. handler runs → re-arm creates job **B** → `markComplete(A)` **throws** (a transient DB error on the
   completing UPDATE, after the re-arm already succeeded);
2. `runOne` catches → `markRetry(A)` → job A runs **again**;
3. the retry's handler → re-arm creates job **C** → `markComplete(A)` succeeds.

Now **B and C both exist** and both re-arm forever (`dedup:false` never collapses them) → the sweep runs
at 2× cadence, and each subsequent such event adds another parallel chain. Rare trigger (requires a
throw _after_ the re-arm: `markComplete`, or any post-re-arm handler step), low blast radius (extra DB
load; the sweeps are idempotent), but the documented "can't fan out" claim is incomplete.

The robust fix unifies both the chain-death risk (why `dedup:false` exists) and this fan-out: make the
dedup query **exclude the currently-executing job by id** and switch the re-arm back to `dedup:true` — a
re-arm would then dedup against a _prior_ pending re-arm (B) but not against the in-flight job (A). That
is a change to the dedup repo logic + `enqueue` signature + every self-re-arming caller + the area of a
prior production incident, so it is **not** an autopilot auto-fix — it wants a deliberate maintainer
review. Surfaced here for that decision.
