---
layout: ../../layouts/DocLayout.astro
title: Recipes
description: Save a finished agent-session as a recipe — capture its structured intent_log and transcript as a durable reference.
---

# Recipes

A **recipe** is an immutable snapshot of a finished
[agent-session](/api/agent-sessions/) — the structured intent_log
plus the full transcript at the moment of capture. Recipes preserve
a completed flow as a durable reference without re-running decomposition
to inspect its intent plan.

The current surface covers create, list, read, and delete:
`POST /v1/recipes`, `GET /v1/recipes`, `GET /v1/recipes/{id}`, and
`DELETE /v1/recipes/{id}`. There is no recipe-execution endpoint;
start a new agent-session to run another task.

## Resource shape

```json
{
  "id": "rec_<uuid>",
  "account_id": "<account-uuid>",
  "agent_session_id": "agt_<uuid> | null",
  "label": "my checkout flow",
  "description": "Snapshot of the example.com checkout session.",
  "intent_count": 12,
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>"
}
```

`agent_session_id` is `null` when the originating agent-session
has been deleted (ON DELETE SET NULL — the recipe survives the
source session's lifecycle). `intent_count` is the length of the
flattened intent_log. The list endpoint omits the intent array for
payload weight; fetch a single recipe with `GET /v1/recipes/{id}`
to get its public `intent_log`. Sensitive `type` steps retain their
selector, order, and `sensitive: true` marker but omit `value`. The
exact value remains inside the server's encrypted recipe payload and
is never exposed to an ordinary `read`-scope caller.

## Create

`POST /v1/recipes`

Request body:

```json
{
  "agent_session_id": "agt_<uuid>",
  "label": "my checkout flow",
  "description": "Snapshot of the example.com checkout session."
}
```

- `agent_session_id` — required. Must belong to the calling
  account; cross-account references return 404.
- `label` — required. 1-120 characters after trim.
- `description` — optional. Up to 2000 characters.

Response `201 Created` returns the resource above.

## List

`GET /v1/recipes`

Lists the calling account's recipes, newest first. Cursor-paginated:

- `limit` — optional. 1-100, defaults to 50.
- `cursor` — optional. Opaque cursor from a prior page's `next_cursor`.

Response `200 OK`:

```json
{
  "data": [],
  "has_more": true,
  "next_cursor": "<opaque> | null"
}
```

Each `data` entry is the resource shape above **without** the
`intent_log` array — list items carry only `intent_count` for
payload weight. Fetch a single recipe to get the public saved
steps. `next_cursor` is `null` on the last page.

## Suggest a label/description

`GET /v1/agent-sessions/{id}/recipe-suggestion`

Before deciding whether to save a session as a recipe, fetch a
deterministic label + description suggestion derived from that
session's own intent_log — the same data `POST /v1/recipes` would
capture. Read-only; safe to call speculatively (no recipe is created).

Response `200 OK`:

```json
{
  "suggested_label": "Fill form on example.com",
  "suggested_description": "Navigates to example.com, fills 2 fields, taps 1 element, submits.",
  "intent_count": 5
}
```

The suggestion is a heuristic over the session's own intents (distinct
navigate hostnames, interact-action counts) — not a cross-customer ML
model. It never inspects or trains on any other account's data. A
session with no navigate/interact intents still returns a usable
generic suggestion rather than an error. `id` uses the same cross-account
404 contract as the rest of this surface (existence not leaked).

## Get one

`GET /v1/recipes/{id}`

Returns a single recipe including its public `intent_log` array (the
list endpoint omits it). Sensitive `type` intents omit `value`, even
when sensitivity is inferred from a password, OTP, PIN, card, or API
key selector; these steps still carry `sensitive: true` so clients can
render them accurately. Other intent fields are unchanged. A
non-existent id — or one belonging to another account — returns 404;
the server doesn't distinguish missing from forbidden, to avoid
leaking existence.

## Delete

`DELETE /v1/recipes/{id}`

Deletes a recipe. Response `204 No Content`. A non-existent id — or
one belonging to another account — returns 404, the same
anti-enumeration contract as the rest of the customer surface.
Delete is **not** idempotent: deleting an already-deleted recipe
returns 404, not 204.

## Intent log assembly

When the route fires, the server walks the source agent-session's
transcript and flatMaps every `plan-executed` agent turn's
structured `intents` array into a single `intent_log`. The result
is captured atomically (insert-once; never edited) so the
historical snapshot survives any later session activity.

Recipe payloads are encrypted at rest. Public detail serialization
works from a copy and removes sensitive type values without changing
the stored intent log, preserving the exact server-side snapshot while
preventing a read-only API key or device key from retrieving saved
credentials.

Operator + user transcript entries don't carry intents — only
agent turns from a successful decompose+execute step contribute.
A session that ran exclusively in `mode='manual'` will produce a
recipe with `intent_count: 0` (because manual sessions log
operator entries, not decomposer plans). That's expected — the
recipe is still useful as a transcript-only snapshot.

## Errors

| Status | Type                | When                                                                     |
| -----: | ------------------- | ------------------------------------------------------------------------ |
|    400 | validation          | body fails schema (missing label, label > 120 chars, description > 2000) |
|    404 | not-found           | `agent_session_id` doesn't exist or belongs to another account           |
|    401 | unauthorized        | missing or invalid bearer token                                          |
|    503 | feature-unavailable | recipe storage is not enabled for this deployment                        |
