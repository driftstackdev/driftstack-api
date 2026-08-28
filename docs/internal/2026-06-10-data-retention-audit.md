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
| crypto-order idempotency dedup                                                          | in-memory 24h TTL prune (crypto-orders.ts pruneIdempotency)                            |

## GAPS — unbounded growth, no retention

1. ✅ **`session_events` — RESOLVED W438 (founder-delegated decision).** Added to
   `AUDIT_TABLES` (archive→R2 then delete past the 90-day hot window, keyed on
   `created_at`). It's an internal action log (created/navigated/…), NOT billing-
   or customer-read-critical (verified — nothing in billing/usage reads it), so
   archive (not hard-delete) preserves the forensic history cheaply in R2 while
   bounding the hot table. Uses the proven audit-archive pattern (repo cases +
   the monthly scheduler). Dormant pre-launch (no 90-day-old rows yet).
2. ✅ **`scheduled_jobs`** finished rows (W415 #2) — **RESOLVED W441** (see the
   W441 update below; annotated here too because a reader of this list stops at the
   bullet). Historical statement follows. `completed_at`/
   `failed_at` set but never deleted → accumulates. Decision (W438): PRUNE (hard-
   delete finished rows older than N days) — low value, no archive needed (unlike
   session*events, scheduled_jobs has no forensic/customer value). Implement next
   wave (a prune query + a periodic tick). (The W416 partial index keeps the
   \_claim* O(due-unfinished) regardless.)

3. **`web_sessions`** — **OPEN, found 2026-08-27 (V-2059).** Was listed in the
   Covered table above as "`expires_at` + sweeper"; the row has been removed because
   neither half held as a unique claim: the auth-token half duplicates the
   auth-flows-sweeper row, and **no code path deletes a `web_sessions` row.** Measured
   over the 342 `.ts` files under `apps/server/src` by a census of every
   `.delete(<ident>)` call site (53 distinct identifiers, including the known
   positives `scheduledJobs` and `systemHealthProbes`, and the dynamic `t` =
   `tableForKind(kind)` serving the three auth-flow token tables): `webSessions` does
   not appear, and a NUL-safe sweep for `DELETE FROM web_sessions` and a scan of
   `apps/server/migrations` for a partition/TTL policy both return zero. All 60
   `webSessions` references are `.insert`/`.update`/`.select`; revocation sets
   `revoked_at`, and expiry is enforced at READ time (`gt(expiresAt, now)` in
   `auth-repo`, `auth-flows-repo`, `mfa-repo`) rather than by deletion. The only
   reclamation is `onDelete: 'cascade'` from `accounts`, which bounds rows for
   _deleted_ accounts only. TTL is 30 days (`AUTH_TOKEN_TTL_MS.webSession`), so a row
   is dead weight 30 days after mint and kept forever — one row per login per device.
   Same shape as the 2026-05-19 `scheduled_jobs` incident and the 2026-05-20 stale
   auth-token audit, whose sweeper header does the arithmetic: "~10 rows at 10
   customers; ~70K rows at 10K". Retention period and delete-vs-anonymise are an
   owner's call per the heading below; the measurement is not.

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

**W441 update:** `scheduled_jobs` finished-row retention RESOLVED — daily prune job (scheduled-jobs-prune-sweeper.ts) deletes completed/failed rows older than 30 days via repo.pruneFinished. Both retention gaps KNOWN AT THE TIME (session_events archive W438 + scheduled_jobs prune W441) closed. **That completeness claim did not hold:** `web_sessions` sat in the Covered table unverified until V-2059 (2026-08-27) — see GAPS item 3.

---

## Re-audit 2026-08-07 — different lens: DISCLOSED promises vs implementation

The audit above asks "which append-heavy table grows unbounded". This pass asks the
narrower compliance question: **for each row of privacy-policy.md §9, does code
actually perform the deletion it discloses?** Three findings; none of them
contradicts the above, because none of these tables was in its scope.

### 1. Revoked API keys are never deleted (disclosed: 90 days)

§9: "Authentication data (hashed API keys, key metadata) | Until revocation;
revoked records retained 90 days for audit **then deleted**."

