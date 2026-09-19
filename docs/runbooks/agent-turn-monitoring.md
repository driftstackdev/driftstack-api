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

Defined in `ops/alerts/driftstack.yml`, group `driftstack-agent-turns`. Nothing
scrapes them in production today; alerts 1–3 are evaluated there by the health
watchdog instead — see "In production today: the health watchdog" at the end. Every
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

## In production today: the health watchdog

Production has no scraper and no Prometheus or Alertmanager on the box, so none
of the PromQL above runs there. Since 2026-09-18 production DOES set
`METRICS_SCRAPE_TOKEN`, so the metrics registry exists and every
`driftstack_agent_*` series is live in the process — read them on the box with
`curl -H "Authorization: Bearer $METRICS_SCRAPE_TOKEN" http://127.0.0.1:7780/metrics`
(the value is in `/opt/driftstack/api/.env`; never paste it anywhere). `/metrics`
is still private: it answers 401 without the token, at the edge as well. Nothing
scrapes it yet, so nothing alerts from it. Alerts 1–3 are instead evaluated **inside the API** by the
`agent_turn.health_watchdog` job, every **5 minutes**, from the
`agent_turn_telemetry` table — the same rows the admin page reads, through the
same summary code — and delivered through **Sentry** and **by email to the
owner** (see "Getting notified" below).

**One set of numbers.** The watchdog's windows, thresholds, volume floors and
`for:` durations are `AGENT_TURN_ALERT_RULES` in
`apps/server/src/services/agent-turn-health-watchdog.ts`. A unit test
(`agent-turn-health-watchdog-runbook-parity`) reads each number out of the
PromQL blocks above and the `for:` lines in `ops/alerts/driftstack.yml` and
fails if the constant disagrees, so change a threshold in all three places or
the build stops you. They are deliberately not settable from the environment.

**What each condition does.** The numbers are not repeated here: each floor is
the `>= N` line of the condition's PromQL block above, each hold is the alert's
`for:` in `ops/alerts/driftstack.yml`, and the parity test holds both to the
constant.

- **Below the volume floor** the answer is _not enough data_: nothing new ever
  fires. At today's volume this is the usual state, and it is logged once when
  it starts (`event: agent_turn_health_status`, `to: insufficient_data`), not
  every tick.
- **Crossing the threshold** starts the rule's `for:` clock. Once it has held
  that long, **one** Sentry event is sent — on the transition, not every tick.
- **Still breaching:** a reminder event every **6 hours**, into the same issue.
- **Stopping crossing** — back under the threshold, _or_ traffic falling below
  the floor — starts a recovery clock. Once that has held for the same `for:`,
  one `recovered` event is sent; its `cleared_by` says which (`ok` or
  `insufficient_data`). A crossing tick while it runs stops it. So a breach
  never stays open for days because traffic went quiet, and a later crossing
  goes through the `for:` hold again as a new breach.
- **The watchdog itself cannot read the table** for 3 ticks in a row: it
  reports `AgentTurnHealthWatchdogBlind`, so a silent watchdog is not mistaken
  for a healthy product. A tick that fails for any other reason counts the same.

**Recognising its issues in Sentry.** Titles read
`AI turns: AgentTurnCompletionRateLow breach` (or `still_breaching`,
`recovered`); tags are `component: agent-turn-health`, `condition` and
`transition`. Breaches and reminders of one condition share the fingerprint
`agent-turn-health / <condition>` and so form **one issue**; recoveries go to a
separate `agent-turn-health / <condition> / recovered` issue, so a recovery
never reopens a breach issue someone resolved. The event's extra data is the
whole payload: condition, the rule (window, floor, threshold, `for:`), the exact
span evaluated (`window_since` / `window_until`), sample count, value, and for
first progress the p50/p95 in ms. Nothing else — no account, session, task,
URL or model output.

To look closer, open the admin page (**AI turns**). It is not an exact replay:
its window is whole hours (1 h at the least) and ends when the page is opened,
so for first progress (the narrowest window) it shows a wider span, and for any
rule it drifts from `window_since` / `window_until` as time passes. Expect the
figures to be close, not identical.

**Getting notified — automatic, by email.** Every notice the watchdog sends to
Sentry — breach, reminder, recovery, and "watchdog blind" — is also emailed
through Postmark to the owner address (`DRIFTSTACK_OWNER_EMAIL`, the same one
the owner gate uses). Nothing has to be configured: it is on whenever Postmark
(`POSTMARK_API_TOKEN`, `POSTMARK_FROM`, `POSTMARK_REPLY_TO`) is configured and
the owner address is not empty, which is production's normal state. Otherwise
it is off, and boot logs `event: agent_turn_health_email_off` with a `reason`
(`postmark_not_configured`, `no_owner_address` or `switched_off`) once; the
line `agent_turn_health_email_on` means it is on.

- **The subject says the condition and its state plainly**, e.g.
  `AI automation: completion rate low — started 14:05 UTC`,
  `… — still breaching since 2026-09-19 14:05 UTC`, `… — recovered (began …)`.
  A non-production `SENTRY_ENVIRONMENT` is prefixed (`[staging] …`), so a
  staging alert is never read as a production one.
