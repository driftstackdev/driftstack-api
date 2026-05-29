---
layout: ../../layouts/DocLayout.astro
title: Recipes
description: Snapshot a finished agent-session into a replayable recipe — capture the structured intent_log + transcript without re-paying decompose cost.
---

# Recipes

A **recipe** is an immutable snapshot of a finished
[agent-session](/api/agent-sessions/) — the structured intent_log
plus the full transcript at the moment of capture. Recipes let
customers replay the same flow later without re-paying the LLM
decompose cost.

The v1.0 surface covers create, list, read, and delete:
`POST /v1/recipes`, `GET /v1/recipes`, `GET /v1/recipes/{id}`, and
`DELETE /v1/recipes/{id}`. Recipe execution — replaying a recipe
against a new agent-session — lands at v1.1 (D2/D3 scope per the
v2-#37 queue).

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
to get the full replayable `intent_log`.

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
payload weight. Fetch a single recipe to get the replayable
intents. `next_cursor` is `null` on the last page.

## Get one

`GET /v1/recipes/{id}`

Returns a single recipe in full, including the replayable
`intent_log` array (the list endpoint omits it). A non-existent id
— or one belonging to another account — returns 404; the server
doesn't distinguish missing from forbidden, to avoid leaking
existence.

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
|    503 | feature-unavailable | activation gate off (recipe library or agent-sessions repo not wired)    |

## Upcoming (v1.1)

- `POST /v1/recipes/{id}/execute` — replay a recipe against a new
  agent-session, skipping the decompose step

This ships in the v1.1 D2/D3 scope per the Driftstack design
verdict on the v2-#37 queue.
