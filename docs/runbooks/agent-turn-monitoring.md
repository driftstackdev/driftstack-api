# AI turn monitoring

How to see whether the AI automation is working in production, and the four
conditions worth an alert.

Before this existed the only evidence of how AI turns behaved was a grep over
proxy access logs: 27 turns ever, a quarter of the requests answered 409, no
task saved. Everything below is produced at one place — the
`POST /v1/agent-sessions/:id/message` route, by
`apps/server/src/services/agent-turn-telemetry.ts` — so a request that reaches
the route's handler is counted exactly once whichever way it ended, including
the ones that never reached the AI at all.

**The boundary:** a request refused _before_ the handler is not counted here —
a missing or invalid key (401/403), and the per-caller rate limit's 429. Those
show in `driftstack_http_request_total` and in `driftstack_rate_limit_total`
(`bucket="agent_sessions:message"`, `outcome="exceeded"`).
`rate_limited` below therefore means the account-level limits the handler
itself applies, and it under-reads when one client is hammering the route.

## Two instruments, and which one works today

| Instrument                                             | Needs                                  | Use it for                                     |
| ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| Admin panel → **AI turns** (`/agent-turns`)            | migration `0125` applied; nothing else | "Where do tasks die?", rates over a window     |
| Prometheus series `driftstack_agent_turn_*` + 4 alerts | `METRICS_SCRAPE_TOKEN` set + a scraper | Paging, trends over time, dashboards by minute |

⛔ **The metrics half is inert until `METRICS_SCRAPE_TOKEN` is set.** The server
only creates the metrics registry when that variable is present
(`apps/server/src/lib/bootstrap.ts`), so without it `GET /metrics` does not
exist and every counter below is a no-op. The admin page does **not** depend on
it: the per-request records are written to Postgres either way. If you are
reading this because AI turns look broken and there is no scraper yet, open the
admin page.

## The per-request record

One row in `agent_turn_telemetry` per request (not per successful turn): how it
ended, the failure class, the index and kind of the step it died on, counts
(steps planned / run / succeeded, re-plan attempts, model calls), time per
phase, time to first progress, tokens, the model, and an estimated list-price
cost.

It is **content-free by construction**. There is no account id, no session id,
no task text, URL, selector, page text, answer or credential name. Every text
column is CHECK-constrained to a closed list in the database, so a later change
that tries to store one fails the insert rather than leaking. The row cannot be
joined back to a customer; this is a fleet-wide health instrument, not an audit
trail. For "what happened to _this_ customer's turn", use the session transcript.

Retention is **90 days**, pruned daily by the `agent_turn_telemetry.prune` job
(on the `driftstack_scheduled_job_chain_pending` liveness roster like every
other recurring job). Long-term trends belong in the metrics backend.

Writing the row can never fail or slow a turn: it happens after the response is
decided, off the request path, with a cap on writes in flight (20) and a
10-second deadline on each write, so a database that has stopped answering costs
dropped rows and gives the slots back. Rows still pending at shutdown are
flushed for up to 0.75 seconds before the database connection closes. The cost of
fire-and-forget is that a failing write is silent everywhere except
`driftstack_agent_turn_telemetry_write_total` — hence alert 4.

Requests that were turned away (`busy_409`, `conflict_409`, `rate_limited`,
`rejected`) are written at most 60 a minute per process; past that they are
counted as `outcome="shed"` and not written, so a retry storm cannot turn the
path that sheds load into a database write per request. The Prometheus counters
still see every request, so under a storm trust the 409 rate on the scrape over
the one on the admin page.

## Reading the numbers

- **Completion rate** = `completed / (completed + failed + refused + stopped + error)`.
  `halted_for_confirmation` (paused before a purchase, payment or deletion) and
  `clarified` (asked the customer a question) are in neither side: both are the
  agent correctly handing a decision back to a person.
- **Per-turn figures** (time, tokens, cost, re-plans) are over turns that RAN:
  every outcome in which the AI worked on a task, plus an `error` that had
  already called the model — a turn that spent tokens and then returned a 5xx
  is spend an operator must be able to see.
- **Where tasks die** lists `failed`, `refused`, `stopped` and `error` only, and
  its shares are of those. Requests that were turned away before any task
  existed (409, 429, other 4xx) are listed separately, so a burst of 409s cannot
  dilute the share of real step deaths.
- **Phases** cover the runtime's own work and stop when it returns. What the
  route does afterwards (transcript append, token debit, idempotency receipt) is
  shown as **after the turn**: `duration − time to first progress − phases`. A
  high value there is storage, not the model. One known blur remains: `planning`
  still includes the usage-row write (and its retry backoff) that follows the
  model call, because the runtime announces no boundary between them.
- **Steps planned** is the length of the plan of record: after a re-plan, the
  steps already run plus the new plan, not the sum of every plan drawn up.
- **409 rate** = `(busy_409 + conflict_409) / all requests`. `busy_409` means the
  previous turn on that session was still running — what a customer sees when
  they give up on a slow turn and type again. Read it together with turn time.
- **Time to first progress** is measured to the first progress event of the
  turn ("planning…"). Alert on the `stream` transport only: that is the one on
  which somebody is watching.
- A rate over nothing is shown as "—" and returned as `null`, never 0. At
  current volume "no turns yet" and "none completed" are both likely.
- **Cost is a list-price estimate** from token counts and the model catalogue
  (`packages/api-types/src/agent-models.ts`). It is not what anyone was billed.