- **The body** gives what it means in one sentence, the window evaluated, the
  counts and the measured value, the threshold with its floor and hold, and
  where to look: the admin panel's **AI turns** page
  (`https://admin.driftstack.io/agent-turns`) and this section. It is rendered
  from the very payload that goes to Sentry, so it is content-free in the same
  way: no account, session, task, URL or model output.
- **At most 6 emails in any rolling hour**, across every condition
  (`AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR`). A real incident — three conditions
  breaching together, then recovering — fits; a flapping one cannot fill the
  inbox. Emails over the limit are held back (logged as
  `agent_turn_health_email_withheld`), Sentry and the log still get each one,
  and the next email that goes out says how many were held.
- **A restart or deploy never mails the same transition twice.** The spent
  budget is saved in the watchdog's job row together with the rest of its state,
  before anything is sent.
- **Email never hurts the product or the Sentry path.** It is sent last, each
  message under a 10-second deadline; a failure or timeout is swallowed, logged
  (`event: agent_turn_health_email_failed`, with Postmark's error category only)
  and counted.

**Optional: a per-event Sentry alert rule.** Email already covers every notice,
so this is only for someone who also wants Sentry to notify (a paging channel,
say). Sentry notifies on a new issue or a regression, and a condition's
breaches share one issue that a `recovered` event does not resolve, so the
usual rules fire on the **first** breach only. An issue alert that fires
per event does the rest:

- when: the number of events in an issue is more than 0 in 1 minute (or any
  equivalent per-event trigger);
- if: the event's tag `component` equals `agent-turn-health`, and tag
  `transition` is `breach` or `still_breaching` (add `recovered` to be told of
  recoveries too);
- then: notify the channel you want.

Sentry's per-issue action interval (5 minutes at the least) cannot swallow
these: a condition sends at most one breach and one reminder every 6 hours, and
a recovery needs its own `for:` first. Optionally, resolve the breach issue by
hand when its `recovered` event arrives; that keeps the issue list honest, and
the next breach then also counts as a regression.

**Silencing.** One condition: in Sentry, **Archive** (ignore) **both** its
breach issue and its `… / recovered` issue — "until escalating" or forever;
archiving only the first still lets its recoveries through (Sentry archiving
does not stop the email). Email only: set
`DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_EMAIL=true` and restart; Sentry and the
log continue. Everything: set
`DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG=true` and restart; the
`bootstrap complete` log line then shows `agentTurnHealthWatchdog: false`.
With Sentry unconfigured (dev, tests), the same events are still written as
structured log lines (`event: agent_turn_health_breach`, `…_still_breaching`,
`…_recovered`).

**Restarts, deploys, more processes.** The watchdog's state (what is breaching,
since when, last reminder, both clocks) travels in its own pending job row, so
a deploy or restart does **not** re-fire a condition that is still breaching,
and with more than one API process only the process that claims the row runs
the tick — they act as one watchdog (production runs one process today). A
still-breaching condition fires again after a restart only if the pending row
was lost.

**Delivery is at most once.** The new state is saved before an event or email
is sent, so nothing is ever sent twice — and one that is lost is not retried.
An email that Postmark refuses is logged and dropped. The
Sentry SDK drops events quietly while Sentry is down or rate-limiting, and a
process that dies between saving and sending sends nothing. Either way the
next word from that condition is its reminder, up to 6 hours later, or its
`recovered`. The structured log line is written before the send and is the
record of what was meant to go out.

**Its own health.** Failure counts are per process since boot and are not a
metric (there is no scraper): every failure, status and notice line it logs
carries `ticks_total`, `failed_ticks_total`, `delivery_failures_total`,
`notices_sent_total`, `emails_sent_total`, `email_failures_total` and
`emails_withheld_total`. Nothing watches the job chain itself in production
today — the liveness gauge also needs the metrics registry — so after a deploy,
check that an `agent_turn.health_watchdog` row is pending.

**Where it differs from the PromQL:**

- **Alert 4 (telemetry writes failing) is NOT evaluated.** A failed write leaves
  no row, so the table cannot see it, and the only count is the in-process
  `driftstack_agent_turn_telemetry_write_total` counter (live in production since
  2026-09-18, but per-process and reset on every deploy). Until a scraper exists,
  read that counter on the box or look for the warn line
  `agent turn telemetry failed; the turn was not affected`.
- **Recovery waits for the rule's `for:`**; Prometheus resolves as soon as the
  expression stops matching. At tens of requests one request moves a rate
  across the threshold, and resolving on one tick would send a breach and a
  recovery every twenty minutes for a rate sitting on the line.
- **Falling below the floor clears a breach** after the same wait. Prometheus
  resolves at once when the floor's `and` empties the vector; the watchdog
  reports it with `cleared_by: insufficient_data`.
- Percentiles are exact over the rows (`percentile_cont`), where the PromQL
  interpolates histogram buckets; near the threshold the two can disagree
  slightly.
- The 409 rate can under-read during a retry storm: turned-away requests past
  60 a minute per process are shed rather than written (see "The per-request
  record"). The PromQL counts every one.
- It reports up to one tick after the `for:` is met.

**The PromQL above stays valid** and is the better instrument once a scraper
exists. At that point either keep both (expect duplicate notifications) or
switch the watchdog off.
