---
layout: ../../layouts/DocLayout.astro
title: Profile snapshots
description: Capture, list, and restore immutable point-in-time copies of saved profiles. Frozen snapshots survive while the source profile keeps evolving.
---

# Profile snapshots

A **profile snapshot** is an immutable
point-in-time copy of a saved profile. Snapshots let you freeze a
known-good profile state — for example, after a successful
account-creation flow or before a risky session — so you can
restore it later if the live profile drifts.

The snapshot model is deliberately separate from the live profile
model:

- **Profiles** evolve: every session you run against a profile
  may mutate cookies, `localStorage`, IndexedDB, etc.
- **Snapshots** are frozen: capture an evolving profile into a
  named snapshot, and the snapshot's contents remain unchanged
  even as the source profile keeps changing.

Restoring a snapshot creates a **new profile row** populated from
the snapshot's frozen state — the source profile is untouched and
the new profile starts evolving from there.

The customer-dashboard surface for snapshots lives at
[/snapshots](https://app.driftstack.dev/snapshots). The endpoints
below are the API equivalents.

## Capture a snapshot of a profile

`POST /v1/profiles/:id/snapshots`

Captures the current state of profile `:id` as a new snapshot.

Request:

```json
{
  "label": "post-login-known-good",
  "description": "optional, max 2048 chars"
}
```

Response (201):

```json
{
  "id": "psnap_<uuid>",
  "parent_profile_id": "prof_<uuid>",
  "label": "post-login-known-good",
  "description": null,
  "parent_archetype": "iphone17_ios18_7_safari26_4",
  "parent_name": "main-account",
  "captured_at": "2026-05-10T18:00:00Z"
}
```

`parent_profile_id`, `parent_archetype`, and `parent_name` are
frozen at capture time — they record the source profile's id,
archetype, and name as they were, even if the profile is later
renamed, re-archetyped, or deleted.

Errors:

- `404 not-found` — the profile id doesn't belong to the calling
  account.

Required scope: `write` or `write:profiles`.

## List snapshots of a profile

`GET /v1/profiles/:id/snapshots`

Returns all snapshots of profile `:id`, newest first.

Response (200):

```json
{
  "data": [
    {
      "id": "psnap_<uuid>",
      "parent_profile_id": "prof_<uuid>",
      "label": "post-login-known-good",
      "description": null,
      "parent_archetype": "iphone17_ios18_7_safari26_4",
      "parent_name": "main-account",
      "captured_at": "2026-05-10T18:00:00Z"
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

Pagination via `?cursor=…&limit=…` follows the standard cursor
shape used elsewhere in the API (`data` / `has_more` / `next_cursor`).

Required scope: `read` or `read:profiles`.

## List all snapshots across the account

`GET /v1/profile-snapshots`

Returns every snapshot the calling account owns, across all
profiles. Useful for the dashboard's "all snapshots" view or for
audit reconciliation.

Response (200):

```json
{
  "data": [
    {
      "id": "psnap_<uuid>",
      "parent_profile_id": "prof_<uuid>",
      "label": "post-login-known-good",
      "description": null,
      "parent_archetype": "iphone17_ios18_7_safari26_4",
      "parent_name": "main-account",
      "captured_at": "2026-05-10T18:00:00Z"
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

Each row carries `parent_name` (the source profile's name frozen
at capture) — handy when listing across profiles so you don't have
to issue a second fetch per row to identify the origin.

Required scope: `read` or `read:profiles`.

## Get a single snapshot

`GET /v1/profile-snapshots/:id`

Returns one snapshot. Includes `parent_profile_id` so callers can
follow up to fetch the underlying profile if it still exists.

Response (200):

```json
{
  "id": "psnap_<uuid>",
  "parent_profile_id": "prof_<uuid>",
  "label": "post-login-known-good",
  "description": null,
  "parent_archetype": "iphone17_ios18_7_safari26_4",
  "parent_name": "main-account",
  "captured_at": "2026-05-10T18:00:00Z"
}
```

Required scope: `read` or `read:profiles`.

## Restore a snapshot into a new profile

`POST /v1/profile-snapshots/:id/restore`

Creates a new profile populated from the snapshot's frozen state.
The source profile is untouched; the new profile starts evolving
from the snapshot point.

Request:

```json
{
  "name": "main-account-rolled-back"
}
```

Response (201):

```json
{
  "id": "prof_<uuid>",
  "name": "main-account-rolled-back",
  "archetype": "iphone17_ios18_7_safari26_4",
  "description": null,
  "created_at": "2026-05-10T18:30:00Z",
  "last_used_at": null
}
```

Errors:

- `404 not-found` — the snapshot id doesn't belong to the calling
  account.
- `409 conflict` — a profile with the requested `name` already
  exists.
- `429 tier-limit` — the new profile would push the account over
  its `PROFILES_PER_TIER` cap. Snapshot restore counts against
  the same cap as profile-create.

Required scope: `write` or `write:profiles`.

## Delete a snapshot

`DELETE /v1/profile-snapshots/:id`

Permanently deletes the snapshot. The source profile is not
affected. Returns 204 on success.

Errors:

- `404 not-found` — the snapshot id doesn't belong to the calling
  account.

Required scope: `write` or `write:profiles`.

## Audit-log emission

Snapshot lifecycle events surface in the customer audit log
([/api/audit-log](/api/audit-log)). Action values:

- `profile_snapshot.captured` — fires on snapshot create. The
  `target_resource_id` is the snapshot id; the `payload` includes
  the snapshot name + the source profile id.
- `profile_snapshot.restored` — fires on restore. The
  `target_resource_id` is the new profile id; the `payload`
  includes the snapshot id and the resulting profile name.
- `profile_snapshot.deleted` — fires on delete.

These events filter cleanly via the query parameters; see
[/api/audit-log](/api/audit-log) for the filter shape.

## Tier-cap interaction

Snapshots themselves are NOT counted against `PROFILES_PER_TIER`.
You can hold many snapshots per profile, and many snapshots per
account, without affecting your profile-cap budget.

Restoring a snapshot DOES count: the new profile created from the
restore is subject to the same `PROFILES_PER_TIER` cap as a
manually-created profile. If your tier is at-cap, the restore
returns `429 tier-limit` and the customer must either delete a
profile first or upgrade tier.

## Storage characteristics

Snapshots are stored separately from live profiles in the
underlying driver-managed storage layer. Each snapshot freezes the
source profile's archetype + name (`parent_archetype` /
`parent_name`) at capture time, so a snapshot stays meaningful even
after the parent profile is renamed, re-archetyped, or deleted.
There is no per-account snapshot quota at v1.

## SDK access

The TypeScript / Python / Go SDKs expose snapshots under the
`profile_snapshots` resource. See the SDK quickstart for your
language for the idiomatic code shape.

## Source of truth

Routes: `apps/server/src/routes/profile-snapshots.ts`. Service

- tier-cap enforcement: `apps/server/src/services/profile-
snapshots.ts`. Schema:
  `packages/api-types/src/profile-snapshots.ts`.
