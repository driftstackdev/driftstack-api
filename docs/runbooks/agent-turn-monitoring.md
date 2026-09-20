# AI turn monitoring

How to see whether the AI automation is working in production, and the five
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

## The five alerts

Defined in `ops/alerts/driftstack.yml`, group `driftstack-agent-turns`. Nothing
scrapes them in production today; alerts 1–3 and 5 are evaluated there by the health
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

### 5. `AgentActionNoProfileAttached` — warning

```promql
(
  sum(increase(driftstack_agent_action_profile_attached_total{profile_attached="false"}[30m])) or vector(0)
) > 0
and
(sum(increase(driftstack_agent_action_profile_attached_total[30m])) or vector(0)) >= 1
```

**A configuration alert, not a detectability verdict.** The browser reports, on
every click and every typed step, whether a **behaviour profile was attached**
to the session. A session acting with none is misconfigured, and the
misconfiguration leaves no other trace: the step succeeds, the task finishes,
the turn is `completed`, and no rate over outcomes can see it.

⛔ What it does **not** say: that the action looked mechanical, or that a
profile being attached made it undetectable. The flag is **necessary and not
sufficient** — nothing here measures what the browser then did with the profile.

**What to check, in order.**

1. **Page the team that owns the browser build — and ask which build the box is
   running.** The flag is the browser's own answer to "did this session have a
   profile when the step ran", so the cause is on its side; but WHICH cause
   depends on the build, and the two are not the same fault.
2. **On a build whose persona resolution fails closed**, a missing, unloadable
   or invalid personas file falls back to a compiled-in default profile, and a
   profile name the browser does not recognise falls back to its base one —
   neither can produce `false` there. What remains is a session with **no
   behaviour profile recorded against it at all** when its first action ran: a
   session-lifecycle fault, not a packaging one.
3. **On an older build without that fallback**, a missing, empty or malformed
   personas file _is_ the cause — and it degrades every session on the box at
   once, so the give-away is a count that is not confined to one session.
4. **An older browser build that does not report the flag** reads `unreported`,
   never `false`, so a rising `unreported` share is a different (and much
   smaller) thing: the question is going unanswered, not being answered badly.
5. The profile name we send is typed from `DEVICE_PERSONAS` and
   `DEVICE_SPEED_MODIFIERS` in
   `apps/server/src/schemas/harness-control-protocol.ts` — one constant per
   axis, replacing a single six-name list that read as six interchangeable
   profiles — so a name the browser cannot resolve cannot be written on our
   side. The browser resolves that field on **two axes**: a persona (`casual` /
   `regular` / `power_user`) **or** a speed (`fast` / `balanced` / `careful`)
   applied to a fixed base, and the two do not combine. An unrecognised name
   falls through to the base rather than leaving the session without one, so it
   is not a cause of this alert.

There is no acceptable share, so the threshold is zero and strict — one such
action is the whole finding, and the rule has no hold. The second clause is not
a volume floor in the sense the three ratio rules use one; it only stops a window
with no AI action in it from reading as a clean bill of health.

⛔ **What this alert cannot see.** It counts clicks and typed steps only. A turn
that only scrolled and paused contributes nothing to it, so a session with no
profile attached that never clicks or types does not raise it — read
`scroll_path_segmented` on that turn's journal line instead (below). Adding
scrolls to the alert is not the repair: the browser picks the scroll path with
the same predicate, so it would page twice for one misconfiguration.

## The paths each action took

Three series and one journal line. Read the first two together with care: they
are **not** independent evidence, and none of them is a measurement of how an
action looked to a site.

