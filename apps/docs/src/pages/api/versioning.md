---
layout: ../../layouts/DocLayout.astro
title: API versioning policy
description: Driftstack API versioning policy — additive vs breaking changes, deprecation cycle, when /v2/* is justified.
---

# API versioning strategy

Versioning policy for the HTTP API surface (`/v1/*` and any later
major prefix). Distinct from the SDK versioning policy at
[`docs.driftstack.dev/sdk/versioning`](/sdk/versioning/): SDKs version
independently of the API; this doc covers the API endpoint contract.

## TL;DR

- One major version active at a time. `/v1/*` today.
- Additive changes are free — new endpoints, new optional request
  fields, new response fields, new enum values. Customers don't
  break.
- Breaking changes go through a deprecation cycle, then a new
  major version. `/v2/*` only when justified; not on a calendar.
- The OpenAPI spec at `/openapi.json` is the contract. Generated
  from Zod schemas in `packages/api-types/`; there is no second
  source of truth.

## What counts as additive vs breaking

| Change                                                    | Class                                  |
| --------------------------------------------------------- | -------------------------------------- |
| New endpoint                                              | Additive                               |
| New optional request field with sensible default          | Additive                               |
| New response field                                        | Additive                               |
| New enum value (sent BY server, e.g. webhook event types) | **Breaking for closed-enum consumers** |
| New enum value (accepted FROM client, e.g. tier IDs)      | Additive (server is permissive)        |
| Renaming an existing field                                | Breaking                               |
| Removing an existing field                                | Breaking                               |
| Changing a field's type (e.g. number → string)            | Breaking                               |
| Tightening a validation constraint                        | Breaking                               |
| Loosening a validation constraint                         | Additive                               |
| Changing default behaviour of an existing endpoint        | Breaking                               |
| Changing HTTP status code returned                        | Breaking                               |
| Changing error type URI in problem-detail                 | Breaking                               |
| Adding a new error type URI                               | Additive                               |
| Changing rate-limit caps                                  | Operational; not contract              |

The "new enum value" row deserves emphasis: when the **server**
sends a closed enum value the **client** doesn't know about (e.g.
a new `webhook_event_type`), strictly-typed clients break. SDKs
mitigate this with a passthrough escape hatch, but the contract
itself is breaking — bump major version, OR ship the new value
behind a feature flag, OR add a transitional period where both
old and new values are emitted.

## Unrecognised request fields

Request bodies are parsed permissively: a top-level field the
endpoint does not declare is **ignored**, and the request succeeds
exactly as if it had not been sent. That keeps adding a field
additive rather than breaking, but on its own it means a typo is
presented to you as success — a mistyped `archetype` on profile
creation would return `201 Created` with the default substituted.

So the ignored keys are named back to you. When an authenticated
write carries fields the endpoint doesn't declare, the response
includes:

```
x-driftstack-unknown-fields: timezonee
```

For example, `PATCH /v1/account/me` with body
`{"name": "Updated", "timezonee": "Europe/Amsterdam"}` returns
`200 OK`, applies the `name` change, and sets the header to
`timezonee` — the timezone update was silently dropped.

Specifics worth knowing:

- **Comma-separated key names**, in the order the body listed them.
- **Top-level keys only.** Nested unknown keys are not reported;
  polymorphic and forward-compat payloads make nested reporting
  too noisy to be useful.
- **At most 10 keys**, each truncated to 64 characters, so a large
  body cannot inflate the response.
- **The header is absent** when every field was recognised — treat
  presence, not value, as the signal.
- **Reporting, never rejecting.** The status code and response
  body are identical with and without unknown fields, so nothing
  breaks by starting to send this header, and nothing breaks if
  you ignore it.
- **Not emitted on unauthenticated auth endpoints.** Echoing the
  keys an anonymous caller sent back to them discloses schema
  shape on the surface most likely to be probed.

Because it is purely additive, this header is not part of the
breaking-change contract above: treat it as a diagnostic, and do
not parse it as a stable machine interface.

## Deprecation cycle for breaking changes

When a breaking change is necessary, the sequence is:

1. **Announce the deprecation** in a `Deprecation` HTTP response
   header on every affected endpoint, with a `Sunset` header
   pointing at the declared removal date (RFC 8594).
2. **Document the migration path** in the OpenAPI spec via
   `deprecated: true` on the affected operation / field, plus a
   `description` pointing at the replacement.
3. **Email customers** using the deprecated surface. Use the audit
   log + last-30-day usage data to identify them; send a
   transactional notice (one-shot, not a recurring nag).
4. **Minimum 90 days** between announcement and removal. Longer
   for high-impact changes (e.g. session lifecycle shape).
5. **Remove the surface** in the next major version OR — if the
   change is small enough to fit within the existing major — ship
   it as a separate operation while leaving the old one in place
   for a defined sunset window.

## When a new major version is justified

`/v2/*` ships when:

- A breaking change can't be avoided (e.g. session lifecycle
  redesign that needs different state-machine semantics).
- Multiple breaking changes batch sensibly (don't spread breakage
  across many minor announcements when one batched cut is cleaner).
- An entirely new architectural shape requires a distinct contract
  (for example, REST semantics changing to RPC).

It does NOT ship when:

- Pre-1.0-style restlessness wants to "clean things up." We
  instead deprecate + phase out within `/v1/*`.
- A single field rename is desired. Announce, deprecate, support
  both for a sunset window, drop the old name.

## Operating multiple majors simultaneously

When more than one major is active:

- `/v1/*` continues to work for the announced sunset window
  (typically 12+ months).
- Both versions share the same auth + rate-limit infrastructure.
- Server-side handlers are duplicated where shape diverges; shared
  service layer where the underlying behaviour is identical.
- Test fixtures cover both; the OpenAPI spec exposes both.
- Customers can pin a version via the URL prefix; no header-based
  versioning today.

## Per-resource versioning notes

- **`/v1/sessions/*`** — session-lifecycle shape changes require a
  new major version. Customers already opt into
  schema evolution via `purpose` + `archetype` fields;
  shape changes within the lifecycle (e.g. new states, new
  required fields) are breaking and trigger the deprecation cycle.
- **`/v1/api-keys/*`** — scope enum is the breaking-change risk.
  Scope changes use the deprecation cycle if the meaning of `account_owner`
  narrows or splits further.
- **`/v1/webhooks/*`** — `WebhookEventType` enum is closed. Adding
  a new event type IS technically breaking for strictly-typed
  consumers. We mitigate via the SDK passthrough pattern +
  documented "we may send unknown event types; ignore + continue"
  (the catalog of all event types lives at
  `docs.driftstack.dev/webhooks/events`). Customers are
  encouraged to subscribe with explicit `events: [...]` arrays so the
  server only ever sends event types the customer already opted into.
  New event types are then additive at the wire level; subscription is
  opt-in.
- **`/v1/billing/*`** — Stripe-driven; subscription state shapes
  are stable across `/v1/*`'s lifetime. Mid-major changes here are
  extremely unlikely.
- **`/v1/admin/*`** — internal-staff surface. Breaking changes
  don't trigger external deprecation cycle; staff updates the
  panel + the docs in lock-step.
- **`/v1/account/*`** — customer self-serve account data
  (audit-log, email-preferences, rate-limits). Same external-facing
  breaking-change discipline as `/v1/sessions/*`.

## What customers should do

- Pin to a specific major in their integration. SDKs handle this
  by encoding the major in the URL constants they ship.
- Subscribe explicitly to webhook events they handle; ignore +
  continue on unknown event types (defensive parsing).
- Watch the `Deprecation` + `Sunset` response headers in
  production logs. Generic SDK middleware can surface these
  automatically.
- Log `x-driftstack-unknown-fields` in non-production. Its
  presence means a field you sent was ignored — usually a typo,
  occasionally a field removed on our side.
- Read the CHANGELOG for the SDK they use; SDK CHANGELOGs
  cross-reference API-side deprecations relevant to that
  language's surface.

## What we don't do

- **Header-based versioning** (`API-Version: 2024-05-01`) —
  considered but rejected. URL-prefix is more discoverable, easier
  to debug in logs, and matches industry convention (Stripe-style
  `/v1/`).
- **Date-based versioning per-account** (Stripe's "API version
  pinning") — not offered. Driftstack uses explicit URL prefixes.
- **Continuous breaking changes** — pre-1.0 SDKs ship them
  under their published SemVer policy. Customers pinned to the
  HTTP `/v1/*` contract receive additive-only changes.

## Related

- Webhook event catalog: [`docs.driftstack.dev/webhooks/events`](/webhooks/events/).
- Rate-limit policy: [`docs.driftstack.dev/reference/rate-limits`](/reference/rate-limits/).
- Error handling: [`docs.driftstack.dev/sdk/error-handling`](/sdk/error-handling/).
- OpenAPI spec is served at `/openapi.json` on the live API host
  (`api.driftstack.dev/openapi.json`) and rendered as a browsable
  reference by Scalar UI at `api.driftstack.dev/docs`.
