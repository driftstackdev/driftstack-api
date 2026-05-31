# 2026-05-31 — Webhook delivery: orphaned `in_flight` rows are never reclaimed (Agent 2 audit)

**Status: FIXED 2026-05-31 — migration-free (no `claimed_at` column needed).** Real
medium-severity reliability gap found during an autopilot fresh-audit of the
webhook-delivery worker. Re-examination found the durable claim already sets
`updated_at = NOW()` on `pending → in_flight`, so `updated_at` IS the staleness
anchor — the reclaim needed no schema change (the migration was the only reason it
had been deferred to a focused pass).

## The fix (shipped)

- **Durable** (`db/webhooks-repo.ts::claim`): the claim SELECT now also matches
  `status = 'in_flight' AND updated_at <= now - RECLAIM_STALE_IN_FLIGHT_MS` (5 min,
  ≫ the 10s per-attempt timeout). Stuck in_flight rows are re-claimed (re-flipped to
  in_flight + `updated_at = NOW()`) and re-delivered. `FOR UPDATE SKIP LOCKED` keeps
  concurrent reclaimers off the same row. A merely-slow (not crashed) delivery can't
  be reclaimed (threshold ≫ timeout); a re-delivery is acceptable anyway — webhooks
  are at-least-once + event-id-dedupable.
- **In-memory** (`packages/webhook-delivery/src/in-memory.ts::processTick`): the due
  set is now `(pending & due & lease-ok) OR (in_flight & lease-expired)` — parity +
  defensive. (The processTick comment already promised "reclaimed by the next tick";
  this makes it true.)
- Tests: a real-PG drizzle test (`db-durable-webhook-claim-reclaim-drizzle`,
  CI-only) asserts a stale in_flight + a due pending are claimed while a FRESH
  in_flight is left alone; content-parity pins on both claim paths.

## The gap (historical)

Both outbound-webhook delivery implementations claim a due delivery by flipping
its status `pending → in_flight`, then deliver, then record the outcome
(`delivered` / back to `pending` for retry / `dlq`):

- `services/durable-webhook-delivery.ts:355` — `SELECT ... WHERE status = 'pending'
AND next_attempt_at <= now ... FOR UPDATE SKIP LOCKED`, then `UPDATE ... SET
status = 'in_flight'`.
- `db/webhooks-repo.ts:331` — same claim shape (`WHERE status = 'pending'`),
  `SET status = 'in_flight', updated_at = NOW()`.

**Neither claim ever selects `in_flight`, and there is no reclaim/sweeper that
resets a stale `in_flight` back to `pending`** (verified: every `in_flight`
reference in `apps/server/src` is the enum def, the two claim queries, or the
status type — none reset it; no startup recovery either).

So if the worker process dies — crash, OOM, **or a deploy's atomic swap** —
_after_ claiming a batch (rows now `in_flight`) but _before_ `deliver()` records
each outcome, those rows are stuck `in_flight` forever. They are never
re-claimed, never retried, never DLQ'd → the customer's webhook is **silently
lost**. This is worse than the intended contract: the system advertises
at-least-once with up to `MAX_ATTEMPTS=6` retries, but an orphaned `in_flight`
silently skips _all_ retries (effectively at-most-once-with-loss for that row).

Deploys make this non-theoretical: `scripts/deploy-bridge.sh` does an atomic
process swap, so a deploy landing mid-batch orphans whatever was `in_flight`.

## Proposed fix (design — needs care + a real-PG test)

Fold a **conservative** stale-`in_flight` reclaim into the claim predicate:

```sql
WHERE next_attempt_at <= now
  AND ( status = 'pending'
        OR (status = 'in_flight' AND updated_at < now - INTERVAL '<STALE>') )
```

Critical correctness constraint: **`<STALE>` must far exceed the longest
plausible live delivery** so a slow-but-alive delivery is never reclaimed and
double-delivered. The per-attempt timeout is 10s (`DELIVERY_TIMEOUT_MS`), so a
conservative threshold like **5–10 minutes** is safe (no single delivery runs
that long). Too-aggressive → duplicate deliveries (webhooks are signed +
at-least-once, so a dup is tolerable but undesirable; loss is worse, hence the
reclaim, but keep the threshold conservative).

## Design refinement (2026-05-31, deeper read) — the clock needs a NEW column

Initial design assumed an `updated_at < now - <STALE>` threshold. **That does not
work for the durable path** (`durable-webhook-delivery.ts`):

- `webhook_deliveries.updated_at` is `.default(now())` with **no `$onUpdate`**,
  and **none** of the durable path's status transitions set it (claim→`in_flight`
  :367, →`delivered` :498, →`dlq` :521, retry→`pending` :540 all omit
  `updatedAt`). So `updated_at ≡ created_at` always there — it does NOT mark when
  a row went `in_flight`. A threshold on it would reclaim by _creation_ age
  (wrong: an old row claimed seconds ago would be reclaimed → double-delivery).
- And `updated_at` is **load-bearing for the DLQ list keyset pagination**
  (`durable-webhook-delivery.ts:231` orders by `(updated_at desc, id desc)` —
  the recently-fixed cursor, see project_webhook_durable_cursor_keyset_fix).
  Making `updated_at` start advancing on transitions would silently **reorder
  that list** and shift cursors. So do NOT repurpose `updated_at` as the claim clock.
  (The `webhooks-repo.ts` path DOES set `updated_at = NOW()` on its claim, but it
  doesn't have the same DLQ-keyset coupling; the two paths differ here.)

**Revised fix:** add a dedicated nullable `claimed_at timestamptz` column
(migration), set it on the `pending → in_flight` flip, and reclaim on
`status='in_flight' AND claimed_at < now - INTERVAL '<STALE>'` (STALE still ≫ the
10s per-attempt timeout, e.g. 5–10 min). Index `(status, claimed_at)`. Leave
`updated_at`/DLQ-keyset untouched. This is migration-involving → confirmed a
focused (non-deep-autopilot-session) task.

Other notes:

- Test: real-PG (`*-drizzle`) — seed an `in_flight` row with old `claimed_at` →
  next claim reclaims + redelivers; a _fresh_ `in_flight` row is NOT reclaimed.
- Two delivery impls (`durable-webhook-delivery.ts` + `webhooks-repo.ts`/
  `webhook-worker.ts`); fix whichever is the active prod path (ideally both, or
  consolidate). Both lack reclaim today.

Not auto-fixed: migration + hot-path + duplicate-delivery subtlety + CI-only
real-PG test. Captured in memory as `project_webhook_orphaned_inflight_reclaim_gap`.
