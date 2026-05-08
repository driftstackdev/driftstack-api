---
layout: ../../layouts/DocLayout.astro
title: Profiles
description: Manage saved browser profiles — create, list, get, patch, clone, delete. Tier-cap enforced at create + clone.
---

# Profiles

A **profile** is a named, persistent browser identity Driftstack
remembers between sessions. Cookies, `localStorage`, `IndexedDB`,
service workers, and any state the underlying WebKit engine
retains are kept under one logical handle so you can resume where
you left off.

The profile model is intentionally light at the metadata layer —
profile rows hold a name, archetype, optional description, and
last-used timestamp. The underlying browser state is managed by
the driver layer (V-073 + V-105) and isn't directly exposed
through this API.

## Tier caps

Each tier limits the maximum number of profiles per account.
Crossing the cap on `POST /v1/profiles` (or
`POST /v1/profiles/:id/clone`) returns `429 Tier limit`:

| Tier          | Profiles cap |
| ------------- | -----------: |
| Trial pack    |            1 |
| Solo manual   |            5 |
| Team manual   |           50 |
| Agency manual |          200 |
| API starter   |           10 |
| API builder   |           25 |
| API scale     |          100 |
| Enterprise    |       custom |

The cap on enterprise tier is negotiated; the API returns
`profile_cap: null` on `/v1/account/me` for enterprise customers.

## Resource shape

```json
{
  "id": "prof_<uuid>",
  "name": "production",
  "archetype": "iphone16pro_ios18_7_safari26_4",
  "description": "primary prod-data scrape profile",
  "last_used_at": "2026-05-09T22:00:00.000Z",
  "created_at": "2026-04-15T11:30:00.000Z",
  "updated_at": "2026-05-09T22:00:00.000Z"
}
```

- `name` — unique within the account. Lowercase + hyphen recommended;
  max 64 chars; cannot contain whitespace or control characters.
- `archetype` — the pinned device + OS + Safari version triple. New
  profiles default to `iphone16pro_ios18_7_safari26_4`. You can
  pin to an older archetype for behavioural-stability reasons (e.g.
  hold a profile on iOS 17 while you migrate). Once set, the
  archetype is sticky for that profile's lifetime.
- `description` — free-form, max 2048 chars; nullable.
- `last_used_at` — touched by SessionsService when a session is
  created against this profile. `null` until first use.

## Create

`POST /v1/profiles`

```json
{
  "name": "production",
  "archetype": "iphone16pro_ios18_7_safari26_4",
  "description": "primary prod-data scrape profile"
}
```

`archetype` and `description` are optional. Returns the created
profile (200, not 201 — the API surface uses 200 for both
idempotent and one-shot resource creation).

Errors:

- `400 ValidationFailed` — invalid name shape, missing required
  field, or `description` over 2048 chars.
- `409 Conflict` — `name` already exists in this account.
- `429 TierLimit` — account at the profile cap. Body extension:
  `{limit, current, resource: "profile", tier}`.

## List

`GET /v1/profiles?limit=50&cursor=<...>`

```json
{
  "data": [<profile>, ...],
  "has_more": false,
  "next_cursor": null
}
```

`limit` 1-100 (default 50). Cursor is the prior page's last id;
ordering is `created_at desc`, `id desc` for stable tie-break.

## Get one

`GET /v1/profiles/:id`

Returns 404 if the profile doesn't exist or belongs to a different
account (we don't leak existence cross-account).

## Patch (rename + edit description)

`PATCH /v1/profiles/:id`

```json
{
  "name": "production-eu",
  "description": "EU-region primary"
}
```

Both fields optional; pass `description: null` to clear. The
archetype is intentionally not editable — repin via
`POST /v1/profiles/:id/clone` with a new archetype, then delete the
old profile after migration.

## Clone (V-313)

`POST /v1/profiles/:id/clone`

```json
{ "name": "production-staging" }
```

Body fully optional. When `name` is omitted the server auto-derives
a non-conflicting `${source} (copy)` / `(copy 2)` / `(copy 3)` ...
naming (caps at 99 to avoid runaway loops; rejects with 409 if it
gets there).

The clone inherits source's `archetype` + `description`. Underlying
browser state is NOT cloned — the new profile starts with a fresh
state slot under the same archetype. Use clone primarily for:

- Forking metadata before pinning the source to a different
  archetype.
- Splitting a busy production profile into per-environment copies
  before they diverge.
- Pre-creating staging profiles ahead of a load test.

Returns the cloned profile (same shape as create). The `audit_log`
entry for `profile.created` carries `payload.cloned_from:
profile_<source-id>` so the audit shows provenance.

Errors mirror create: 429 if the cap would be exceeded by the
clone, 409 on explicit-name collision, 404 if the source isn't
found / not owned by the caller.

## Snapshots (V-312)

Snapshots are immutable point-in-time copies of a profile. The
parent profile keeps evolving — its archetype, name, description,
and underlying browser state mutate as you use it. The snapshot is
frozen the moment you capture it.

**Capture**

`POST /v1/profiles/:id/snapshots`

```json
{ "label": "before-iOS-26-rollout", "description": "optional, max 2048 chars" }
```

The response carries the snapshot's `id` (prefix `psnap_`),
`parent_profile_id`, `parent_archetype`, `parent_name` (frozen at
capture time), and `captured_at`.

**List**

`GET /v1/profiles/:id/snapshots` — newest-first, paginated.
`GET /v1/profile-snapshots` — every snapshot owned by the calling
account, across all profiles. Same pagination shape.

**Get one**

`GET /v1/profile-snapshots/:id`

**Restore**

`POST /v1/profile-snapshots/:id/restore`

```json
{ "name": "restored-from-baseline" }
```

Creates a NEW profile carrying the snapshot's `parent_archetype` +
`description`. The original parent profile is NOT modified — even
if it has been renamed, edited, or deleted in the meantime. The
new profile counts against your tier cap (429 if it would exceed)
and 409s on name collision. The `audit_log` entry for
`profile.created` carries `payload.restored_from_snapshot:
psnap_<id>`.

**Delete**

`DELETE /v1/profile-snapshots/:id` → `204 No Content`.

Snapshots have no automatic lifecycle. Capture as many as you want;
they sit until you delete them. Deleting the parent profile sets
the snapshot's `parent_profile_id` to `null` but does NOT delete
the snapshot — the captured `parent_archetype` + `parent_name` +
state remain restorable.

## Delete

`DELETE /v1/profiles/:id`

Hard-deletes the profile metadata + cascades the underlying state.
`session.created` events bound to the deleted profile fail loudly
on next use (no orphan-state retention).

Returns `204 No Content`. Idempotent on already-deleted profiles
(404 — the row is gone, not soft-deleted).

## Auth + scoping

Read endpoints (GET) accept any valid bearer with `read` scope;
write endpoints (POST, PATCH, DELETE) require admin scope on the
calling key. Team RBAC: `X-Driftstack-Account` is honored for
both reads and writes per V-326e — member roles cannot write on
the owner's account; admin members can.

## Lifecycle interaction

A session is bound to a profile at creation time
(`POST /v1/sessions { profile_id }`). The session carries the
profile's state forward; on destroy, any state mutations are
persisted back to the profile row's underlying storage. Concurrent
sessions on the SAME profile are serialised at the driver layer
to avoid state-merge conflicts.

See [Session lifecycle](/guides/session-lifecycle/) for the full
flow.