| Series                                           | Labels                                | Read it for                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_agent_action_profile_attached_total` | `verb`, `profile_attached`, `outcome` | whether the session that clicked or typed had a behaviour profile attached. One count per dispatched attempt, **retries included**          |
| `driftstack_agent_scroll_path_total`             | `path`, `outcome`                     | which of the browser's two scroll implementations ran. **Reported, never alerted on** — see below                                           |
| `driftstack_agent_pre_tap_look_total`            | `outcome`, `resolved_by`, `then`      | how each step's control was found before the tap, and what the step did next. Recorded for **every** look, including steps that then failed |
| `driftstack_agent_look_to_tap_seconds`           | `verb`                                | histogram — the interval between "what is there?" and "touch it"                                                                            |

⛔ **The first two are one fact, not two.** The browser picks the scroll path
with the **same** predicate it reports as `profile_attached` — a profile is
attached, or it is not — and nothing the control plane sends selects it. A
session cannot today be profile-attached and scroll segmented. Never put them
side by side as corroborating evidence, and never alert on the scroll path.

⛔ **Both scroll paths are native touch.** Finger deltas, step durations and a
press-to-first-move delay on either. `segmented` differs in having a **flat
cadence** (a fixed interval with jitter) where the flick plan's varies. It is
reported so the browser team can see which ran; it does not mean the scroll was
anything other than a real touch sequence.

**What each value means.**

- `verb`: `click` or `send_keys` (typing). Scrolls are in their own series;
  pauses are not counted at all, because every tap and typed step of the same
  session already witnesses the configuration fact.
- `profile_attached`: `true` a profile was attached — necessary, not sufficient,
  and never evidence that the action was undetectable; `false` none was, which
  is the configuration fault alert 5 reports; `unreported` the step produced no
  usable result to read it from (a failure, no answer in time, a step the
  customer's Stop cut short, or a browser build that omits the field).
  `unreported` is never read as `true`.
- `path`: `flick` or `segmented` — which scroll implementation ran, chosen by
  the predicate above; `unreported` when no usable result came back.
- `outcome`: `ok`, `failed`, or `unknown` — the executor's own verdict on the
  step, where `unknown` is its existing word for "this may have taken effect and
  we cannot confirm it".
- `resolved_by`: `native` the browser's native find located the control;
  `script` the script resolver it falls back to located it; `none` it looked and
  found nothing; `unanswered` no usable answer at all. **The `native` → `script`
  transition is the one to watch**: it is a change in how the page is being
  searched, and it shows up on the steps that go wrong, which is why it is
  recorded even when the tap is never sent.
- `then`: `tapped` / `typed` a step was dispatched; `refused` the look's own
  verdict stopped it (covered, or not found once waiting for it gave up);
  `not_sent` nothing was sent for another reason (the confirmation gate, the
  repeat guard, or Stop).
- `outcome` on the look is the look's verdict, unchanged: `clear`, `covered`,
  `not_found`, `outside_viewport`, `unverified`, `fallback`.

**From `/metrics`, on the box.** The token is in `/opt/driftstack/api/.env`;
read it from the environment and never print or paste it.

```sh
# every path, all four series, in one scrape
set -a; . /opt/driftstack/api/.env; set +a
curl -sS -H "Authorization: Bearer $METRICS_SCRAPE_TOKEN" \
  http://127.0.0.1:7780/metrics \
  | grep -E '^driftstack_agent_(action_profile_attached_total|scroll_path_total|pre_tap_look_total|look_to_tap_seconds)'
```

```sh
# only the actions whose session had no behaviour profile attached
set -a; . /opt/driftstack/api/.env; set +a
curl -sS -H "Authorization: Bearer $METRICS_SCRAPE_TOKEN" \
  http://127.0.0.1:7780/metrics \
  | grep 'profile_attached="false"'
```

**From the journal.** Nothing scrapes `/metrics`, and the registry's counters
reset on every deploy, so the journal is where these numbers survive. One line
per turn, `event: agent_turn_action_paths`, counts only — no URL, no selector,
no typed text, no session or account id:

```sh
# every turn's action paths, newest last
journalctl -u driftstack-api --since '24 hours ago' --no-pager \
  | grep agent_turn_action_paths
```

```sh
# only the turns in which an action ran with no behaviour profile attached
journalctl -u driftstack-api --since '7 days ago' --no-pager \
  | grep agent_turn_action_paths | grep -v '"profile_attached_false":0'
```

Each line carries: `actions_total`, `profile_attached_true`,
`profile_attached_false`, `profile_attached_unreported`, `no_profile_click`,
`no_profile_send_keys`, `scrolls_total`, `scroll_path_flick`,
`scroll_path_segmented`, `scroll_path_unreported`, `outcome_ok`,
`outcome_failed`, `outcome_unknown`, `looks_total`, `resolved_by_native`,
`resolved_by_script`, `resolved_by_none`, `resolved_by_unanswered`,
`verdict_clear`, `verdict_covered`, `verdict_not_found`,
`verdict_outside_viewport`, `verdict_unverified`, `verdict_fallback`,
`then_tapped`, `then_typed`, `then_refused`, `then_not_sent`. A turn in which an
action ran with no behaviour profile attached is logged at **warn**, with the
sentence "an agent action ran with NO behaviour profile attached to the session
(a configuration fault, not a detectability verdict)"; every other turn is
`info`.

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
owner** (see "Getting notified" below). Alert 5 is evaluated by the same job on
the same schedule, from a different place — see "Alert 5" below.

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

**Alert 5 (an AI session acting with no behaviour profile attached) IS
evaluated, from memory rather than from the table.** It is a CONFIGURATION
check: the counts it needs have no column in
`agent_turn_telemetry` — every text column of that table is a closed list
enforced in the database, so carrying them there is a migration, and this change
does not make one. The watchdog reads instead the same numbers each turn's
`agent_turn_action_paths` journal line is written from, held in the API process
that served the turn.

⛔ **What that costs, plainly.** The window belongs to **one process** and starts
empty after a deploy or restart, and the tick runs on whichever process claims
the job row. Production runs one API process today, so today it sees every turn;
with several it would see only its own. The error is one-sided — a turn it
cannot see is a **missed** alert, never a false one — and the counts are in the
journal either way, which is why "The paths each action took" above
gives the exact `journalctl` command. A scraper, or a column, replaces this. A
window with no AI action in it reports _not enough data_, never "all clear".
The scroll path is **never** alerted on — it is the same predicate under
another name (see "The paths each action took"), and a second alert for it
would page twice for one misconfiguration.

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

- **Alert 5 reads memory, not the table**, so it sees only the turns served by
  the process that runs the tick, and nothing from before the last restart. See
  "Alert 5" above.
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
