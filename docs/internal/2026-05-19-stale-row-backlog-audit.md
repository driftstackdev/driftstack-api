# Stale-row backlog audit (2026-05-19)

## Trigger

Per FULL AUTOPILOT directive Tier-2 backlog slice "audit prod tables
for stale scheduled-jobs row backlog (10 days of accumulation)" — the
2026-05-09 → 2026-05-19 silent drizzle-orm transparentParser
TypeError window in scheduled-jobs-poller (root cause + fix landed
in `1b2001c8`) + the parallel durable-webhook-delivery instance
(fixed in `5d7fe344`).

## Question

Do the prod + staging databases carry orphan rows from the broken
window (e.g. scheduled jobs that never claimed; webhook deliveries
stuck in `pending` past their `next_attempt_at`; atlas-priority
events stranded mid-emit)?

## Method

Read-only count queries against the prod (root@128.140.37.74) and
staging (root@116.203.22.197) live databases. SSH'd to each host;
sourced `/opt/driftstack/api/.env` in subshell scope (per the
deploy-bridge `c7395e28` pattern); ran `psql -At -c "SELECT
COUNT(*) ..."` (prod) and a Node + postgres-js script (staging —
psql doesn't parse `&channel_binding=require` in URI query
parameters and the staging DB URL carries that flag).

Credential discipline: DB URL never echoed to stdout / commit /
V-log; only count integers + table names surfaced.

## Findings

### Prod (existing Neon project)

| Table                   | Row count |
| ----------------------- | --------- |
| `scheduled_jobs`        | 0         |
| `webhook_deliveries`    | 0         |
| `atlas_priority_events` | 2         |
| `agent_sessions`        | 0         |
| `sessions`              | 0         |
| `accounts`              | 8         |

Targeted stale-row queries returned 0 for both:

```sql
SELECT COUNT(*) FROM scheduled_jobs
  WHERE run_at < now() - interval '24 hours'
    AND completed_at IS NULL AND failed_at IS NULL;
-- 0

SELECT COUNT(*) FROM webhook_deliveries
  WHERE status = 'pending'
    AND next_attempt_at < now() - interval '24 hours';
-- 0
```

### Staging (new Neon project `ep-lingering-math-alnalhby`)

| Table                   | Row count |
| ----------------------- | --------- |
| `scheduled_jobs`        | 0         |
| `webhook_deliveries`    | 0         |
| `atlas_priority_events` | 0         |
| `accounts`              | 0         |

Fresh per ARC 2 staging-DB-isolation cutover (2026-05-19).

## Conclusion

NO stale-row backlog exists on either environment. The 10-day
silent Date-param TypeError window had zero customer impact because
there were no real customers driving traffic — the 8 prod accounts
are founder + synthetic test rows; none generated scheduled-job or
webhook-delivery work that was stranded.

The fix commits (`1b2001c8` scheduled-jobs-repo Date → ISO string
pre-serialize; `5d7fe344` durable-webhook-delivery same pattern;
`d9417a91` structural drift guard preventing regression) are
pure-prevention against post-launch traffic. No catch-up / clean-up
work needed pre-launch.

## Follow-ups (no action needed pre-launch)

- After v1.0 launch — re-run this audit at 7d + 30d cadence to
  catch any drift-guard false negative on future raw-sql Date
  interpolations.
- Consider adding a Prometheus `driftstack_scheduled_jobs_stale_total{}`
  gauge that counts rows matching the staleness criteria above; alert
  if non-zero for >1h. Track as Tier-2 ops slice.
