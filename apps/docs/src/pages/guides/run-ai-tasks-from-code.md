---
layout: ../../layouts/DocLayout.astro
title: Run AI tasks from your code
description: Hand a task to the AI agent from TypeScript, Python, Go or curl — start a session on a saved profile, send the task, read the answer, approve or answer when it asks, stop it, and close it. Covers errors, safe retries, limits and who pays for the AI.
---

# Run AI tasks from your code

An [agent session](/api/agent-sessions/) is a cloud iPhone browser that an AI
drives for you. You send a task in plain words ("open the invoices page and
tell me this month's total"); the agent plans the taps and page loads, runs
them, and sends back what happened and the answer. This guide takes you from
an API key to a job you can run every night, and answers the questions a
program has to handle along the way. The [complete programs](#complete-examples)
at the end put it all together in TypeScript, Python, Go and curl.

## What you'll build

A nightly job that:

1. starts an agent session on a saved **profile** — a stored browser identity,
   cookies and all — that is already signed in to a supplier portal,
2. sends one task — _"Open https://portal.example.com/invoices, find the
   invoice for September 2026 and tell me its total amount."_,
3. prints each step as it finishes and then the answer, for example
   `Answer: The September 2026 invoice total is €1,284.50.`,
4. answers the agent if it asks a question, and does **not** approve a
   payment on its own,
5. stops the task if it runs too long, and always closes the session.

## Before you start

- **A plan with the AI agent.** Team, Agency, and every API plan include it —
  the tier values `team_manual`, `agency_manual`, `api_starter`,
  `api_builder`, `api_scale` and `enterprise`. On Free (`free`) and Personal
  (`solo_manual`), creating an AI session returns `403 forbidden`.
- **An API key with `read` and `write`.** Create one in the dashboard under
  **API keys** ([app.driftstack.io/api-keys](https://app.driftstack.io/api-keys/)).
  The value is shown once; keep it as `DRIFTSTACK_API_KEY`. Every
  agent-session write — create, message, stop, close — needs the broad `write`
  scope; the granular `write:sessions` is not enough. Reads need
  `read:sessions`, which broad `read` covers. Keep `account_owner` off a job
  key: the job does not need it. See [API key scopes](/reference/scopes/).
- **Check the plan and the key** before the first run. `GET /v1/whoami`
  returns the `tier` and the scopes:

  ```bash
  curl -sS https://api.driftstack.dev/v1/whoami \
    -H "Authorization: Bearer $DRIFTSTACK_API_KEY"
  # {"account_id":"acc_...","api_key_id":"key_...","tier":"api_builder","scopes":["read","write"]}
  ```

- **An SDK**, if you are not using curl: `npm install @driftstack/sdk`,
  `pip install driftstack-sdk`, or
  `go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest`.
  See [SDK installation](/sdk/installation/).

## One-time setup: a signed-in profile

A [profile](/guides/profile-management/) keeps a browser identity — cookies
and storage — between sessions. Sign it in to the portal once, then reuse it
every night.

1. Create the profile with `POST /v1/profiles` and keep its `prof_…` id.
2. Sign in by hand: open a session on the profile in the
   [desktop app](/license-activation/) and log in to the portal. Or, if you
   already have the portal's cookies, import them into a running session with
   [`POST /v1/agent-sessions/{id}/cookies/set`](/api/agent-sessions/#import-cookies).
3. Close that session. The profile's cookies and storage are saved when the
   session ends.

**Never put a password or a one-time code in a message.** The message is kept
word for word in the session's history and is sent to the model. Sign in by
hand once instead.

If the portal needs a proxy, save and test it once under
[account proxies](/api/proxies/) and pass its `proxy_id` when you create the
session.

## Who pays for the AI

Every message the agent works on uses a Claude model. There are two ways to
pay for it:

| Way to pay                                                      | Plans                              | How it is paid                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your own Anthropic key**                                      | Every plan with the AI agent       | Anthropic bills your Anthropic account for the tokens used. Driftstack does not charge for the model.                                                                       |
| **Driftstack's included AI** ([bundled LLM](/api/bundled-llm/)) | API Builder, API Scale, Enterprise | You opt in once. Each message the AI works on counts a flat **$0.10** against a monthly budget you set (default $20, at most $100); Enterprise can use a contracted budget. |

Your own key always wins: if a message carries a key, or the account has a
stored key, Driftstack's included AI is not used for it.

- **Store your key once** on the dashboard's
  [Settings page](https://app.driftstack.io/settings/), or with
  `PUT /v1/account/me/byok-anthropic-key` using an owner key (see
  [BYOK Anthropic key](/api/byok-anthropic/)). A stored key is used only while
  it is less than 90 days old — put it again to renew it.
- **Or send it with each message** in the `x-byok-anthropic-api-key` header
  (`byokApiKey` / `byok_api_key` / `ByokAPIKey` in the SDKs). This needs only
  the job key's `write` scope.
- **Or opt in to Driftstack's included AI** on the same
  [Settings page](https://app.driftstack.io/settings/), or with
  `PATCH /v1/account/me/bundled-llm-settings` and `{"consent": true}` using an
  owner key.

What a message returns when neither is set up:

- `402 bundled-llm-consent-required` — your account has not opted in to
  Driftstack's included AI. On Team, Agency and API Starter, opting in is
  refused, so add your own key instead.
- `402 bundled-llm-budget-exhausted` — this month's included budget is used
  up (`spent_cents`, `cap_cents`). Raise the cap, add your own key, or wait for
  the next calendar month.
- `502 byok-anthropic-required` — no key could be found for the message.
- `403 forbidden` — Driftstack's included AI is switched on, but your current
  plan no longer includes it. Add your own key.

To check before a nightly run, read `GET /v1/account/me/byok-anthropic-key`
(`has_key`, `set_at`) and `GET /v1/account/me/bundled-llm-status`
(`consent`, `remaining_cents`); both need the key's `read` scope. The `usage`
block on each result shows what that message cost: on the included AI,
`usage.cost_usd_cents` is the flat 10 cents.

## Pick a model

Leave `model` unset and the agent runs **Claude Sonnet 5**
(`claude-sonnet-5`). Other choices are listed in the
[create request](/api/agent-sessions/#create). With your own key, Anthropic
bills per token, so a smaller model such as `claude-haiku-4-5` costs less for
simple pages; on the included AI every message counts the same $0.10 whatever
the model.

Claude Opus models (`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`)
run only with your own Anthropic key. Without one, creating the session — or
sending a message — returns `403 forbidden` with `requires_own_key: true` and
the refused `model`.

## Start a session

`POST /v1/agent-sessions` with the profile, and an `Idempotency-Key` so a
retried create returns the same session instead of a second one. The SDKs
retry a create that carries a key for you on network errors.

```json
{ "mode": "ai", "profile_id": "prof_<uuid>", "token_budget": 100000 }
```

- `mode` defaults to `ai`, which is what a job wants. The other two,
  `manual` and `pair`, are for a session a person drives — or shares with the
  AI — from the desktop app. `model` defaults to Claude Sonnet 5.
- `token_budget` is the most model tokens the session may use (default
  100,000; at most 10,000,000). It is your cost ceiling for the session.
- `proxy_id` routes the session through one of your saved proxies. Add
  `stop_on_exit_ip_change: true` to end the session if that proxy's exit IP
  changes mid-run.
- Leave `driftstack_session_id` out; the agent session has its own browser.

The `201` response is the session. Its `status` tells you what to do next:

- `active` — ready; send the task.
- `provisioning` — the browser is still starting. Poll
  `GET /v1/agent-sessions/{id}` every 2 seconds until it is `active`; give up
  after about two minutes.
- `closed` — the session could not start. Log `closed_reason` and stop.

What can go wrong at create:

- `409 profile-in-use` — the profile already has an open session (an earlier
  run that crashed, for example). The body's `active_session_id` names it. End
  that one and create again: an `agt_…` id is an agent session
  (`DELETE /v1/agent-sessions/{id}`); a `ses_…` id is an ordinary browser
  session you started with `/v1/sessions` (`DELETE /v1/sessions/{id}`).
- `429 concurrency-limit` — your account already has as many open agent
  sessions as your plan allows. Close one, or wait.
- `422 proxy-validation-failed` — the proxy did not pass its live test; the
  body's `reason` says why. See [account proxies](/api/proxies/).
- `403 forbidden` — the plan has no AI agent, or an Opus model without your
  own key (`requires_own_key: true`).

## Send the task

`POST /v1/agent-sessions/{id}/message` with one `user_message` of up to 8,000
characters.

```json
{
  "user_message": "Open https://portal.example.com/invoices, find the invoice for September 2026 and tell me its total amount."
}
```

- **Say what you want back.** An `answer` comes back when your message asks
  for information — a question, or words such as _tell me_, _find_, _check_ or
  _what is_ — the steps all succeeded, and the session still has enough of its
  token budget left to read the page. A message that only asks for actions gets
  the steps, and no `answer`.
- **Put the start URL in the message,** so the agent knows where to begin.
- **Send a new `Idempotency-Key` for each new message.** Reuse a key only to
  retry the _same_ message after you lost the response (see
  [Errors and safe retries](#errors-and-safe-retries)).
- **Stream the response.** Send `Accept: text/event-stream` (the SDKs do this
  for you) so the connection stays open while the agent works; see below.

## How long a message takes

A message returns when the task is done or stops at a limit.

- After about **three minutes** the agent starts no new steps and hands back
  with a `notice` asking you to send "continue". A step that is already running
  always finishes, and the answer may still be read after that, so a message
  can take longer than three minutes.
- The SDKs wait up to **50 minutes** for a message. Keep that default rather
  than setting a short timeout: a message is never retried automatically, so
  timing out early only loses you the result.
- The streamed response sends a keep-alive comment about every 15 seconds.
  With curl, pass `-N` and a generous `--max-time`.
- **Closing the connection does not cancel the task** — it keeps running. To
  cancel, [stop it](#stop-a-task-that-runs-too-long). To get the result
  afterwards, send the same message again with the same `Idempotency-Key`.

## Read what came back

Every result has a `kind`, and the `session` as it is now:

| `kind`          | What happened                                                                          | Read                                                                          |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `plan-executed` | The agent planned steps and ran them.                                                  | `results`, `ok`, `answer` or `answer_unavailable`, `notice` + `notice_reason` |
| `clarify`       | The agent needs more information before it starts.                                     | `clarifying_question` — answer it in your next message                        |
| `refuse`        | The agent would not do the task, or the AI was briefly unavailable.                    | `refuse_reason`                                                               |
| `stopped`       | You [stopped](#stop-a-task-that-runs-too-long) the task.                               | `results` (the steps that ran), `notice`                                      |
| `logged-manual` | Only in `manual` mode: your message was logged and nothing ran. Not used in this flow. | —                                                                             |

- Field names are mixed on purpose: the result's own fields are snake_case
  (`clarifying_question`, `refuse_reason`, `stopped_during`), the fields inside
  a step are camelCase (`captureId`, `matchedText`). Copy them exactly.
- A `stopped` result also carries `stopped_during` — `planning`, `executing`,
  `reading_page` or `answering` — saying how far it got.
- A `refuse` is either the agent declining the task or the AI being briefly
  unavailable; `refuse_reason` says which. Either way the session stays active.
  If it asks you to retry, send the task again under a **new**
  `Idempotency-Key`: this answer is stored against the old one. A refusal of
  the task itself will repeat, so change the task instead.

For `plan-executed`, decide in this order:

1. **`notice` is present** — the task is **not** finished. The agent stopped at
   a limit — it ran out of time, or out of the planning rounds it may make for
   one message, or out of token budget; it was going in circles; or its next
   step would have repeated an action that already ran — or it could not work
   out the next steps, or it asked you something part-way. The sentence says which, and what
   it needs from you. Most of them ask you to send "continue", and the agent
   carries on from the current page; the budget one asks you to start a new
   session instead (its sentence calls that a new chat), and the
   going-in-circles one asks you to say what to try differently. `notice` is
   open text: show it, do not match on it.

   Beside it, `notice_reason` says the same thing in one word, so an unattended
   job can decide what to do without reading English:

   | `notice_reason`  | What happened                                                                             | What your program should do                              |
   | ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
   | `step_limit`     | The task needs more steps than one message runs.                                          | Send "continue".                                         |
   | `time_limit`     | The message was taking too long.                                                          | Send "continue".                                         |
   | `budget_low`     | Too little of the session's token budget is left.                                         | Start a new session and carry on there.                  |
   | `no_progress`    | The page stopped changing and the next step would have repeated one that changed nothing. | Ask a person; `notice` asks what to try differently.     |
   | `repeated_step`  | The next step would have repeated an action that already ran, which could do it twice.    | Check the page, then send "continue" only if it is safe. |
   | `ai_unavailable` | The next steps could not be worked out just now.                                          | Send "continue" to try again.                            |
   | `question`       | The agent asked you something part-way; `notice` is the question.                         | Answer it as the next message; unattended, ask a person. |
   | `declined`       | The agent stopped rather than carry on.                                                   | Ask a person. "continue" will not change the answer.     |

   The list is **open**: a turn may one day end a way that is not in it. Treat a
   value you do not recognise — and an older server that sends `notice` with no
   `notice_reason` — the way you treat `question`: show the sentence and alert a
   person rather than replying automatically.

2. **`ok` is `false`** — the last step failed or is waiting for your approval.
   Look at the last entry of `results`.
3. **Otherwise** the task is done. Read `answer` if you asked for one — or
   `answer_unavailable`, one sentence saying why there is none. The two never
   arrive together, and a task that only acts has neither. `answer_unavailable`
   is open text: show it, do not match on it.

`ok: true` does not mean "finished": it means the last planned steps ran
without a failure. A message that recovered from a failed step can show
`ok: true` with that failure still in `results`.

Each entry in `results` is one step that ran, in order, with the step itself
as `results[i].intent`:

| `results[i].kind`       | Meaning                                                                         | Read                                                  |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `success`               | The step worked.                                                                | `summary`; `captureId` for a screenshot               |
| `failure`               | The step did not work.                                                          | `reason`, `diagnosis.category`, `diagnosis.retryable` |
| `confirmation_required` | The step would buy, pay or delete an account, so it was held for your approval. | `category`, `matchedText`                             |

Read steps from `results`, not `intents`: `intents` is every step the turn
attempted, across every plan it made, so it is longer than `results` whenever a
plan was abandoned part-way. `results[i].intent` is the step each result is
for.

On a `failure`, `diagnosis` is optional — check it is there before reading it.
`diagnosis.category` is an open list (`page_load_failed`, `element_not_found`,
`element_covered` and more over time; the
[reference](/api/agent-sessions/#message) has them all), so treat a value you
do not recognise as `unknown` and decide on `diagnosis.retryable`.
`retryable: false` means never repeat that step automatically — it may already
have happened; look at the page first.

## Get a screenshot or a downloaded file

Both need `read:sessions`, which broad `read` covers, and both work only
**while the session is open**, so fetch before you close it.

**A screenshot.** A `success` step with a `captureId` has an image behind it.
The SDKs fetch it for you — `getCapture(id, captureId)` in TypeScript,
`get_capture(id, capture_id)` in Python, `GetCapture(ctx, id, captureID)` in
Go — and hand back the bytes with the media type the server gave them:

```ts
for (const step of reply.results) {
  if (step.kind === 'success' && step.captureId !== undefined) {
    const shot = await client.agentSessions.getCapture(sessionId, step.captureId);
    await writeFile(shot.contentType === 'image/jpeg' ? 'step.jpg' : 'step.png', shot.bytes);
  }
}
```

By hand, it is one `GET`, and the body is the image itself — `image/png` or
`image/jpeg`, see `Content-Type` — not JSON:

```bash
curl -sS "https://api.driftstack.dev/v1/agent-sessions/$ID/captures/$CAPTURE_ID" \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" -o step.png
```

Only the 20 most recent captures of a session are kept, and they can be
removed once 30 minutes pass without a new one, so fetch them as soon as the
message returns. An unknown or expired `captureId` is a `404`.

**A file the page downloaded.** If the task asked the agent to download
something ("download the September invoice"), the file lands here. This one
has no SDK method yet — make it with your language's own HTTP client and the
same `Authorization: Bearer` header. List the files, then fetch one by name:

```bash
curl -sS "https://api.driftstack.dev/v1/agent-sessions/$ID/downloads" \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY"
# {"files":[{"name":"invoice-september.pdf","size":51234,"mime":"application/pdf"}],"status":"ok"}

curl -sS "https://api.driftstack.dev/v1/agent-sessions/$ID/downloads/content?name=invoice-september.pdf&format=binary" \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" -o invoice-september.pdf
```

- `$ID` is the agent session's `id`, `$CAPTURE_ID` a step's `captureId`, and
  `name` the bare file name from the list — never a path.
- Both download replies are discriminated on `status`, and only `ok` is a
  success: `unavailable` (the session is not running), `timeout` and `error`
  (`reason` says why) all arrive as `200` with `files: null` / `file: null`.
  **Read `status` before you trust the bytes** — with `format=binary` a failure
  still comes back as that small JSON envelope, so a plain `-o` can write the
  envelope into your file.
- Leave `format` off and you get
  `{"file": {"name", "mime", "dataB64"}, "status": "ok"}` with the bytes
  base64-encoded instead. Fetches are capped at 64 MiB.

Full details: [fetch a captured screenshot](/api/agent-sessions/#fetch-a-captured-screenshot),
[list downloads](/api/agent-sessions/#list-downloads),
[fetch a download](/api/agent-sessions/#fetch-a-download).

## When the agent stops to ask

The agent asks in three ways:

- **`kind: "clarify"`** — it needs more information before it starts. Send the
  answer as your next message.
- **`plan-executed` with a `notice`** — it asked something, or hit a limit,
  part-way through. `notice_reason` says which without reading the sentence:
  `question` means answer it as the next message; `step_limit`, `time_limit`,
  `ai_unavailable` and (once you have checked the page) `repeated_step` mean
  send "continue"; `budget_low` means start a new session; `no_progress` and
  `declined` mean a person should look. The full table is in
  [Read what came back](#read-what-came-back).
- **A `confirmation_required` step** — the next step would make a purchase, a
  payment, or delete an account, so it was held and did not run. `ok` is
  `false`:

  ```json
  {
    "kind": "confirmation_required",
    "intent": { "kind": "interact", "action": "tap", "selector": "#pay" },
    "category": "payment",
    "matchedText": "Pay now"
  }
  ```

To approve, send the same message again **as the very next message on the
session**, with a new `Idempotency-Key` and the approval:

```json
{
  "user_message": "Open https://portal.example.com/invoices, find the invoice for September 2026 and tell me its total amount.",
  "approve_consequential_actions": [{ "category": "payment", "matched_text": "Pay now" }]
}
```

- The result says `matchedText`; the request field is `matched_text`. The
  SDKs rename it for you: pass `{ category, matchedText }` to
  `approveConsequentialActions` in TypeScript, the held step itself in
  Python, and `driftstack.ApprovalFor(step)` in Go.
- The agent carries on from the step it held; it does not plan the task again.
  On the included AI, an approval message does not count another $0.10.
- If any other message comes in between, the approval no longer applies: the
  agent plans afresh and asks again.
- **In an unattended job, do not approve automatically.** Alert a person, and
  close the session.

## Stop a task that runs too long

`message()` waits until the task ends, so stop it from somewhere else — a
timer, or a second worker — with `POST /v1/agent-sessions/{id}/stop`:

- `202 {"status": "stop_requested"}` — a task was running and has been asked
  to stop. Your pending message then returns `kind: "stopped"` with the steps
  that ran and a `notice` saying how far it got.
- `200 {"status": "no_turn_running"}` — nothing was running. If your own
  message is still waiting, ask again a second later.
- `503` with `stop_unconfirmed: true` — the stop could not be confirmed and
  the task may still be running. Call it again. A `503` **without** that field
  means AI is not enabled on this deployment, and calling again will not help.

The SDKs hand you that `status` to branch on — `stop(id)` in TypeScript,
`stop(id)` in Python (sync and async) and `Stop(ctx, id)` in Go all return the
`{ status, session_id }` body above, and raise the `503` as the typed
feature-unavailable error with `stop_unconfirmed` among its extra fields
(`err.extensions` / `err.problem` / `err.Problem`). None of them retries a stop
for you, so the "call it again" above is yours to do.

Stopping is safe to repeat. A step that was already running is given a short
time to finish so its result is known; nothing starts after it. The session
stays open for the next message.

Two harder limits sit behind it: the session's `token_budget` (when it runs
out, the session closes), and `DELETE /v1/agent-sessions/{id}`, which ends the
session outright.

## Close the session

`DELETE /v1/agent-sessions/{id}` returns `204` and is safe to repeat. Close in
a `finally` block (`defer` in Go), after you have fetched any screenshots and
files:

- it frees one of your open-session slots;
- it saves the profile's cookies and storage, so tomorrow's run is still
  signed in;
- it stops a turn that is still running, so closing to cut a task short does
  not leave you paying out an AI call you will never read. That message answers
  the same `stopped` result `POST /{id}/stop` gives.

A session can also end on its own — when its token budget runs out, when its
history is full, when its proxy's exit IP changes (`stop_on_exit_ip_change`),
or when the browser behind it ends it, for example after sitting idle. It then
reads `status: "closed"` with a `closed_reason`, and a message to it returns
`409` with `session_status: "closed"`.

## Errors and safe retries

The SDKs raise these as typed errors: `err.extensions` in TypeScript,
`err.problem` in Python and `err.Problem` in Go carry the extra fields shown
here. See the [error reference](/reference/errors/) for every class.

| Status | `type`                         | When                                                                                                                                                                                  | What to do                                                                                                                                                                                                                                                                                            |
| -----: | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    400 | `validation-failed`            | The body is wrong, e.g. `user_message` over 8,000 characters.                                                                                                                         | Fix the request.                                                                                                                                                                                                                                                                                      |
|    401 | `unauthorized`                 | The API key is missing or invalid.                                                                                                                                                    | Fix the key.                                                                                                                                                                                                                                                                                          |
|    402 | `bundled-llm-consent-required` | No key of your own and no opt-in to the included AI.                                                                                                                                  | See [Who pays for the AI](#who-pays-for-the-ai).                                                                                                                                                                                                                                                      |
|    402 | `bundled-llm-budget-exhausted` | This month's included budget is used up.                                                                                                                                              | Raise the cap, add your own key, or wait.                                                                                                                                                                                                                                                             |
|    403 | `forbidden`                    | The key lacks `write`; the plan has no AI agent or no longer includes the included AI; or the session's model runs only on your own key (`requires_own_key`, with `model` naming it). | Fix the key, plan or model.                                                                                                                                                                                                                                                                           |
|    404 | `not-found`                    | The session does not exist or is not yours.                                                                                                                                           | Check the id.                                                                                                                                                                                                                                                                                         |
|    409 | `conflict`                     | `turn_in_progress: true` — another message is still running on this session.                                                                                                          | Wait for it, or stop it.                                                                                                                                                                                                                                                                              |
|    409 | `conflict`                     | `session_status: "closed"` or `"paused"` — the session was not active, or ended mid-message; `closed_reason` says why it closed, and `partial_results` lists any steps that did run.  | Check `partial_results`, then resume a paused session or start a new one.                                                                                                                                                                                                                             |
|    409 | `conflict`                     | `idempotency_status: "in_progress"` — the first attempt with this key is still running.                                                                                               | Wait, then send again with the **same** key.                                                                                                                                                                                                                                                          |
|    409 | `conflict`                     | `idempotency_status: "mismatch"` — this key was used for a different message.                                                                                                         | Use a new key.                                                                                                                                                                                                                                                                                        |
|    409 | `conflict`                     | `ai_control_unavailable: true` — a person took control of the session from the desktop app while your message was running, so it stopped early.                                       | Read `partial_results` before repeating anything; send the task again with a new key once the AI has control.                                                                                                                                                                                         |
|    429 | `rate-limited`                 | Too many requests, or your account already has the most AI messages it may run at once — across your sessions, or on the included AI.                                                 | Wait `retry_after_seconds` (also in `Retry-After`), then send the same message again.                                                                                                                                                                                                                 |
|    429 | `concurrency-limit`            | At create only: too many open sessions.                                                                                                                                               | Close one, or wait for one to finish.                                                                                                                                                                                                                                                                 |
|    500 | `internal`                     | Something went wrong on our side. It is never about your key.                                                                                                                         | Try again later with a new key; contact support if it keeps happening.                                                                                                                                                                                                                                |
|    502 | `byok-anthropic-required`      | No Anthropic key could be found for the message — or, with `key_rejected: true`, Anthropic refused yours on the first planning call.                                                  | Without `key_rejected`, see [Who pays for the AI](#who-pays-for-the-ai). With it, `key_source` says which key and `key_rejected_reason` whether to replace it (`invalid_or_unauthorized`) or fix billing with Anthropic (`billing`); [test it](/api/byok-anthropic/#test-connection) after.           |
|    503 | `feature-unavailable`          | You sent an `Idempotency-Key` and it could not be recorded, so the message did not run.                                                                                               | **Not transient**: this deployment cannot record keys, so the same key fails the same way. The same message **without** the header runs the turn — do that only if running the task twice would be safe, since that protection is what you are giving up. See [Idempotency](/reference/idempotency/). |

Retrying a message safely — which key to send:

- **The same key, after a refusal that did no work.** Nothing ran, so the key
  is given back and the same request runs the turn once the cause is gone:

  | Status | `type`                         | The refusal                                                         |
  | -----: | ------------------------------ | ------------------------------------------------------------------- |
  |    409 | `conflict`                     | `turn_in_progress: true`                                            |
  |    429 | `rate-limited`                 | the message rate, or too many AI messages running at once           |
  |    402 | `bundled-llm-consent-required` | not opted in to the included AI                                     |
  |    402 | `bundled-llm-budget-exhausted` | this month's included-AI budget is used up                          |
  |    403 | `forbidden`                    | the included AI is not on the plan, or the model needs your own key |
  |    502 | `byok-anthropic-required`      | no Anthropic key was available — **without** `key_rejected: true`   |

- **The same key, when you got no response** (the connection dropped, your
  process restarted). You get the stored result, or `409` with
  `idempotency_status: "in_progress"` while the first attempt is still being
  resolved — also safe to retry with the same key.
- **A new key for everything else.** Every other answer is final for its key
  and sending it again replays it: a finished turn, any failure after the turn
  started, `502` with `key_rejected: true`, `500`, a `200` with
  `kind: "refuse"`, and the `409` for a session that is closed or paused.
- **Check before you repeat work that changes things.** After a `5xx`, or a
  `409` that carries `partial_results`, some steps may already have run. Look
  at the page or the transcript before you send the task again.
- The SDKs never retry `message()` for you, and a streamed message carries its
  errors inside the stream: the SDKs raise them as the same typed errors.

With curl, a missing or invalid key, a key without the `write` scope, and the
request-rate `429` are ordinary HTTP errors. Every other outcome — including a
bad body, an unknown session, and the `429` for too many AI messages running —
arrives in the final `response` event with the status inside it, so read
`status` from there.

## Limits

| Limit                                             | Value                                                                                      | When you reach it                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Open agent sessions                               | Your plan's concurrent-session number ([session lifecycle](/guides/session-lifecycle/))    | `429 concurrency-limit` at create                                            |
| Open sessions per profile                         | 1                                                                                          | `409 profile-in-use` at create                                               |
| Messages running at once, per session             | 1                                                                                          | `409 conflict` with `turn_in_progress: true`                                 |
| AI messages running at once, per account          | 3                                                                                          | `429 rate-limited`, retry after 5 seconds                                    |
| Included-AI messages running at once, per account | 3                                                                                          | `429 rate-limited`, retry after 5 seconds                                    |
| Message rate                                      | The `agent_sessions:message` bucket for your plan ([rate limits](/reference/rate-limits/)) | `429 rate-limited`                                                           |
| Message length                                    | 8,000 characters                                                                           | `400 validation-failed`                                                      |
| Model tokens per session                          | `token_budget` (default 100,000)                                                           | The session closes with `closed_reason: "budget-exhausted"`                  |
| Session history                                   | 256 entries or 1 MiB                                                                       | The next message closes the session with `closed_reason: "transcript-limit"` |
| New steps per message                             | About three minutes of work                                                                | `plan-executed` with a `notice`; send "continue"                             |
| Live transcript streams, per account              | 10                                                                                         | `429`, retry after 30 seconds                                                |

A message normally adds two or three entries to the session history. To keep
going after a session closes, create a new one with
`continue_from_agent_session_id` set to the closed session's id: it starts with
that session's recent conversation.

## Watch it live (optional)

- **Step by step, from an SDK:** pass `onStep` to `message()` to get each
  step as it finishes, and `onEvent` for the other progress events
  (`on_step` / `on_event` in Python, `OnStep` / `OnEvent` in Go). In
  TypeScript:

  ```ts
  const reply = await client.agentSessions.message(sessionId, task, {
    idempotencyKey: randomUUID(),
    onStep: ({ index, result }) => console.log(`step ${index + 1}: ${result.kind}`),
    onEvent: ({ type, data }) => {
      if (type === 'step_start') console.log('now:', (data as { label: string }).label);
    },
  });
  ```

- **In any language:** the streamed response carries these events before the
  final one. Ignore event names you do not recognise — new ones are added over
  time — and treat `response` as the only result:

  | `event`      | `data`                                                                                   |
  | ------------ | ---------------------------------------------------------------------------------------- |
  | `phase`      | `{ phase }` — `planning`, `starting_browser`, `executing`, `reading_page` or `answering` |
  | `plan`       | `{ total, intents, labels }` — the steps it is about to run                              |
  | `step_start` | `{ index, total, label }` — a step is starting, e.g. "Opening portal.example.com"        |
  | `step`       | `{ index, result }` — a step finished                                                    |
  | `answer`     | `{ answer }`                                                                             |
  | `notice`     | `{ notice, notice_reason }`                                                              |
  | `response`   | `{ status, body }` — the result; always last                                             |

- **The whole conversation:** `transcript(id)` in TypeScript and Python,
  `Transcript(ctx, id, opts, fn)` in Go, reads every entry already in the
  session's history, oldest first, and then follows it live over the
  [transcript stream](/api/agent-sessions/#live-transcript-stream-sse)
  (`GET /v1/agent-sessions/{id}/transcript`). It does not end by itself while
  the session is open, so leave the loop when you have what you need — that
  closes the connection. To read only what is there now, take
  `transcript_length` from `get(id)` first and stop at `index ===
transcript_length - 1`:

  ```ts
  const { transcript_length } = await client.agentSessions.get(sessionId);
  if (transcript_length > 0) {
    for await (const { index, entry } of client.agentSessions.transcript(sessionId)) {
      console.log(index, entry.role, entry.body);
      if (index === transcript_length - 1) break;
    }
  }
  ```

  Pass the last `index` you saw back as `lastEventId` (`last_event_id`,
  `LastEventID`) to carry on where you left off. An account may hold 10
  transcript streams open at once.

- **Watch the screen:** see [live video](/guides/live-video/), or open the
  session in the desktop app.

## Run it again tomorrow on the same profile

- Create a **new session each run** with the same `profile_id`, and close it
  at the end. Only one session can be open on a profile at a time.
- If a create returns `409 profile-in-use`, an earlier run did not close its
  session. Close the session named in `active_session_id`, then create again.
- Or sweep at the start of the job: `GET /v1/agent-sessions` (`list()` /
  `iterate()` in the SDKs) returns your sessions newest first. There is no
  status filter, so skip the ones whose `status` is `closed` and close the
  rest.
- To notice that the portal signed the profile out, add to your task: _"If you
  see a sign-in page, stop and tell me."_ Then check `answer` and `notice`.
  Alert a person rather than sending a password in a message.

## Complete examples

Each program starts a session on your profile, waits until it is ready, sends
the task, answers one question if the agent asks, holds any payment for a
person (or approves it when you set `APPROVE_ACTIONS=yes`), stops the task
after ten minutes, prints the steps and the answer, and always closes the
session.

The option names each SDK uses:

| Option                        | TypeScript                    | Python                          | Go                            |
| ----------------------------- | ----------------------------- | ------------------------------- | ----------------------------- |
| Idempotency key for a message | `idempotencyKey`              | `idempotency_key`               | `IdempotencyKey`              |
| Approve a held step           | `approveConsequentialActions` | `approve_consequential_actions` | `ApproveConsequentialActions` |
| Your own Anthropic key        | `byokApiKey`                  | `byok_api_key`                  | `ByokAPIKey`                  |
| Each step as it finishes      | `onStep`                      | `on_step`                       | `OnStep`                      |
| Other progress events         | `onEvent`                     | `on_event`                      | `OnEvent`                     |

### TypeScript

```ts
// run-invoice-task.ts — ask the AI to read this month's invoice total from a supplier portal.
// Run: DRIFTSTACK_API_KEY=ds_live_... PROFILE_ID=prof_... npx tsx run-invoice-task.ts
import { randomUUID } from 'node:crypto';
import {
  Driftstack,
  ConflictError,
  ProfileInUseError,
  RateLimitError,
  TransportError,
  type AgentIntentResult,
  type AgentMessageResponse,
  type ConsequentialActionCategory,
} from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const PROFILE_ID = process.env.PROFILE_ID!; // a profile you signed in to once, by hand
const TASK =
  'Open https://portal.example.com/invoices, find the invoice for September 2026 ' +
  'and tell me its total amount.';
// What the job answers if the agent asks a question part-way.
const REPLY_TO_QUESTIONS =
  'Use the invoice dated September 2026 and tell me its total. Do not pay anything.';
// Leave this off for an unattended job: a person should approve payments.
const APPROVE_ACTIONS = process.env.APPROVE_ACTIONS === 'yes';
const STOP_AFTER_MS = 10 * 60_000;

type Approval = { category: ConsequentialActionCategory; matchedText: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A new session is `provisioning` until its browser is ready.
async function waitUntilReady(id: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const session = await client.agentSessions.get(id);
    if (session.status === 'active') return;
    if (session.status === 'closed') {
      throw new Error(`The session ended before it was ready: ${session.closed_reason}`);
    }
    await sleep(2_000);
  }
  throw new Error('The session was not ready after two minutes');
}

// One message = one Idempotency-Key. Retrying with the same key never runs the task twice.
async function send(
  id: string,
  text: string,
  approvals: Approval[] = [],
): Promise<AgentMessageResponse> {
  const idempotencyKey = randomUUID();
  // If the task runs too long, ask it to stop; this message then returns kind "stopped".
  const stopTimer = setTimeout(() => {
    client.agentSessions.stop(id).catch(() => undefined);
  }, STOP_AFTER_MS);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.agentSessions.message(id, text, {
          idempotencyKey,
          ...(approvals.length > 0 ? { approveConsequentialActions: approvals } : {}),
          onStep: ({ index, result }) => console.log(`  step ${index + 1}: ${describe(result)}`),
        });
      } catch (err) {
        // No response at all, or the first attempt is still running:
        // ask again with the SAME key. Any other error is final for this key.
        const stillRunning =
          err instanceof ConflictError && err.extensions['idempotency_status'] === 'in_progress';
        if ((err instanceof TransportError || stillRunning) && attempt < 6) {
          await sleep(5_000 * attempt);
          continue;
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(stopTimer);
  }
}

function describe(result: AgentIntentResult): string {
  switch (result.kind) {
    case 'success':
      return result.captureId === undefined
        ? `done: ${result.summary}`
        : `done: ${result.summary} (screenshot ${result.captureId})`;
    case 'failure':
      return `failed: ${result.reason} (${result.diagnosis?.category ?? 'unknown'})`;
    case 'confirmation_required':
      return `waiting for approval: ${result.category} "${result.matchedText}"`;
  }
}

function report(reply: AgentMessageResponse): void {
  switch (reply.kind) {
    case 'plan-executed':
      if (reply.notice !== undefined) {
        // `notice_reason` is what an unattended job branches on; the sentence
        // is what a person reads. See "Read what came back".
        console.log(`Not finished (${reply.notice_reason ?? 'no reason given'}): ${reply.notice}`);
      } else if (!reply.ok)
        console.log('A step failed or is waiting for approval; see the steps above.');
      if (reply.answer !== undefined) console.log(`Answer: ${reply.answer}`);
      break;
    case 'clarify':
      console.log(`The agent still has a question: ${reply.clarifying_question}`);
      break;
    case 'refuse':
      console.log(`Refused: ${reply.refuse_reason}`);
      break;
    case 'stopped':
      console.log(`Stopped while ${reply.stopped_during}: ${reply.notice}`);
      break;
    default:
      console.log(`Unexpected result: ${reply.kind}`);
  }
}

async function main(): Promise<void> {
  const session = await client.agentSessions.create(
    { mode: 'ai', profile_id: PROFILE_ID, token_budget: 100_000 },
    { idempotencyKey: randomUUID() },
  );
  try {
    await waitUntilReady(session.id);
    let reply = await send(session.id, TASK);
    const approvals: Approval[] = [];
    for (let followUps = 0; followUps < 3; followUps++) {
      if (reply.kind === 'clarify') {
        console.log(`The agent asked: ${reply.clarifying_question}`);
        reply = await send(session.id, REPLY_TO_QUESTIONS);
        continue;
      }
      const last = reply.kind === 'plan-executed' ? reply.results.at(-1) : undefined;
      if (last?.kind === 'confirmation_required') {
        if (!APPROVE_ACTIONS) {
          console.log(`A person must approve: ${last.category} "${last.matchedText}"`);
          break;
        }
        // Approve by sending the same task again, as the very next message.
        approvals.push({ category: last.category, matchedText: last.matchedText });
        reply = await send(session.id, TASK, approvals);
        continue;
      }
      break;
    }
    report(reply);
  } finally {
    // Always close: it frees the slot and saves the profile's sign-in.
    await client.agentSessions.close(session.id);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ProfileInUseError) {
    console.error(`The profile is in use by ${err.activeSessionId}; close that session first.`);
  } else if (err instanceof RateLimitError) {
    console.error(`Too many requests; try again in ${err.retryAfterSeconds}s.`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
```

### Python

```python
# run_invoice_task.py — ask the AI to read this month's invoice total from a supplier portal.
# Run: DRIFTSTACK_API_KEY=ds_live_... PROFILE_ID=prof_... python run_invoice_task.py
import os
import threading
import time
import uuid
from typing import Any

from driftstack import ConflictError, Driftstack, ProfileInUseError, RateLimitError, TransportError

API_KEY = os.environ["DRIFTSTACK_API_KEY"]
PROFILE_ID = os.environ["PROFILE_ID"]  # a profile you signed in to once, by hand
TASK = (
    "Open https://portal.example.com/invoices, find the invoice for September 2026 "
    "and tell me its total amount."
)
# What the job answers if the agent asks a question part-way.
REPLY_TO_QUESTIONS = (
    "Use the invoice dated September 2026 and tell me its total. Do not pay anything."
)
# Leave this off for an unattended job: a person should approve payments.
APPROVE_ACTIONS = os.environ.get("APPROVE_ACTIONS") == "yes"
STOP_AFTER_SECONDS = 10 * 60

client = Driftstack(api_key=API_KEY)


def wait_until_ready(session_id: str) -> None:
    """A new session is `provisioning` until its browser is ready."""
    for _ in range(60):
        session = client.agent_sessions.get(session_id)
        if session["status"] == "active":
            return
        if session["status"] == "closed":
            raise RuntimeError(f"The session ended before it was ready: {session['closed_reason']}")
        time.sleep(2)
    raise RuntimeError("The session was not ready after two minutes")


def stop_turn(session_id: str) -> None:
    # Runs on a timer thread, so it uses a client of its own.
    with Driftstack(api_key=API_KEY) as timer_client:
        timer_client.agent_sessions.stop(session_id)


def describe(result: dict[str, Any]) -> str:
    if result["kind"] == "success":
        shot = f" (screenshot {result['captureId']})" if "captureId" in result else ""
        return f"done: {result['summary']}{shot}"
    if result["kind"] == "failure":
        category = (result.get("diagnosis") or {}).get("category", "unknown")
        return f"failed: {result['reason']} ({category})"
    if result["kind"] == "confirmation_required":
        return f'waiting for approval: {result["category"]} "{result["matchedText"]}"'
    return str(result["kind"])


def show_step(step: dict[str, Any]) -> None:
    print(f"  step {step['index'] + 1}: {describe(step['result'])}")


def send(
    session_id: str, text: str, approvals: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """One message = one Idempotency-Key. Retrying with the same key never runs the task twice."""
    idempotency_key = str(uuid.uuid4())
    # If the task runs too long, ask it to stop; this message then returns kind "stopped".
    stop_timer = threading.Timer(STOP_AFTER_SECONDS, stop_turn, args=(session_id,))
    stop_timer.start()
    try:
        for attempt in range(1, 7):
            try:
                return client.agent_sessions.message(
                    session_id,
                    text,
                    idempotency_key=idempotency_key,
                    approve_consequential_actions=approvals,
                    on_step=show_step,
                )
            except (TransportError, ConflictError) as err:
                # No response at all, or the first attempt is still running:
                # ask again with the SAME key. Any other error is final for this key.
                still_running = (
                    isinstance(err, ConflictError)
                    and err.problem.get("idempotency_status") == "in_progress"
                )
                if (isinstance(err, TransportError) or still_running) and attempt < 6:
                    time.sleep(5 * attempt)
                    continue
                raise
        raise RuntimeError("unreachable")
    finally:
        stop_timer.cancel()


def report(reply: dict[str, Any]) -> None:
    kind = reply["kind"]
    if kind == "plan-executed":
        if "notice" in reply:
            # `notice_reason` is what an unattended job branches on; the
            # sentence is what a person reads. See "Read what came back".
            reason = reply.get("notice_reason", "no reason given")
            print(f"Not finished ({reason}): {reply['notice']}")
        elif not reply["ok"]:
            print("A step failed or is waiting for approval; see the steps above.")
        if "answer" in reply:
            print(f"Answer: {reply['answer']}")
    elif kind == "clarify":
        print(f"The agent still has a question: {reply['clarifying_question']}")
    elif kind == "refuse":
        print(f"Refused: {reply['refuse_reason']}")
    elif kind == "stopped":
        print(f"Stopped while {reply['stopped_during']}: {reply['notice']}")
    else:
        print(f"Unexpected result: {kind}")


def main() -> None:
    session = client.agent_sessions.create(
        {"mode": "ai", "profile_id": PROFILE_ID, "token_budget": 100_000},
        idempotency_key=str(uuid.uuid4()),
    )
    session_id = session["id"]
    try:
        wait_until_ready(session_id)
        reply = send(session_id, TASK)
        approvals: list[dict[str, Any]] = []
        for _ in range(3):
            if reply["kind"] == "clarify":
                print(f"The agent asked: {reply['clarifying_question']}")
                reply = send(session_id, REPLY_TO_QUESTIONS)
                continue
            results = reply.get("results") or []
            last = results[-1] if reply["kind"] == "plan-executed" and results else None
            if last is not None and last["kind"] == "confirmation_required":
                if not APPROVE_ACTIONS:
                    print(f'A person must approve: {last["category"]} "{last["matchedText"]}"')
                    break
                # Approve by sending the same task again, as the very next message.
                # Pass the held step back as it came: the SDK sends its matchedText
                # as the request's matched_text.
                approvals.append(last)
                reply = send(session_id, TASK, approvals)
                continue
            break
        report(reply)
    finally:
        # Always close: it frees the slot and saves the profile's sign-in.
        client.agent_sessions.close(session_id)


if __name__ == "__main__":
    try:
        main()
    except ProfileInUseError as err:
        raise SystemExit(
            f"The profile is in use by {err.active_session_id}; close that session first."
        ) from err
    except RateLimitError as err:
        raise SystemExit(f"Too many requests; try again in {err.retry_after_seconds}s.") from err
```

### Go

```go
// run-invoice-task — ask the AI to read this month's invoice total from a supplier portal.
// Run: DRIFTSTACK_API_KEY=ds_live_... PROFILE_ID=prof_... go run .
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

const (
	task = "Open https://portal.example.com/invoices, find the invoice for September 2026 " +
		"and tell me its total amount."
	// What the job answers if the agent asks a question part-way.
	replyToQuestions = "Use the invoice dated September 2026 and tell me its total. Do not pay anything."
	stopAfter        = 10 * time.Minute
)

// Leave this off for an unattended job: a person should approve payments.
var approveActions = os.Getenv("APPROVE_ACTIONS") == "yes"

func newKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// waitUntilReady polls while a new session is `provisioning`.
func waitUntilReady(ctx context.Context, client *driftstack.Client, id string) error {
	for i := 0; i < 60; i++ {
		session, err := client.AgentSessions.Get(ctx, id)
		if err != nil {
			return err
		}
		switch session.Status {
		case "active":
			return nil
		case "closed":
			reason := ""
			if session.ClosedReason != nil {
				reason = *session.ClosedReason
			}
			return fmt.Errorf("the session ended before it was ready: %s", reason)
		}
		time.Sleep(2 * time.Second)
	}
	return errors.New("the session was not ready after two minutes")
}

func describe(r driftstack.AgentIntentResult) string {
	switch r.Kind {
	case "success":
		if r.CaptureID != "" {
			return fmt.Sprintf("done: %s (screenshot %s)", r.Summary, r.CaptureID)
		}
		return "done: " + r.Summary
	case "failure":
		category := "unknown"
		if r.Diagnosis != nil {
			category = r.Diagnosis.Category
		}
		return fmt.Sprintf("failed: %s (%s)", r.Reason, category)
	case "confirmation_required":
		return fmt.Sprintf("waiting for approval: %s %q", r.Category, r.MatchedText)
	default:
		return r.Kind
	}
}

// send runs one message. One message = one Idempotency-Key: retrying with the
// same key never runs the task twice.
func send(ctx context.Context, client *driftstack.Client, id, text string,
	approvals []driftstack.ConsequentialActionApproval) (*driftstack.AgentMessageResponse, error) {
	key := newKey()
	// If the task runs too long, ask it to stop; this message then returns kind "stopped".
	stopTimer := time.AfterFunc(stopAfter, func() {
		_, _ = client.AgentSessions.Stop(context.Background(), id)
	})
	defer stopTimer.Stop()
	for attempt := 1; ; attempt++ {
		reply, err := client.AgentSessions.Message(ctx, id, text, &driftstack.MessageOptions{
			IdempotencyKey:              key,
			ApproveConsequentialActions: approvals,
			OnStep: func(step driftstack.AgentStepEvent) {
				fmt.Printf("  step %d: %s\n", step.Index+1, describe(step.Result))
			},
		})
		if err == nil {
			return reply, nil
		}
		// No response at all, or the first attempt is still running:
		// ask again with the SAME key. Any other error is final for this key.
		var conflict *driftstack.ConflictError
		stillRunning := errors.As(err, &conflict) && conflict.Problem["idempotency_status"] == "in_progress"
		if (errors.Is(err, driftstack.ErrTransport) || stillRunning) && attempt < 6 {
			time.Sleep(time.Duration(5*attempt) * time.Second)
			continue
		}
		return nil, err
	}
}

func report(reply *driftstack.AgentMessageResponse) {
	switch reply.Kind {
	case "plan-executed":
		if reply.Notice != "" {
			// NoticeReason is what an unattended job switches on; the sentence
			// is what a person reads. See "Read what came back".
			reason := reply.NoticeReason
			if reason == "" {
				reason = "no reason given"
			}
			fmt.Printf("Not finished (%s): %s\n", reason, reply.Notice)
		} else if !reply.OK {
			fmt.Println("A step failed or is waiting for approval; see the steps above.")
		}
		if reply.Answer != "" {
			fmt.Println("Answer:", reply.Answer)
		}
	case "clarify":
		fmt.Println("The agent still has a question:", reply.ClarifyingQuestion)
	case "refuse":
		fmt.Println("Refused:", reply.RefuseReason)
	case "stopped":
		fmt.Printf("Stopped while %s: %s\n", reply.StoppedDuring, reply.Notice)
	default:
		fmt.Println("Unexpected result:", reply.Kind)
	}
}

func run(ctx context.Context, client *driftstack.Client) error {
	session, err := client.AgentSessions.Create(ctx, &driftstack.CreateAgentSessionRequest{
		Mode:        "ai",
		ProfileID:   os.Getenv("PROFILE_ID"), // a profile you signed in to once, by hand
		TokenBudget: 100000,
	}, &driftstack.CreateOptions{IdempotencyKey: newKey()})
	if err != nil {
		var busy *driftstack.ProfileInUseError
		if errors.As(err, &busy) {
			return fmt.Errorf("the profile is in use by %s; close that session first", busy.ActiveSessionID)
		}
		return err
	}
	// Always close: it frees the slot and saves the profile's sign-in.
	defer func() {
		if err := client.AgentSessions.Close(context.Background(), session.ID); err != nil {
			log.Printf("close failed: %v", err)
		}
	}()

	if err := waitUntilReady(ctx, client, session.ID); err != nil {
		return err
	}
	reply, err := send(ctx, client, session.ID, task, nil)
	if err != nil {
		return err
	}
	var approvals []driftstack.ConsequentialActionApproval
	for followUps := 0; followUps < 3; followUps++ {
		if reply.Kind == "clarify" {
			fmt.Println("The agent asked:", reply.ClarifyingQuestion)
			if reply, err = send(ctx, client, session.ID, replyToQuestions, nil); err != nil {
				return err
			}
			continue
		}
		steps, err := reply.ParsedResults()
		if err != nil {
			return err
		}
		if reply.Kind != "plan-executed" || len(steps) == 0 || steps[len(steps)-1].Kind != "confirmation_required" {
			break
		}
		last := steps[len(steps)-1]
		if !approveActions {
			fmt.Printf("A person must approve: %s %q\n", last.Category, last.MatchedText)
			break
		}
		// Approve by sending the same task again, as the very next message.
		approvals = append(approvals, driftstack.ApprovalFor(last))
		if reply, err = send(ctx, client, session.ID, task, approvals); err != nil {
			return err
		}
	}
	report(reply)
	return nil
}

func main() {
	client := driftstack.New(os.Getenv("DRIFTSTACK_API_KEY"))
	defer client.Close()
	if err := run(context.Background(), client); err != nil {
		var limited *driftstack.RateLimitError
		if errors.As(err, &limited) {
			log.Printf("too many requests; try again in %ds", limited.RetryAfterSeconds)
		}
		log.Print(err)
		os.Exit(1)
	}
}
```

### curl

The same flow with raw HTTP, as a shell script. It needs `jq`, and `uuidgen`
for the keys.

```bash
#!/usr/bin/env bash
# run-invoice-task.sh — ask the AI to read this month's invoice total from a supplier portal.
# Run: DRIFTSTACK_API_KEY=ds_live_... PROFILE_ID=prof_... bash run-invoice-task.sh
: "${DRIFTSTACK_API_KEY:?set DRIFTSTACK_API_KEY to your API key}"
: "${PROFILE_ID:?set PROFILE_ID to the prof_… you signed in by hand}"
API=https://api.driftstack.dev
AUTH="Authorization: Bearer $DRIFTSTACK_API_KEY"
TASK='Open https://portal.example.com/invoices, find the invoice for September 2026 and tell me its total amount.'

# 1. Start a session on the signed-in profile. Keep CREATE_KEY to retry the create safely.
CREATE_KEY=$(uuidgen)
jq -n --arg p "$PROFILE_ID" '{mode: "ai", profile_id: $p, token_budget: 100000}' > create.json
curl -sS "$API/v1/agent-sessions" -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" --data @create.json > session.json
ID=$(jq -r .id session.json)
[ "$ID" != null ] || { cat session.json; exit 1; } # for example 409 profile-in-use

# 2. Wait until it is ready: `provisioning` becomes `active`.
while :; do
  STATUS=$(curl -sS "$API/v1/agent-sessions/$ID" -H "$AUTH" | jq -r .status)
  [ "$STATUS" = active ] && break
  [ "$STATUS" = closed ] && { echo "The session ended before it was ready."; exit 1; }
  sleep 2
done

# 3. send FILE — one message, streamed, under a new Idempotency-Key. The last event,
#    `response`, carries { status, body }; it is saved to result.json.
send() {
  TURN_KEY=$(uuidgen)
  curl -sS -N --max-time 3000 "$API/v1/agent-sessions/$ID/message" -H "$AUTH" \
    -H "Content-Type: application/json" -H "Accept: text/event-stream" \
    -H "Idempotency-Key: $TURN_KEY" --data @"$1" > turn.sse
  awk '/^event: response$/ { getline; sub(/^data: /, ""); print }' turn.sse > result.json
  # No `response` event: an ordinary HTTP error (bad key, missing scope, too
  # many requests) or a dropped connection. The body says which.
  [ -s result.json ] || { cat turn.sse; exit 1; }
  jq '{status, kind: .body.kind, ok: .body.ok, answer: .body.answer, notice: .body.notice,
       notice_reason: .body.notice_reason, question: .body.clarifying_question,
       steps: [.body.results[]? | .kind]}' result.json
}

jq -n --arg m "$TASK" '{user_message: $m}' > message.json
send message.json

# 4a. It asked a question (kind "clarify"): answer it as the next message.
if [ "$(jq -r .body.kind result.json)" = clarify ]; then
  jq -n '{user_message: "Use the invoice dated September 2026 and tell me its total. Do not pay anything."}' > reply.json
  send reply.json
fi

# 4b. A step is held for approval: approve it (only with APPROVE_ACTIONS=yes) by sending
#     the same task again, as the very next message, with the approval.
HELD=$(jq -r '.body.results[-1].kind // empty' result.json)
if [ "$HELD" = confirmation_required ] && [ "${APPROVE_ACTIONS:-}" = yes ]; then
  jq -n --arg m "$TASK" --slurpfile r result.json '{user_message: $m,
    approve_consequential_actions: [{category: $r[0].body.results[-1].category,
                                     matched_text: $r[0].body.results[-1].matchedText}]}' \
    > approve.json
  send approve.json
fi

# 5. To stop a task that runs too long, run this from another shell while `send` waits;
#    the waiting message then ends with kind "stopped":
#    curl -sS -X POST "$API/v1/agent-sessions/$ID/stop" -H "$AUTH" -H "Content-Type: application/json" -d '{}'

# 6. Always close the session: it frees the slot and saves the profile's sign-in. Prints 204.
curl -sS -X DELETE "$API/v1/agent-sessions/$ID" -H "$AUTH" -o /dev/null -w '%{http_code}\n'
```

If the `curl` inside `send` loses its connection, run it again with the same
`TURN_KEY`: you get the stored result, or a `409` with
`idempotency_status: "in_progress"` while the task is still running.

## Related

- [Agent sessions API reference](/api/agent-sessions/) — every field, endpoint
  and error.
- [BYOK Anthropic key](/api/byok-anthropic/) and
  [Bundled LLM](/api/bundled-llm/) — paying for the AI.
- [Idempotency keys](/reference/idempotency/) — how keys are matched and how
  long they last.
- [Live video](/guides/live-video/) — watch the session's screen.
