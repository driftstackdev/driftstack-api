# 2026-05-31 — Webhook delivery: orphaned `in_flight` rows are never reclaimed (Agent 2 audit)

**Status: SURFACED, not fixed.** Real medium-severity reliability gap found during
an autopilot fresh-audit of the webhook-delivery worker. The fix touches the
delivery hot path with a subtle stale-threshold consideration, so it warrants a
careful, tested change (ideally a focused session) rather than a deep-session
hot-path edit.

## The gap

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

Prerequisites / notes:

- The reclaim clock is `updated_at`. The `webhooks-repo` claim sets
  `updated_at = NOW()` on the `in_flight` flip; the **durable path's
  `.set({ status: 'in_flight' })` may NOT bump `updated_at`** (depends on a
  Drizzle `$onUpdate` on the column) — verify/ensure it does, else the
  threshold has no reliable clock.
- Add an index on `(status, updated_at)` (the existing
  `webhook_deliveries_worker_idx` is `(status, next_attempt_at)`) if the reclaim
  predicate isn't index-covered.
- Test: a real-PG (`*-drizzle`) test seeding an `in_flight` row with an old
  `updated_at` and asserting the next claim reclaims + redelivers it; plus one
  asserting a _fresh_ `in_flight` row is NOT reclaimed (no double-delivery).
- Decide one path: there are two delivery impls; the reclaim belongs in whichever
  is the active prod path (and ideally both, or consolidate).

Not auto-fixed: hot-path + duplicate-delivery subtlety + needs a real-PG
crash-recovery test. Captured in memory as `project_webhook_orphaned_inflight_reclaim_gap`.
