# V-495 — Load-test methodology

Standing methodology for running load tests against the Driftstack
control plane. Pre-launch this is forward-looking; numbers shift
once real customer traffic shapes the workload.

## Tooling

`autocannon` (already in root `package.json` dev deps). Reasons:

- Pure-Node — no extra binary dependency on the Hetzner ops box.
- Outputs JSON summaries that integrate cleanly with downstream
  perf-tracking tooling.
- HTTP/1.1 + HTTP/2 support; pipelining knob for hot endpoints.
- Sensible defaults — picks up reasonable values for `connections`
  - `pipelining` if unspecified.

`k6` is the alternative when we need scripted multi-step scenarios
(login → mint API key → run sessions → collect timings). Not yet
wired; add as a future slice if scenario testing becomes
operationally required.

## Harness

`scripts/load-test/run.mjs`. Targets named in the harness:

| Target     | Method + path       | Auth? | Production-safe? |
| ---------- | ------------------- | ----- | ---------------- |
| `status`   | `GET /v1/status`    | No    | ✅ Yes           |
| `health`   | `GET /health`       | No    | ✅ Yes           |
| `version`  | `GET /version`      | No    | ✅ Yes           |
| `sessions` | `POST /v1/sessions` | Yes   | ❌ Staging only  |

Mutating endpoints (`sessions`, future `webhooks` create, etc.) refuse
to run against production unless the explicit
`--i-know-what-im-doing=true` flag is set. Customer traffic shouldn't
get drowned by load-test artifacts.

## Profile

Standing profile for a baseline run:

- **Warm-up**: 5-second 1-connection run, discarded. Fresh nginx +
  Fastify caches don't reflect steady state.
- **Ramp**: 5-second 5-connection run, recorded but not gated.
- **Sustained**: 30-second 10-connection run, recorded + the headline
  number.

For high-load probes (capacity planning), bump `connections` to
50/100/250 with `pipelining=10` and a 60-second duration. Monitor
Hetzner CPU + Postgres connection counts during the run; shed load
if Postgres `max_connections` is approaching the cap.

## Reporting

The harness emits a JSON summary on stdout:

```
{
  "target": "status",
  "env": "staging",
  "url": "https://staging.driftstack.dev/v1/status",
  "duration_seconds": 30,
  "connections": 10,
  "requests": {
    "total": 12345,
    "per_sec_avg": 411.5,
    "per_sec_p99": ...
  },
  "latency_ms": {
    "avg": 24.1,
    "p50": 22.0,
    "p90": 41.0,
    "p99": 88.0,
    "max": 320
  },
  ...
}
```

Pipe to `jq` for inspection or persist to `docs/load-test/baselines/`
for trend-tracking. p50 / p90 / p99 are the headline numbers; we look
at p99 + max to catch tail-latency regressions a p50 average would
hide.

## Safety rails

The harness refuses to:

- Run against production with a mutating target unless
  `--i-know-what-im-doing=true` is set.
- Run an auth-requiring target without `DRIFTSTACK_LOAD_TEST_API_KEY`
  exported. Use a dedicated **staging** key — never production.
- Run with `duration > 600` (10 min) by default. Long-duration runs
  go through a separate slice + scheduled window so on-call knows.

If a load test discovers a regression that's not reproducible from
the same harness with the same parameters, file an incident under
`docs/incidents/YYYYMMDD-load-test-anomaly.md` capturing:

- Harness parameters (`--target`, `--env`, duration, connections).
- Stdout summary JSON of the failing run.
- Server-side logs covering the run window (Sentry, Postgres slow
  query log, Pino).
- Cloudflare analytics for the run window (overload, 5xx flood).

## Baseline run — pre-launch (2026-05-10)

Captured before any customer traffic exists; numbers are
architectural-floor only.

### Target: `status` (GET /v1/status, public, no auth)

```
node scripts/load-test/run.mjs --target=status --env=staging \
  --duration=30 --connections=10 --pipelining=1
```

Latency p50 / p90 / p99 baseline expectation (Cloudflare edge →
Hetzner origin, CACHE HIT after first 30s warm-up due to
`cache-control: public, max-age=30`):

- p50: < 25ms (Cloudflare edge cache)
- p90: < 60ms (occasional miss on the 30s cache cycle)
- p99: < 200ms (cold-miss to origin + Postgres readiness check)

If sustained p99 > 500ms during a status-target run, investigate:

- Is the Postgres readiness check timing out? (`COMPONENT_TIMEOUT_MS
= 1500`; if Postgres responds in > 1.5s the readiness check returns
  `degraded`.)
- Is Cloudflare cache the cause of a cold-miss spike?

Record the actual numbers as separate `docs/load-test/baselines/<date>.json`
files when the staging stack stabilizes post-V-278.M.

### Target: `sessions` (POST /v1/sessions, auth required; staging only)

This run mutates state (creates session rows). Default duration: 30s
× 10 connections × 1 pipelining.

```
DRIFTSTACK_LOAD_TEST_API_KEY=ds_test_<staging-key> \
node scripts/load-test/run.mjs --target=sessions --env=staging \
  --duration=30 --connections=5
```

Cleanup: every session created during a load run lands in the
staging Neon project. Delete via the dashboard or
`DELETE /v1/sessions/<id>` post-run; truncate
`apps/server/src/db/schema.ts::sessions` rows where
`label = 'load-test'` if the count exceeds 1000.

### Trend tracking

Per-run summaries land at `docs/load-test/baselines/<YYYY-MM-DD>-<target>.json`.
Quarterly review compares `p50 / p99 / max` deltas — sustained
regression > 25% on p99 triggers a perf investigation slice.

## Related

- [DR runbook](/docs/deployment/dr-runbook.md) — recovery procedures
  including any service-overload scenario.
- [Slow-query log](/docs/deployment/env-vars.md) —
  `SLOW_QUERY_LOG_THRESHOLD_MS` correlates with elevated p99.
- [Status endpoint](/docs/architecture/status-architecture.md) —
  the `/v1/status` source-of-truth for component readiness.
