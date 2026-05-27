# Auth-token sweeper runbook

The sweeper periodically DELETEs stale rows from the three auth-flow
token tables (`email_verify_tokens` / `magic_link_tokens` /
`password_reset_tokens`). Lives at
`apps/server/src/services/auth-flows-sweeper.ts`.

Context: the 2026-05-20 stale-row audit
(`docs/internal/2026-05-20-stale-row-audit.md`) flagged that
`consumeAuthToken()` only marks rows as consumed; nothing currently
deletes them. Same shape of bug as the 2026-05-19 `scheduled_jobs`
accumulation incident but pre-scale (~10 rows at 10 customers;
~70K rows at 10K).

## Retention policy

- **Consumed rows**: kept ≥30 days post-consumption. Forensic window
  for support tickets ("the magic link expired but I clicked it"
  diagnostics still work).
- **Expired-but-unconsumed rows**: kept ≥7 days post-expiration.
  Covers the typical retry window — customer abandons + comes back
  later via the same email link.

Configure via the `consumedRetentionDays` + `expiredRetentionDays`
options on `AuthTokensSweeperService` constructor; defaults match
the policy above.

## Operations

### Automatic periodic sweep (scheduled job — wired)

The sweep runs automatically. `bootstrap.ts` registers the
`auth_tokens.sweep` scheduled job (`registerAuthTokensSweepJob` +
`enqueueNextAuthTokensSweep`) at startup; it fires **daily at 03:00
UTC** (low-traffic window) and re-arms itself after each successful
run. No operator action is required for normal retention.

Each run logs (`component: "auth-tokens-sweep"`) the deletion counts —
the service's `tickOnce(now)` returns:

```ts
{
  deletedByKind: {
    email_verify: number;
    magic_link: number;
    password_reset: number;
  }
  totalDeleted: number;
}
```

To confirm the job is scheduled and when it last/next runs, inspect the
`scheduled_jobs` table:

```sh
ssh root@128.140.37.74 "set -a; source /opt/driftstack/api/.env; set +a; psql \$DATABASE_URL -At -c \"
SELECT job_type, status, run_at, last_run_at FROM scheduled_jobs WHERE job_type = 'auth_tokens.sweep' ORDER BY run_at DESC LIMIT 5;
\""
```

### Forcing an immediate sweep

There is **no one-shot CLI script** for an ad-hoc sweep (a prior
reference to one was aspirational and was never built — running an
untested DELETE against prod from a throwaway script is deliberately
avoided). If an immediate sweep is genuinely
needed before the next 03:00 UTC run, advance the pending row's
`run_at` to now so the poller picks it up on its next tick:

```sh
ssh root@128.140.37.74 "set -a; source /opt/driftstack/api/.env; set +a; psql \$DATABASE_URL -c \"
UPDATE scheduled_jobs SET run_at = now() WHERE job_type = 'auth_tokens.sweep' AND status = 'pending';
\""
```

The job re-arms to the normal 03:00 UTC cadence after it runs.

## Investigation: how many stale rows are out there right now?

```sh
ssh root@128.140.37.74 "set -a; source /opt/driftstack/api/.env; set +a; psql \$DATABASE_URL -At -c \"
SELECT 'magic_link_total', count(*) FROM magic_link_tokens
UNION ALL SELECT 'magic_link_consumed_>30d', count(*) FROM magic_link_tokens WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '30 days'
UNION ALL SELECT 'magic_link_expired_>7d', count(*) FROM magic_link_tokens WHERE consumed_at IS NULL AND expires_at < now() - interval '7 days'
UNION ALL SELECT 'email_verify_total', count(*) FROM email_verify_tokens
UNION ALL SELECT 'email_verify_consumed_>30d', count(*) FROM email_verify_tokens WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '30 days'
UNION ALL SELECT 'email_verify_expired_>7d', count(*) FROM email_verify_tokens WHERE consumed_at IS NULL AND expires_at < now() - interval '7 days'
UNION ALL SELECT 'password_reset_total', count(*) FROM password_reset_tokens
UNION ALL SELECT 'password_reset_consumed_>30d', count(*) FROM password_reset_tokens WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '30 days'
UNION ALL SELECT 'password_reset_expired_>7d', count(*) FROM password_reset_tokens WHERE consumed_at IS NULL AND expires_at < now() - interval '7 days';
\""
```

## Risk model

Low. The DELETE is bounded by the retention policy (no row is
deleted within 7 days of expiration or 30 days of consumption).
Wrong cutoff → harmless data loss (rows that were already
inaccessible at the application layer). Worst-case rollback: STOP
the sweeper job (since the deletion is irrecoverable). No prod
impact pre-rollback because the application layer never reads
these rows anyway.

## References

- `apps/server/src/services/auth-flows-sweeper.ts` — service impl.
- `apps/server/src/db/auth-flows-repo.ts` — `deleteStaleAuthTokens`
  Drizzle query.
- `docs/internal/2026-05-20-stale-row-audit.md` — original audit.
- `apps/server/tests/unit/services-auth-flows-sweeper.test.ts` —
  unit tests (4 cases).
