# ADR-006 — Audit log retention + export

**Status:** Proposed (pending founder review)
**Date:** 2026-05-03
**Tier:** Architectural (workflow + storage decision; surfaces for review per Decision authority)
**Related V-entry:** V-095 (this proposal). Touches `admin_audit_log` (D-025), `processed_stripe_events` (V-080), `legal_acceptances` (V-046), `webhook_deliveries` (Phase 5).

## Context

The control plane writes several append-only audit-shaped tables in Postgres:

- **`admin_audit_log`** (D-025): every admin action — tier change, suspend / unsuspend, webhook delivery replay/requeue, rate-limit override set/clear. Captures who (admin account + key), what (action enum), against (target account or resource), with what input (sanitised payload), result (success or error code), and best-effort client IP.
- **`processed_stripe_events`** (V-080): inbound Stripe webhook idempotency ledger. event_id PK, event_type, payload SHA-256 hash, handler outcome, received timestamp.
- **`legal_acceptances`** (V-046): customer acceptance of ToS / Privacy / DPA / AUP. Append-only by service-layer convention; the schema doesn't enforce no-mutate.
- **`webhook_deliveries`** (Phase 5): outbound webhook delivery history — every attempt, response status, retry / DLQ outcome.

These tables grow unbounded today. Three problems:

1. **Cost**: Postgres hot storage at Neon's pricing (~$0.10/GB/mo on Pro plan) is fine for the first ~100k rows but compounds at scale. A high-volume webhook account writes ~30 events/day; 1000 customers × 30 events × 365 days = 11M rows/yr, ~5 GB at the conservative end.
2. **Query latency**: full-table scans on the audit tables degrade the admin-panel experience as rows accumulate. Indexes on (account_id, timestamp) help but don't eliminate.
3. **Compliance / customer-facing export**: customers under enterprise contracts will eventually request "export everything you have for my account in the last 12 months." A defined export format + retention SLA is needed; today neither exists.

## Decision

Adopt the following retention + archive + export model:

### 1. Hot retention (Postgres) — 90 days

The four audit-shaped tables retain rows for **90 days from the row's primary timestamp** (`timestamp` for admin_audit_log, `received_at` for processed_stripe_events, `accepted_at` for legal_acceptances, `created_at` for webhook_deliveries) in Postgres. Rows older than 90 days are eligible for archive.

90 days is the threshold because:

- Admin-panel queries ("what did I change last week?") realistically span at most 30 days.
- Stripe webhook re-delivery window is 3 days; idempotency lookup needs ~7 days hot to cover late re-deliveries.
- Customer-support inquiries about specific account state typically span 30-60 days.
- 90 days is short enough that hot-storage cost stays manageable (10s of GB at customer 1000) but long enough that hot-path queries don't fall through to archive on the common case.

### 2. Archive (Cloudflare R2) — JSON Lines, gzip-compressed

Rows past 90 days are exported to **R2 in JSON Lines format**, gzip-compressed, partitioned by `YYYY/MM/`:

```
audit-archive/
  admin_audit_log/2026/05/admin_audit_log_2026-05.jsonl.gz
  processed_stripe_events/2026/05/processed_stripe_events_2026-05.jsonl.gz
  legal_acceptances/2026/05/legal_acceptances_2026-05.jsonl.gz
  webhook_deliveries/2026/05/webhook_deliveries_2026-05.jsonl.gz
```

JSON Lines chosen over Parquet because:

