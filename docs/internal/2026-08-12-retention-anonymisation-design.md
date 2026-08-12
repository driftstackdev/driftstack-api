# V-748 retention implementation — design record (2026-08-12)

Privacy-policy §9 discloses two deletions that nothing performs:

| Category                                            | Disclosed                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Authentication data (hashed API keys, key metadata) | "Until revocation; revoked records retained 90 days for audit **then deleted**."                     |
| Session metadata                                    | "**90 days operational**; aggregated counters (no PII) retained indefinitely for capacity planning." |

The decision was taken to honour them rather than amend the disclosure. Investigating how
to do that produced a finding that **changes the implementation**, and this record exists
so nobody writes the naive version.

## Both literal row deletions are structurally impossible

Enumerated every foreign key pointing at the two tables:

**→ `sessions.id`** — `session_events` cascade, `session_operations` cascade,
`agent_sessions` set null, and **`usage_records` CASCADE**.

**→ `api_keys.id`** — `oauth_access_tokens` cascade, `account_audit_log` set null, and
**RESTRICT** from `sessions`, `admin_audit_log`, `rate_limit_overrides`, `incidents`,
`incident_updates`.

### Deleting a session would destroy tax-mandated billing data

`usage_records.session_id` cascades. So purging a 90-day-old session row would delete its
usage records — and §9's own table requires **"Billing data | 7 years post-transaction
(Dutch tax law, AWR Art 52)"**. A naive session purge would therefore breach a 7-year
statutory retention obligation in order to satisfy a 90-day one. That is strictly worse
than the gap it closes.

### Deleting a revoked API key is blocked by design

Five RESTRICT references, and `admin_audit_log` is the decisive one: audit rows outlive the
key by years, and the RESTRICT exists precisely so an audit entry can never point at a
vanished actor. `sessions` was the constraint noted when V-748 was first written; it is not
the binding one. Even with sessions purged first, the key cannot be deleted.

## Resolution: anonymise in place — which §9 already authorises

§9's closing paragraph, verbatim:

> When the retention period for a category expires, Driftstack deletes the Personal Data
> **or anonymises it** (rendering it no longer attributable to a Data Subject). Anonymised
> aggregates may be retained for capacity planning.

So anonymisation is not a workaround, it is the disclosed alternative — and the
"aggregated counters retained indefinitely" clause in the Session-metadata row is
explicitly satisfied by keeping the row while scrubbing what identifies it.

### Planned shape

| Table                | Action past the window                                                                                                                   | Cutoff basis                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `session_operations` | **DELETE** rows — nothing references this table, so it is FK-safe, and `request_fingerprint` / `result` / `error` are the payload traces | parent session's `destroyed_at`       |
| `sessions`           | **SCRUB** `purpose` (notNull → sentinel), `label`, `metadata`; keep the row so `usage_records` survive                                   | `destroyed_at` (never a live session) |
| `api_keys`           | **SCRUB** `name` (customer-supplied), `key_hash` (credential material, pointless to keep for years); keep the row for audit attribution  | `revoked_at`                          |

Cutoff basis for sessions is `destroyed_at`, deliberately: a session that has not ended is
never touched, and "90 days operational" most defensibly runs from when the session stopped
being operational. Rows with a NULL `destroyed_at` are the duration-sweeper's and the
orphan-sweeper's business, not this one's.

`purpose`, `request_fingerprint`, `name`, `key_prefix` and `key_hash` are all `notNull`, so
scrubbing writes a sentinel rather than NULL. The sentinel must be recognisable in a
support conversation ("this was scrubbed on schedule", not "this was corrupted").

### Implementation constraints to carry over

Follow the established sweeper shape rather than inventing one —
`crypto-entitlement-expiry-sweeper.ts` is the closest model: `olderThan` cutoff, batch
limit with an honest `capped` signal, per-account isolation so one failure cannot strand
the rest, a re-check under the row lock rather than trusting the scan snapshot (#79), loud
alarms, and registration through `scheduledJobs.register` with a self-re-arming enqueue.

Two guards this needs that the existing sweepers do not:

1. **A test proving nothing INSIDE the window is touched.** The whole risk of this change is
   over-deletion, and it is irreversible.
2. **A test proving `usage_records` SURVIVE a session scrub.** That is the specific
   catastrophe this design exists to avoid, so it must be pinned, not merely intended.

## Status

Design settled; implementation deliberately not rushed into the same turn as the analysis,
because the change is irreversible and the analysis changed its shape twice.
