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

At v1.0 the surface is write-only: `POST /v1/recipes`. Read /
list / execute / delete land at v1.1 (D2/D3 scope per the v2-#37
queue).

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
flattened intent_log; the actual intent array is captured but
not surfaced at v1.0 (it lands with the read/list endpoints at
v1.1).

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
|    503 | feature-unavailable | activation gate off (no agent-sessions repo wired in this deployment)    |

## Upcoming (v1.1)

- `GET /v1/recipes` — list the calling account's recipes
- `GET /v1/recipes/{id}` — read one recipe + its intent_log
- `POST /v1/recipes/{id}/execute` — replay against a new
  agent-session, skipping the decompose step
- `DELETE /v1/recipes/{id}` — delete (with the same audit log
  pattern as the rest of the customer surface)

These ship in the v1.1 D2/D3 scope per the founder verdict on
the v2-#37 queue.
