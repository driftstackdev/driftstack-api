# 2026-05-31 — Cost-alert spurious rollover transition (FIXED) + clean audits (Agent 2)

Fresh correctness-track audit wave (pivoting off the security arc). One real fix
shipped; two live subsystems verified clean (recorded so future waves don't re-mine).

## FIXED — cost-alert dispatcher: state was not cycle-scoped

`services/cost-alert-dispatcher.ts` remembered each account's prior threshold state
in `lastState` keyed by **`account_id` alone**, ignoring the billing cycle. Threshold
state is inherently per-cycle (a new cycle resets spend), so at a cycle rollover an
account that ended the prior cycle over a threshold carried that stale `over-hard` /
`between-soft-and-hard` state into the new cycle — where spend is ~0 (`under-soft`).
`classifyTransition(over-hard, under-soft)` then fired a **spurious `resolved`**
alert on the new cycle's first run, for every previously-over-threshold account at
once (a burst of misleading "spend recovered" notifications that were really just the
cycle resetting).

Severity LOW — largely masked in practice by the documented in-memory posture
("deploys reset the memory"; deploys are ~daily while cycles are monthly, so the
process almost always restarts within a cycle → state already empty at rollover). But
a genuine logic flaw whenever the process outlives a cycle boundary.

**Fix:** track `lastCycle`; when `evaluate()` is called for a different
`billingCycle`, clear `lastState` first. The new cycle then starts with `prior=null`
→ `classifyTransition`'s first-run branch (alert only on a genuine over-threshold
reading, never a spurious `resolved`). Also bounds the in-memory map to one cycle's
accounts. Within-cycle transitions (including a legitimate same-cycle `resolved` when
spend actually drops) are unchanged. Two behavioral tests pin both: no spurious
cross-cycle `resolved`, and a real within-cycle `resolved` still fires. Content-parity
pins updated in the same commit (the `lastCycle` field + the cycle-reset guard + the
new `reset()` body).

## Verified clean — do NOT re-audit

- **SSE event bus + all 3 consumer routes** (`services/agent-session-event-bus.ts` +
  `agent-sessions` transcript stream / `account-notifications` / `status-stream`):
  the bus subscribe/unsubscribe prunes empty Sets and wraps each handler in
  try/catch; every consumer wires `cleanup()` (clearInterval + unsubscribe +
  `reply.raw.end()`) to BOTH `req.raw.on('close')` and `'error'`, with
  `heartbeat.unref()`. No subscriber leak. The agent-sessions stream correctly uses
  `requireAuthEventSource` + an ownership check + a NaN-guarded Last-Event-ID resume.
- **Pagination `limit` caps**: every list query schema enforces
  `z.coerce.number().int().min(1).max(100)` (one admin crypto-orders list `max(500)`)
  — no uncapped-`limit` resource-exhaustion vector.

Recorded in memory `project_cost_alert_cycle_rollover`.
