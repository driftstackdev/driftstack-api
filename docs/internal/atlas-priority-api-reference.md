# `/v1/internal/atlas-priority/*` — API reference

**Status:** LIVE (Tier-3 verdict 2026-05-19 — token provisioned + 401/200 gate verified on prod + staging).

**Audience:** internal — Agent 1 harvester scripts, BS Automate
runners, atlas-priority queue inspectors. NOT customer-facing.

**Auth:** `Authorization: Bearer <DRIFTSTACK_FLEET_INTERNAL_TOKEN>`.
The token is in the operator-trusted fleet's env (sourced from
`/etc/driftstack/api.env` on Hetzner + `~/.driftstack-secrets.env`
on the founder workstation). Constant-time compared via
`timingSafeEqual` to defeat string-length timing attacks. Unset
token → all 4 routes return 503 FeatureUnavailable (activation
gate).

Source of truth:

- Route handlers: `apps/server/src/routes/internal-atlas-priority.ts`
- Auth helper: `apps/server/src/lib/internal-fleet-auth.ts`
- DB schema: migration `0058_atlas_priority_events.sql`,
  `agent_sessions:atlas_priority_events` table

## 4 endpoints

### 1. `POST /v1/internal/atlas-priority/probe-signature`

Insert a new atlas-priority event from a probe-signature emission
(Wave 29-399 §2 atlas-miss codepath emitting `ProbeSig` log lines
that the harvester pipes into this endpoint).

Request body:

```json
{
  "op_seq_sha": "<sha256-hex>",
  "op_seq_bytes_b64": "<base64-encoded raw bytes>",
  "canvas_w": 50,
  "canvas_h": 50,
  "mime": "image/png" | null,
  "archetype_id": "iphone17_ios18_7_safari26_4",
  "last_fill_text": "<optional>" | null,
  "mac_len": <int> | null,
  "session_id": "<uuid>",
  "customer_id": "<uuid>",
  "page_url": "https://example.com/foo",
  "api": "toDataURL" | "toBlob" | "Worker" | undefined
}
```

Response 200:

```json
{
  "event_id": "<uuid>",
  "status": "emitted" | "deduped",
  "deduped": <bool>
}
```

Dedupes on `(op_seq_sha, canvas_w, canvas_h, mime, archetype_id)`
tuple; same-shape probes coalesce into one event.

### 2. `POST /v1/internal/atlas-priority/event-status`

Update the lifecycle status of an existing event. Forward-only
state machine — invalid edges return 400.

Request body:

```json
{
  "event_id": "<uuid>",
  "new_status": "queued" | "running" | "captured" | "failed" | "atlas_indexed" | "atlas_failed",
  "bs_session_id": "<BS Automate session id>" | undefined,
  "error_reason": "<string>" | undefined,
  "atlas_entry_hash": "<sha256-hex>" | undefined,
  "atlas_version": "<v3 | v4>" | undefined
}
```

Response 200:

```json
{ "event_id": "<uuid>", "status": "<new_status>" }
```

Errors:

- 400 — invalid state transition (e.g. `captured → emitted`).
- 404 — event id unknown.

### 3. `GET /v1/internal/atlas-priority/queue`

List recent atlas-priority events filtered by status / customer /
since-timestamp.

Query params:

- `status` (optional): filter by lifecycle status.
- `customer_id` (optional): scope to one customer's events.
- `since` (optional): ISO-8601 timestamp; only events emitted
  after this time.
- `limit` (optional, default 100): max events returned.

Response 200:

```json
{
  "events": [
    {
      "id": "<uuid>",
      "op_seq_sha": "<sha>",
      "canvas_w": 50,
      "canvas_h": 50,
      "mime": "image/png" | null,
      "archetype_id": "iphone17_ios18_7_safari26_4",
      "session_id": "<uuid>",
      "customer_id": "<uuid>",
      "status": "emitted",
      "emitted_at": "<ISO-8601>",
      "queued_at": "<ISO-8601>" | null,
      "running_at": "<ISO-8601>" | null,
      "captured_at": "<ISO-8601>" | null,
      "failed_at": "<ISO-8601>" | null,
      "atlas_indexed_at": "<ISO-8601>" | null,
      "atlas_entry_hash": "<sha>" | null,
      "atlas_version": "v3" | "v4" | null
    }
  ],
  "total_count": 1,
  "stats": {
    "<status>": <count>,
    ...
  }
}
```

### 4. `GET /v1/internal/atlas-priority/event/:id`

Get one event by id with the full lifecycle timeline.

Response 200:

```json
{
  "event": { ...same shape as queue items },
  "timeline": [
    { "status": "emitted", "at": "<ISO-8601>" },
    { "status": "queued", "at": "<ISO-8601>" },
    { "status": "running", "at": "<ISO-8601>" },
    { "status": "captured", "at": "<ISO-8601>" },
    { "status": "atlas_indexed", "at": "<ISO-8601>" }
  ]
}
```

Errors:

- 404 — event id unknown.

## Operational notes

- **Activation:** depends on `DRIFTSTACK_FLEET_INTERNAL_TOKEN`
  being set in `/opt/driftstack/api/.env`. When unset, all 4
  routes 503.
- **No SDK surface:** these are NOT exposed in `@driftstack/sdk*`.
  Agent 1's scripts call them directly via curl + the bearer
  token sourced from the fleet's env.
- **Rate-limit:** none today (defense-in-depth gap surfaced in
  `docs/internal/2026-05-19-rate-limit-coverage-audit.md`).
  Acceptable pre-launch given single-token-per-fleet-host;
  consider adding per-token rate-limit before public scale-out.
- **Audit:** events that mutate state (probe-signature insert,
  event-status update) are NOT logged to the customer audit log
  — they're operator-driven. Internal admin-audit-log entries
  could be added if compliance asks; not pre-launch blocking.
- **Dedup window:** infinite (no time-based reset). The
  `(op_seq_sha, canvas_w, canvas_h, mime, archetype_id)` tuple
  is the canonical event identity.

## Cross-references

- `docs/internal/2026-05-19-rate-limit-coverage-audit.md`
  — flags this surface as needing per-token rate-limit
  defense-in-depth.
- `apps/server/src/routes/internal-atlas-priority.ts:117-214`
  — handler source.
- `apps/server/src/services/atlas-priority-events.ts`
  — `InsertEmittedArgs` + `InvalidStateTransitionError` types.
- `apps/server/src/db/migrations/0058_atlas_priority_events.sql`
  — table + indexes.
- `apps/server/src/db/migrations/0059_atlas_priority_events_api_column.sql`
  — `api` column added in §8.5 follow-up.

## Lifecycle state diagram

```
emitted ──→ queued ──→ running ──→ captured ──→ atlas_indexed
                          │
                          └─→ failed (terminal)
                                                  │
                                                  └─→ atlas_failed (terminal)
```

Each transition records a timestamp column on the event row;
intermediate states keep prior timestamps. The lifecycle
endpoint serializes the timeline in transition order.