There is no deletion path for `api_keys` anywhere — not in the db layer
(`.delete(apiKeys)` does not exist), not in raw SQL, not in any sweeper, and not at
the DB level (no `pg_cron`, no retention job in any migration). `revokeAllForAccount`
sets `revoked_at`; the row persists indefinitely. Data at stake is pseudonymous
(customer-supplied `name`, `key_prefix`, `key_hash`, `last_used_at`), so the exposure
is a policy breach rather than a plaintext-credential leak.

### 2. Session metadata is never deleted (disclosed: 90 days operational)

§9: "Session metadata | 90 days operational; aggregated counters (no PII) retained
indefinitely for capacity planning."

Neither `sessions` nor `session_operations` has any deletion path. `sessions` carries
customer free text (`purpose`, `label`, `metadata`) and `session_operations` carries
`request_fingerprint` / `result` / `error`, so this is behavioural content, not just
counters — the "aggregated counters" clause does not cover it. Note the
account-termination purge does NOT help: `deleteAccount` only flips
`accounts.status = 'deleted'`, so the `onDelete: 'cascade'` FKs on `accounts.id`
never fire.

### 3. Why (1) was almost certainly never built — the two are coupled by an FK

`sessions.api_key_id → api_keys.id` is **`onDelete: 'restrict'`**. Postgres therefore
_refuses_ to delete a revoked API key while any session row references it. So the
90-day key deletion is not independently implementable: **sessions must be purged
first**, then the keys become deletable. Any implementation has to do them in that
order (or change the FK, which loses the attribution the `restrict` protects).

### Stale-audit note

`session_operations` landed **2026-07-31** (migration 0108) — seven weeks AFTER this
audit was written. It is append-heavy, account-scoped, and has no retention
mechanism: precisely the class this document exists to catch, added after the last
sweep. Treat the "the rest are covered" line above as scoped to 2026-06-10.

### V-759 update 2026-08-14 — all three 2026-08-07 findings RESOLVED

`retention-scrub-sweeper.ts` + `db/retention-scrub-repo.ts` landed **2026-08-12**, after
the re-audit above was written. Verified against the code, not against a changelog:

- **Finding 1 (revoked API keys)** — covered. The sweep's third step reaches keys.
- **Finding 2 (session metadata)** — covered. Second step, `sessions`.
- **Stale-audit note (`session_operations`)** — covered. First step, and the fixed
  order (operations → sessions → keys) is load-bearing: operations are found
  _through_ their session, so scrubbing the session first would orphan them.

Resolved by **anonymisation for `sessions` and `api_keys`, deletion for
`session_operations`** — which is why the "deliberately NOT implemented" section
below reads as still-open and is not. The split is deliberate, not incidental:
an operation row is not required by any longer-lived record, so it can go; a
session row cannot. That section's own
reasoning is what the design answers:

- deleting a session would take its `usage_records` with it, and §9's table requires
  those kept for **7 years**;
- finding 3 above — the `sessions.api_key_id → api_keys.id` `onDelete: 'restrict'`
  coupling — makes a revoked key undeletable while any session references it.

§9's closing paragraph authorises the alternative: personal data is deleted or
anonymised, and non-identifying aggregates may be retained. Keeping the row and
scrubbing the customer-supplied fields to `[scrubbed: retention]` satisfies the
disclosure without destroying the seven-year billing record. Window is 90 days,
matching the disclosed promise.

Design record: `docs/internal/2026-08-12-retention-anonymisation-design.md`.

The founder decision the section below asks for was therefore taken — the third way,
neither "implement the deletions" nor "amend §9". Left in place rather than deleted
because the reasoning still explains why a _deletion_ sweeper was the wrong shape.

### Deliberately NOT implemented — needs a founder decision

Two legitimate resolutions, and choosing is not an engineering call:

- **implement** the deletions (sessions+operations first, then revoked keys), or
- **amend** the disclosed §9 wording to match what the system actually does.

I did not write a data-deletion sweeper: deleting customer rows is irreversible, a
bug in it destroys data with no recovery, and it needs a deliberate ordering design
around the `restrict` FK. Amending a published privacy policy is a legal decision.
Flagged rather than actioned.
