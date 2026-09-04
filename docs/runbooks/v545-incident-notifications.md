# V-545 incident notification runbook (operator)

Closes the loop on the V-545.A status surface + V-545.B subscriber
notification chain so the on-call operator knows what an
incident post + update + resolve will send to whom.

## Surface (live as of 2026-05-16)

| Endpoint                               | Auth  | Purpose                                                     |
| -------------------------------------- | ----- | ----------------------------------------------------------- |
| `GET /v1/status`                       | none  | Overall + components + top-5 public incidents (V-545.A)     |
| `GET /v1/status/incidents`             | none  | List of public incidents, 30d window, 30s Cache-Control     |
| `GET /v1/status/incidents/:id`         | none  | Detail + full update timeline, 30s Cache-Control            |
| `POST /v1/admin/incidents`             | admin | Create incident → fan-out (`status-incident-created`)       |
| `POST /v1/admin/incidents/:id/updates` | admin | Post update → throttled fan-out (`status-incident-updated`) |
| `POST /v1/admin/incidents/:id/resolve` | admin | Resolve → fan-out (`status-incident-resolved`)              |

## Subscriber lifecycle

- Subscribers opt in at `https://status.driftstack.io/subscribe` →
  `status-subscription-confirmation` email → click the link →
  `status-subscription-welcome`.
- Once confirmed, the subscriber gets:
  - `status-incident-created` — once per public incident at creation.
  - `status-incident-updated` — **at most once per subscriber per
    incident per hour** (V-545.B Phase 2 throttle).
  - `status-incident-resolved` — once per public incident at resolve.
- Each email carries a per-recipient one-time unsubscribe link
  (token rotated per send).

## V-545.B Phase 2 throttle, in plain words

The on-call operator can post multiple updates back-to-back during
a fast-moving incident without flooding subscribers. The
`incident_update_notifications` table records `(subscriber_id,
incident_id, last_sent_at)`. Before each `status-incident-updated`
send, the service consults this table and skips when
`now - last_sent_at < 1h`.

Empirical proof (test `apps/server/tests/integration/incident-notifications.test.ts`,
"throttles a second update within the 1-hour window"):

```
post update #1 → subscriber gets 1 'updated' email
post update #2 (immediately)  → no email sent (throttle)
final email count: 1
```

The throttle is per (subscriber, incident); a different subscriber
or a different incident is independent.

## What an operator should expect when posting an update

| Subscribers (confirmed) | Updates posted this hour | Updates posted hour-ago+1 | Emails sent for this update |
| ----------------------- | ------------------------ | ------------------------- | --------------------------- |
| 100                     | first one                | —                         | 100                         |
| 100                     | second within 1h         | —                         | 0 (all throttled)           |
| 100                     | second after 1h          | —                         | 100                         |

The batch summary in the api server log carries the breakdown:

```
{"component":"incident-notifications","kind":"updated","incidentId":"…","ok":100,"failed":0,"throttled":0,"msg":"fan-out complete"}
```

When `ok=0,throttled=100`, the operator has been hammering updates
faster than the throttle window — that's by design, not a regression.

## Quick verification (post-deploy)

```sh
# 1. Are the routes registered?
curl -fsS -I https://api.driftstack.dev/v1/status/incidents | grep -i cache-control
#  expected: cache-control: public, max-age=30
curl -fsS -o /dev/null -w '%{http_code}\n' https://api.driftstack.dev/v1/status/incidents/inc_00000000-0000-0000-0000-000000000000
#  expected: 404 (route registered, incident not found)

# 2. Is the throttle migration applied?
ssh root@128.140.37.74 'sudo -u driftstack bash -c "set -a; source /opt/driftstack/api/.env; set +a; psql \$DATABASE_URL -tA -c \"SELECT to_regclass(\\'public.incident_update_notifications\\')::text;\""'
#  expected: incident_update_notifications

# 3. The smoke (read-only):
bash scripts/post-deploy-verify.mjs --base-url https://api.driftstack.dev
#  expected: 10/10 OK (includes /v1/status recent_incidents shape +
#  /v1/status/incidents/:id route registration + /v1/admin/cost/config
#  V-541.B gate)
```

## Cross-references

- V-545.A surface + V-545.B implementation phases: `docs/internal/v545-status-page-enhancements.md`
- Sub-processor RSS feed: `apps/marketing-site/src/pages/trust/sub-processors/feed.xml.ts`
- Postmark templates: `apps/server/src/services/email.ts` (search for `status-incident-`)
- Throttle repo: `apps/server/src/db/incident-update-notifications-repo.ts`