- Human-readable when grepped (auditor-friendly).
- Streams cleanly through `gunzip | jq` for ad-hoc inspection.
- No schema-evolution friction (Parquet's column-level schema requires migration on every column add).
- File size delta vs Parquet at our volume is negligible after gzip.

### 3. Archive cadence — monthly sweep

> **⚠ V-865 — DECIDED, NOT IMPLEMENTED. This section describes a cadence that has never run.**
>
> `AuditArchiveService` was built (V-163) and its repo layer with it (V-172), but nothing invokes
> `archiveAll()`. It is not constructed in `bootstrap.ts`, no recurring job claims it, and
> `every-service-is-wired-or-recorded-as-dormant` lists it as dormant for exactly this reason.
> The original sentence carried an unfilled version placeholder while describing the sweep in the
> present tense — written prospectively, phrased as fact, and never true.
>
> **Nothing has been archived and nothing has been deleted.** No audit row has aged out of
> Postgres, and `session_events` — added to `AUDIT_TABLES` by W438 — grows without bound, because
> this dormant sweep is the only thing that would prune it. Read §4's seven-year SLA against that:
> the retention floor is met trivially, since no data has ever been removed. The ceiling is not.
>
> Enabling it is a data-destructive operation on a compliance surface and is recorded as an open
> operational decision (D-7), not an oversight to be quietly closed.

A monthly cron-driven service (`AuditArchiveService`) is designed to run on the 1st of each month at 02:00 UTC:

1. Selects rows older than 90 days from each audit table.
2. Streams them to R2 in batched 10k-row JSONL chunks (avoids loading entire result set into memory).
3. After successful R2 upload + checksum verification, DELETEs the archived rows from Postgres.
4. Records the archive run in a new `audit_archive_runs` ledger table for forensic recovery + debugging.

Failure modes:

- R2 upload fails → DELETE skipped. Next month's run retries the same window. No data loss.
- DELETE fails (FK constraint or transaction abort) → R2 file remains; Postgres rows remain hot. Next month attempts to archive the same window again; idempotent because the JSONL file overwrites.
- Partial archive (some rows archived, some still hot) → both queries still work; archive query union may double-count until the cleanup completes. Acceptable edge case for monthly cadence.

### 4. Retention SLA — 7 years

Archive files in R2 retain for **7 years**. Aligns with:

- Dutch BV bookkeeping retention requirements (fiscale bewaarplicht — 7 years for accounting records).
- GDPR right-to-erasure exceptions for compliance / legal-defense data (admin_audit_log records often relate to compliance + abuse investigations).
- Stripe + tax regulator expectations for transaction history.

After 7 years, files are deleted via R2 lifecycle policy. No customer-erasure request can override the 7-year retention for `admin_audit_log` (it's the audit ledger of the platform's own actions), but `legal_acceptances` purges with the account if the customer fully exits.

### 5. Export API — admin-only at launch, customer-facing later

**Phase 1 (launch)**: admin endpoint `GET /v1/admin/accounts/:id/audit-export?from=...&to=...` streams a JSONL response with all audit-shaped rows for the target account in the requested window. Admin scope only; rate-limited (one export per account per hour).

**Phase 2 (post-launch, on customer request)**: customer-facing endpoint `GET /v1/account/audit-export` for the calling account's own data. Same JSONL format, scoped to the calling account, additional rate limit.

Phase 1 lands as a follow-on V-NNN once this ADR is approved; Phase 2 lands when customer demand surfaces (likely with the first enterprise contract).

### 6. Customer-erasure interaction

When a customer fully exits (account deleted), the cascade is:

- `accounts.id` → CASCADE deletes hot Postgres rows (already in schema).
- Archive files retain unchanged for the 7-year window — they're customer-data-bearing but lawful per GDPR Art 17(3)(b) (legal obligation, accounting + AML retention).
- Customer can request export of their archive under the data-portability right; export streams from R2 + hot Postgres and returns JSONL.

### Why NOT a separate audit-event-store vendor (e.g. AWS QLDB, Vouch, Auditr)

- **Cost**: $50-200/mo at our scale for a service we can replicate with R2 + a 200-line archive script.
- **Sub-processor amendment cost** outweighs the marginal benefit at launch.
- **Vendor lock-in**: JSONL on R2 is portable; QLDB ledger format is not.
- **Audit data isn't crypto-immutable for us in practice** — Postgres rows + R2 SHA-256 checksums plus the monthly run ledger gives sufficient tamper-evidence for our compliance posture (Dutch BV, EU customers, Stripe-only payment rail). True crypto-anchored ledgers are needed for higher-bar regulated scenarios (banking, healthcare PHI) we don't operate in.

## When to revisit

- **Customer requests immutable cryptographic anchoring** (e.g. enterprise contract requires QLDB-equivalent audit trail).
- **Archive sweep takes >5 minutes** at production volume (currently estimated <30s for 11M rows/yr; if that breaks, switch from monthly to weekly cadence and parallelize per-table).
- **R2 storage cost exceeds Sentry log retention cost at the same window** — switch to using Sentry's structured-log archive instead of R2.
- **GDPR / DPA renegotiation** changes the 7-year retention requirement for any audit table.

## Operational notes

- **Archive ledger** (`audit_archive_runs`) — shipped in V-163; the table is in `schema.ts`. It has no rows, because the sweep that writes them has never run (see the V-865 note in §3):
  ```
  CREATE TABLE audit_archive_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    rows_archived integer NOT NULL,
    r2_object_key text NOT NULL,
    sha256_checksum text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    deleted_from_postgres boolean NOT NULL DEFAULT false
  );
  ```
- **Initial archive run on launch** seeds with rows older than 90 days from the launch date — no historical data accumulated yet, so first run is empty + sets up the cron schedule.
- **Sub-processor list unchanged** — R2 (Cloudflare) is already on the locked list.

## Decision authority

This is **architectural / workflow + storage** — surfaces for founder review per the Decision authority section in AGENTS.md. No new code lands until founder confirms the recommendation (or redirects on retention period, archive format, or vendor choice).
