# Data-retention / unbounded-growth audit (operational tables)

Maps which append-heavy tables have a retention mechanism vs grow unbounded.
Pre-launch tables are tiny so there's no current impact — this is a **pre-scale**
audit. Two gaps found (`session_events`, `scheduled_jobs`); the rest are covered.

## Covered (have a prune or archive)

| Table                                                                                   | Mechanism                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `system_health_probes`                                                                  | hourly prune, rows > 30 days (health-probe.ts pruneOlderThan)                          |
| `email_verify` / `magic_link` / `password_reset` tokens                                 | auth-flows-sweeper (deletes expired, per-kind)                                         |
| `admin_audit_log`, `processed_stripe_events`, `legal_acceptances`, `webhook_deliveries` | audit-archive → R2 JSONL+gzip then DELETE (AUDIT_TABLES, archiveTable per `olderThan`) |
| crypto-order idempotency dedup                                                          | in-memory 24h TTL prune                                                                |
| `web_sessions` / auth tokens                                                            | `expires_at` + sweeper                                                                 |

## GAPS — unbounded growth, no retention

1. ✅ **`session_events` — RESOLVED W438 (founder-delegated decision).** Added to
   `AUDIT_TABLES` (archive→R2 then delete past the 90-day hot window, keyed on
   `created_at`). It's an internal action log (created/navigated/…), NOT billing-
   or customer-read-critical (verified — nothing in billing/usage reads it), so
   archive (not hard-delete) preserves the forensic history cheaply in R2 while
   bounding the hot table. Uses the proven audit-archive pattern (repo cases +
   the monthly scheduler). Dormant pre-launch (no 90-day-old rows yet).
2. **`scheduled_jobs`** finished rows (W415 #2) — STILL OPEN. `completed_at`/
   `failed_at` set but never deleted → accumulates. Decision (W438): PRUNE (hard-
   delete finished rows older than N days) — low value, no archive needed (unlike
   session*events, scheduled_jobs has no forensic/customer value). Implement next
   wave (a prune query + a periodic tick). (The W416 partial index keeps the
   \_claim* O(due-unfinished) regardless.)

## Recommended fix (founder/A-team decision: period + delete-vs-archive)

Two established patterns already in the codebase — pick per table:

- **Archive→R2 then delete** (audit-archive pattern): extend `AUDIT_TABLES` +
  `archiveTable()` to the table (keys on a timestamp column). Best when the
  history has debugging/audit value (likely for `session_events` — session
  replay/forensics). Adds `session_events` (key on `created_at`, scoped to
  destroyed sessions) and/or `scheduled_jobs` (key on `completed_at`/`failed_at`).
- **Plain prune** (health-probe pattern): delete rows older than N days via a
  periodic tick. Simpler; best when history is purely transient.

Decisions needed: retention period (e.g. 30/90 days), and delete-vs-archive per
table (compliance/debugging value). Both are pre-launch non-urgent but should be
decided before meaningful traffic so the tables don't accumulate from day one.

No code changed here — retention is an irreversible-deletion policy choice, so
surfaced rather than auto-applied. The mechanisms to implement it both exist.

**W441 update:** `scheduled_jobs` finished-row retention RESOLVED — daily prune job (scheduled-jobs-prune-sweeper.ts) deletes completed/failed rows older than 30 days via repo.pruneFinished. Both retention gaps (session_events archive W438 + scheduled_jobs prune W441) now closed.
