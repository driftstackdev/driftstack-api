# Durable direct-operation resource — design (A2, 2026-07-30)

Status: **Slice 1 (schema + repository + the three fences) is IMPLEMENTED and
proved against real Postgres. Everything else is design only, and this document
authorizes no activation.** Direct `login` / `search` remain capability-gated
`503` on every shipped driver; no route reads the new table yet, which is why
slice 1 is independently releasable. This document exists because §7 of the A2
handoff requires the durable transport to be _designed separately_ before any
schema, route, SDK or OpenAPI slice is claimed.

Slice 1 lands as `0108_session_operations.sql`, `sessionOperations` in
`schema.ts`, `db/session-operations-repo.ts`, `tests/integration/db-session-
operations-fences.test.ts` (11 cases against real Postgres) and
`tests/unit/db-session-operations-content-parity.test.ts` (7 drift guards). Every
fence was mutation-proved by disabling it — dropping each partial unique index,
removing each CAS predicate, and reversing the admit branch order — and each
reddened exactly the cases it should.

Owner: A2 (control plane, API contracts, SDKs).

Prerequisites, with current state as of 2026-07-31:

- **MET** — A1's monotonic owner-deadline correction landed as `driftstack@16a94d0e5`.
  The producer boundary is now an absolute `ContinuousClock` instant held by
  `IntentMutationAuthority` with **latching** expiry, so a worker that wins the
  actor turn after the boundary cannot publish ordinary success. §5 below
  depends on exactly that property, and it is no longer an assumption.
- **OPEN** — a real direct driver. Every shipped driver still reports non-real
  capability, so the routes truthfully return `503`.
