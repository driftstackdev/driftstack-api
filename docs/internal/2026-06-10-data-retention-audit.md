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

## GAPS — unbounded growth, no retention (SURFACED — retention-policy decision)

1. **`session_events`** (NEW, this audit). Per-session event rows; sessions are
   marked-destroyed (not deleted), so events are never cascade-removed, and the
   table is not in AUDIT_TABLES and has no prune/sweep. Potentially the
   fastest-growing table (every session × N events). Indexed by `session_id` so
   per-session reads stay fast, but the table grows unbounded → storage +
   backup/maintenance burden at scale.
2. **`scheduled_jobs`** finished rows (W415 #2). `completed_at`/`failed_at` set
   but never deleted/archived → accumulates. (The W416 partial index keeps the
   _claim_ O(due-unfinished) regardless, but storage still grows.)

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
