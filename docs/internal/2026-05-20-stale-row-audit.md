# Stale prod row backlog audit (2026-05-20)

**Trigger:** 2026-05-19 prod incident — `scheduled_jobs` table
accumulated stale `pending` rows across ~10 days (sweep never
deleted completed-or-failed entries). The downstream
`TypeError` in the poller surfaced after enough rows piled up.
Surfaced via journalctl during prod-cleanup. This audit checks
the rest of the schema for the same class of bug:
**tables whose rows have a natural TTL but no sweeper.**

## Findings — prod DB at 2026-05-20 04:00 UTC

Counts via `psql` over `DATABASE_URL` on prod CPX32:

| Table                       | Total | "Stale" subset          | Stale count | Notes                                                            |
| --------------------------- | ----- | ----------------------- | ----------- | ---------------------------------------------------------------- |
| `scheduled_jobs`            | 0     | (cleaned post-incident) | 0           | FIXED — was the 2026-05-19 incident; table now drained.          |
| `webhook_deliveries`        | 0     | created_at < now()-7d   | 0           | Archive-eligible via V-163 AuditArchiveService.                  |
| `webhook_delivery_attempts` | 0     | n/a                     | n/a         | Sub-table; will accumulate when webhooks fire.                   |
| `magic_link_tokens`         | 3     | expires_at < now()      | **3**       | **100% expired** — no sweeper. Same class as scheduled_jobs.     |
| `email_verify_tokens`       | 7     | expires_at < now()      | **7**       | **100% expired** — no sweeper.                                   |
| `password_reset_tokens`     | 0     | expires_at < now()      | 0           | Empty today; same shape as above when populated.                 |
| `account_audit_log`         | 22    | (no archival yet)       | n/a         | Not in V-163 AUDIT_TABLES list — but small + intentional ledger. |
| `admin_audit_log`           | 0     | created_at < now()-90d  | 0           | Archive-eligible via V-163.                                      |
| `audit_archive_runs`        | 0     | n/a                     | n/a         | Ledger table; grows monotonically (one row per archive sweep).   |

## Root cause of token accumulation

`apps/server/src/db/auth-flows-repo.ts:174` — `consumeAuthToken`
sets `consumedAt` but never DELETEs. `findActiveAuthToken`
filters by `consumedAt IS NULL AND expires_at > now()`, so the
consumed/expired rows are invisible at the application layer
but stay in Postgres forever.

The expiry index exists
(`magic_link_tokens_expires_idx` on `expires_at`) so a sweep
query is cheap; we just don't run it.

## Risk model

At 10 customers today: 10 rows total = negligible.

Projecting (rough):

- 1,000 customers, avg 7 verify tokens during lifecycle =
  ~7,000 rows + however many magic-link signins they perform.
- 10,000 customers, similar math = ~70,000+ rows growing with
  signin frequency.
- Each row carries `requested_from_ip` + `consumed_from_ip` +
  full token hash → ~200 bytes; 100K rows ≈ 20MB. Not a
  storage emergency.
- The real risk is the same as scheduled_jobs: a query that
  scans the table without a covering index degrades silently
  as the table grows; we only notice when something
  user-visible breaks.

Not launch-blocking (small absolute counts; no current
performance signal). Pre-1.0 priority should be a single
shared "expired-token sweeper" job that DELETEs from all
three token tables on a daily cadence, recorded into the
existing scheduled_jobs surface so observability is uniform.

## Recommended follow-up implementation

**Sweeper service** (~50 LOC + tests):

```ts
// apps/server/src/services/auth-flows-sweeper.ts
// Daily job: DELETE FROM <tokens> WHERE
//   consumed_at IS NOT NULL AND consumed_at < now() - INTERVAL '30 days'
// OR
//   consumed_at IS NULL AND expires_at < now() - INTERVAL '7 days'
// — keeps a small forensic window for support tickets ("the
// magic link expired but I clicked it") without unbounded growth.
```

Hook: same scheduled-jobs poller that runs other sweeps. Add
job_type `auth_tokens_sweep`; queue daily at 03:00 UTC. Verify
on staging first — token tables there have larger row counts
because of test traffic.

## Other tables checked for the same shape (clean)

- `idempotency_keys` — not present (the codebase uses
  in-memory + DB-backed deduplication on other surfaces, not
  a dedicated idempotency_keys table).
- `sessions` — schema scoped to active sessions; existing
  expiry sweep covers this surface (verified via
  `webSessions` table + cleanup query).
- `account_api_keys` — keys are revoked, not deleted; that's
  intentional for the audit trail (a revoked key's ID may
  still be referenced from old audit log rows). Different
  shape — not a sweeper candidate.

## No code changes accompany this doc

Audit-only; implementation tracked as a follow-up task. Slice
scope for this autopilot fire was the audit + finding doc; the
actual sweeper lift is ~1 hr (service + test + wire).