- **OPEN** — durable cleanup (A3's 2026-07-17 20:51 finding), which §4 addresses
  with the cleanup outbox but which also needs `Driver.destroy` to take an
  incarnation argument.

---

## 1. Why synchronous HTTP cannot carry this

Every number below was read from source on 2026-07-30, not assumed:

| Bound                              | Value                         | Anchor                                                                                         |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Login producer wall                | 600,000 ms                    | `HARNESS_LOGIN_PRODUCER_DEADLINE_MS`, `apps/server/src/schemas/harness-control-protocol.ts:84` |
| Search producer wall               | 600,000 ms                    | `HARNESS_SEARCH_PRODUCER_DEADLINE_MS`, same file:81                                            |
| Correlator delivery slack          | 15,000 ms                     | `DISPATCH_TIMEOUT_SLACK_MS`, `apps/server/src/services/harness-dispatch-correlator.ts:52`      |
| Effective correlation deadline     | **615,000 ms**                | correlator:76,79 (`producer + slack`)                                                          |
| nginx ordinary `location /`        | **60 s**                      | `infra/nginx/staging.driftstack.dev.conf:95`, `infra/nginx/fleet.driftstack.dev.conf:76`       |
| nginx streaming location           | 3600 s                        | same files:71 / :63 — a DIFFERENT location block, not the API path                             |
| Public edge (Cloudflare-proxied)   | ~100–120 s documented ceiling | A3 2026-07-17 21:02                                                                            |
| TS SDK default per-request timeout | 30,000 ms                     | `packages/sdk-typescript/src/client.ts:41`                                                     |

A 615-second operation therefore cannot complete through **any** default public
path. The producer is not the problem; the _response_ is. Raising nginx does not
help, because the SDK default and the proxied edge still cut first, and a client
that disconnects mid-flight leaves a credential submission in an
**outcome-unknown** state — the one state we may never resolve by retrying.

The 15,000 ms slack is teardown/delivery only. It is not extra browser time and
must never be presented to a customer as such.

## 2. Shape

`POST /v1/sessions/:id/login` and `/search` stop being long synchronous calls and
become **operation factories**:

```
POST /v1/sessions/:id/login        →  202 Accepted
                                      Location: /v1/operations/op_<uuid>
                                      { "operation_id": "op_…", "status": "queued", … }

GET  /v1/operations/:operation_id  →  200 { status, … , result? , error? }
```

`GET` is the only way to learn the outcome. There is no callback in v1 (webhooks
can come later; they are not a prerequisite and they do not remove the need for
polling).

### State machine

```
queued ──► running ──┬──► succeeded   (terminal, result present)
                     ├──► failed      (terminal, RFC 7807 error present)
                     ├──► cancelled   (terminal, explicit customer cancel)
                     └──► expired     (terminal, producer deadline passed with no terminal)
```

Terminal is terminal: a row never leaves `succeeded|failed|cancelled|expired`, and
exactly one terminal write may ever win (see §4).

## 3. Schema

New table `session_operations`:

| Column                                     | Notes                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                       | uuid pk, surfaced as `op_<uuid>`. **Never recycled** — this is the whole point; mock driver id reuse across restart is one of A3's recorded defects. |
| `account_id`                               | fk accounts, cascade. Ownership is checked on every read.                                                                                            |
| `session_id`                               | fk sessions.                                                                                                                                         |
| `driver_incarnation_id`                    | uuid. Binds the operation to ONE driver lifetime so a settled result can never be applied to a successor session that reused the id.                 |
| `kind`                                     | enum `login` \| `search`.                                                                                                                            |
| `status`                                   | enum per §2.                                                                                                                                         |
| `idempotency_key_hash`                     | sha256 of the `Idempotency-Key` header, nullable.                                                                                                    |
| `request_fingerprint`                      | sha256 over the canonicalised request body. Same key + different fingerprint ⇒ 409, mirroring `crypto_orders`.                                       |
| `result`                                   | jsonb, null until `succeeded`. Validated against the existing strict `SessionLoginResponseSchema` / `SearchResponseSchema` before write.             |
| `error`                                    | jsonb RFC 7807, null until `failed`. Redaction-safe only (§6).                                                                                       |
| `deadline_at`                              | timestamptz = accepted_at + 600 s. Authority for `expired`.                                                                                          |
| `created_at` / `updated_at` / `settled_at` | timestamptz.                                                                                                                                         |
| `result_expires_at`                        | timestamptz = settled_at + retention (§7).                                                                                                           |

Sessions gain `last_settled_operation_id` so a session can prove which operation
last mutated it without scanning.

Second table `session_driver_cleanup_outbox` (A3's requirement, adopted verbatim
in intent): `(driver_session_id, driver_incarnation_id, operation_id)` unique,
`attempts`, `leased_until`, `last_error` (bounded + redacted). Infinite leased
retry — **not** the generic three-attempt scheduled job, which A3 correctly
called insufficient because a permanently-failed job silently abandons a live
browser.

## 4. Concurrency and exactly-once

Three fences, all at the database, none in process memory:

1. **Admission.** `INSERT … ON CONFLICT (session_id) WHERE status IN ('queued','running') DO NOTHING`.
   Zero rows inserted ⇒ a live operation already owns the session ⇒ `409`. This
   is the same shape as the existing `ready → busy` claim, so one session can
   never have two live direct operations.
2. **Idempotency.** Unique `(account_id, idempotency_key_hash)` where the key is
   present. Replay with an identical `request_fingerprint` returns the SAME
   operation (`200`, not a second `202`). Different fingerprint ⇒ `409`. This is
   what makes a client-side retry after a disconnect safe.
3. **Terminal CAS.** Every terminal write is
   `UPDATE … SET status = $terminal … WHERE id = $id AND status IN ('queued','running') AND driver_incarnation_id = $incarnation`.
   Zero rows updated ⇒ another writer already settled it, or the incarnation
   changed ⇒ discard the result and quarantine, never overwrite.

   **Corrected during slice 1.** This originally read `status = 'running'`,
   which cannot express `expired` for an operation that never started: a row
   still `queued` past its deadline would have been unsettleable forever. What
   guarantees exactly-once is excluding the TERMINAL statuses, not naming one
   live status, so admitting either live status is equally safe and strictly
   more complete.

The failure path commits the terminal row **and** the cleanup-outbox insert in
ONE transaction. That is the specific gap A3 identified: today a failure can
commit `errored` and the process can die before the unbounded driver destroy.

`Driver.destroy(sessionId)` (`apps/server/src/drivers/types.ts:252`) is
insufficient for this — it takes only a session id, so it cannot express "destroy
incarnation N and no other". It needs an incarnation argument and idempotent
already-absent success before the outbox can be trusted.

## 5. Timing model

- `deadline_at` is set at admission from the SAME 600,000 ms producer constant.
  The API must not invent its own number.
- A worker that returns at or after `deadline_at` cannot publish ordinary
  success. This is no longer an assumption: `driftstack@16a94d0e5` makes the
  authority's expiry latch, so once observed past the boundary it can never
  report authorized again. The operation row must not paper over it — a row
  that settles `succeeded` after `deadline_at` is a bug in this layer, not a
  tolerable race.
- The 615,000 ms correlation deadline stays where it is, internal to dispatch.
  It never appears in a customer-facing field.
- `GET /v1/operations/:id` is a fast read: no driver call, no correlator wait.
  Poll guidance is returned as `Retry-After` on non-terminal reads.

## 6. Secrets and redaction

- The login `password` is never persisted. Not in `session_operations`, not in
  `request_fingerprint` inputs beyond its hash contribution, not in `error`.
- `error` is produced by the existing centralised problem redaction
  (`c86c7b793` / `8dad6e4f6` lineage, `apps/server/src/lib/logger.ts`
  `redactProblemSerializer`) and carries a FIXED detail for driver-contract
  violations — no reflected query or credential values, matching what the
  synchronous path already does.
- `search.query` is bounded at 10,000 before admission, so an oversize input
  fails before an operation row exists.

## 7. Retention

Results are private and short-lived. `result_expires_at = settled_at + 24 h`;
after that the row keeps `status` and drops `result`/`error` payloads. Reads are
`no-store, private` with `Vary: Origin`, consistent with the private-stream
posture already shipped. A retention sweeper follows the existing pattern
(`apps/server/src/services/*-sweeper.ts`).

## 8. Public surface

- `202` body: `{ operation_id, status, session_id, kind, created_at, poll_after_ms }`.
- `GET` non-terminal: same envelope + `Retry-After`.
- `GET` terminal success: envelope + `result` — **the existing strict union,
  byte-identical to what the synchronous path returns today**. The whole point of
  the §4 safety lane is that this shape is already correct; the transport changes,
  the contract does not.
- `GET` terminal failure: envelope + RFC 7807 `error`.
- `404` for an operation the caller does not own — never `403`, which would
  confirm existence.
- SDKs gain `sessions.login(...)` returning an operation handle plus a
  `waitForOperation(op, { timeoutMs })` helper that polls with backoff. The
  default per-request timeout stops mattering, because no single request is long.

## 9. What this deliberately does NOT do

- It does not activate direct login/search. Capability gating and the truthful
  `503` stay until a real driver exists.
- It does not raise nginx, the edge ceiling, or any SDK default.
- It does not add a webhook/callback in v1.
- It does not retry an outcome-unknown credential submission. Ever. An operation
  whose driver outcome cannot be established settles `failed` with an explicit
  outcome-unknown problem type, and the customer decides.

## 10. Acceptance before any slice is called done

1. Two concurrent `POST`s on one session ⇒ exactly one `202`, one `409`, one row.
2. Same `Idempotency-Key` + same body ⇒ same `operation_id`, no second row, no
   second driver dispatch. Same key + different body ⇒ `409`.
3. Client disconnects immediately after `202` ⇒ operation still settles; a later
   `GET` returns the real terminal.
4. Worker returns after `deadline_at` ⇒ `expired`, zero ordinary success, exact
   teardown, and no successor session mutated.
5. Kill the process between the failure CAS and the driver destroy ⇒ on restart
   the outbox still drives the destroy to confirmed exit or already-absent.
6. Same-session ABA: incarnation N's late result cannot settle incarnation N+1.
7. Cross-account `GET` ⇒ `404`, and no row field leaks into the body.
8. No password or raw query appears in any row, log line, or problem detail —
   asserted with a synthetic credential and a marker scan.
9. Result TTL elapses ⇒ payload gone, status retained.
10. TS/Python/Go all round-trip the operation envelope and reject a contradictory
    or out-of-budget terminal, exactly as they now do for the synchronous union.

## 11. Suggested slicing

Each slice is independently releasable and independently reviewable:

1. ~~Schema + repository + the three fences (no route).~~ **DONE.**

   One finding worth carrying forward, because it would have shipped an
   unproven fence. The obvious idempotency test — admit with a key, admit
   again with the same key, expect a replay — **passes even with the
   idempotency index dropped**, because the first operation is still live on
   that session and fence 1 blocks the second insert on its own. The fences
   overlap, so the natural test for the second one is satisfied by the first.
   Proving fence 2 requires a case where fence 1 cannot help: retry the same
   key AFTER the first operation settles, when the session is free again.
   That is also the realistic scenario — a customer retrying a request whose
   response they never received. Only that case reds when the index is
   dropped, and it is now the test that carries the fence.

2. Route: `202` factory + `GET`, behind the existing capability gate so behaviour
   is unchanged while a real driver is absent.
3. Cleanup outbox + leased worker + `Driver.destroy` incarnation argument.
4. OpenAPI + docs. **Coordinate — `apps/server/src/lib/openapi.ts` is on loan to
   A3 for the organization contract as of 2026-07-30 15:31.**
5. SDK resources + `waitForOperation` across all three languages.
6. Retention sweeper.

Slice 1 is the only one with no external dependency and is the correct starting
point whenever this is picked up.