### What it cannot see

- **The Stop button.** In the desktop client Stop frees the composer but does
  not tell the server; the turn keeps running. `stopped` therefore counts only
  interruptions the server can observe — the customer closing the session, or a
  person taking control mid-turn. A Stop usually shows up here as the _next_
  request's `busy_409`.
- **Whether the answer was right.** A `completed` turn ran its plan and
  answered; nothing in production knows the task's success criterion. That is
  what the eval under `apps/server/tests/eval` measures, and the failure classes
  here deliberately share its names so a death seen in production can be
  reproduced there under the same word.

## The four alerts

Defined in `ops/alerts/driftstack.yml`, group `driftstack-agent-turns`. Every
ratio carries a volume floor (`and … >= 10`): at tens of turns a day, one failed
turn in a quiet hour is a 100% failure rate, and a rule without a floor teaches
everyone to ignore it. Revisit the floors and thresholds once there is a real
baseline.

### 1. `AgentTurnCompletionRateLow` — warning

```promql
(
  (sum(increase(driftstack_agent_turn_total{outcome="completed"}[6h])) or vector(0))
  /
  sum(increase(driftstack_agent_turn_total{outcome=~"completed|failed|refused|stopped|error"}[6h]))
) < 0.5
and
sum(increase(driftstack_agent_turn_total{outcome=~"completed|failed|refused|stopped|error"}[6h])) >= 10
```

`or vector(0)` matters: with no completion in the window the bare numerator is
an empty vector and the rule would stay silent at exactly 0%. The server also
creates every `outcome` series at zero on start, which is what lets
`increase()` see the first event after a deploy rather than only the second.

First move: admin panel → AI turns → **Where tasks die**. Then by class:

```promql
topk(5, sum by (reason, step_kind) (increase(driftstack_agent_turn_step_failure_total[6h])))
```

`element_never_appeared_in_retry_budget` on `interact` is the planner aiming at
things that are not on the page; `model_unavailable` is the provider;
`session_error` is the browser session, not the plan.

### 2. `AgentTurnConflictRateHigh` — warning

```promql
(
  sum(increase(driftstack_agent_turn_total{outcome=~"busy_409|conflict_409"}[1h]))
  /
  sum(increase(driftstack_agent_turn_total{outcome!~"replayed|manual_note"}[1h]))
) > 0.10
and
sum(increase(driftstack_agent_turn_total{outcome!~"replayed|manual_note"}[1h])) >= 10
```

`replayed` and `manual_note` are excluded so this is the same ratio the admin
page shows (neither is written as a diagnostics row).

Split it before acting — the two halves have different causes:

```promql
sum by (outcome) (increase(driftstack_agent_turn_total{outcome=~"busy_409|conflict_409"}[1h]))
```

Mostly `busy_409`: turns are slow and customers are re-sending. Look at p95 turn
time and alert 3. Mostly `conflict_409`: control hand-offs or messages to ended
sessions — a client-side problem more often than a server one.

### 3. `AgentTurnFirstProgressSlow` — warning

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(driftstack_agent_turn_time_to_first_progress_seconds_bucket{transport="stream"}[30m]))
) > 5
and
sum(increase(driftstack_agent_turn_time_to_first_progress_seconds_count{transport="stream"}[30m])) >= 10
```

Everything before the first progress event happens before any model call:
session and ownership lookup, rate limiting, key resolution, the spend
preflight, publishing the message to the transcript. Check database and Redis
latency first. Where the rest of a turn's time goes:

```promql
histogram_quantile(0.95, sum by (le, phase) (rate(driftstack_agent_turn_phase_duration_seconds_bucket[1h])))
```

### 4. `AgentTurnTelemetryWriteFailing` — warning

```promql
sum(increase(driftstack_agent_turn_telemetry_write_total{outcome=~"error|dropped"}[15m])) > 0
```

AI turns are unaffected; the admin page is going blind. `error` with a constant
rate is almost always one of two things: migration `0125` has not been applied,
or an outcome / failure class was added in source without widening the table's
CHECK constraints (a unit test,
`agent-turn-telemetry-unions-match-the-migration`, exists to stop that reaching
production). `dropped` means the writer hit its in-flight cap: the database has
stopped answering it. `shed` is not in the rule and is not a fault — see "The
per-request record" above.

## Other series worth a dashboard panel

| Series                                           | Panel                                                         |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `driftstack_agent_turn_duration_seconds`         | p50 / p95 turn time by `outcome`                              |
| `driftstack_agent_turn_model_call_total`         | calls per turn by `call_kind` (plan / re_plan / answer)       |
| `driftstack_agent_turn_tokens_total`             | tokens by `token_type`; `cache_read` share of prompt tokens   |
| `driftstack_agent_turn_replans`                  | share of turns with at least one re-plan: `1 - le="0" / +Inf` |
| `driftstack_agent_turn_total{outcome="refused"}` | refusals; split by reason on the admin page                   |

Prompt served from cache, as a share of prompt tokens:

```promql
sum(rate(driftstack_agent_turn_tokens_total{token_type="cache_read"}[1h]))
/
sum(rate(driftstack_agent_turn_tokens_total{token_type=~"input|cache_read|cache_write"}[1h]))
```

Labels are closed enums only. Never a session id, account id, URL, selector,
task text or anything a model wrote; an unknown model id is reported as `other`.
