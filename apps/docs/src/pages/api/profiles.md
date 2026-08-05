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
the driver layer and isn't directly exposed
through this API.

## Tier caps

Each tier limits the maximum number of profiles per account.
Crossing the cap on `POST /v1/profiles` (or
`POST /v1/profiles/:id/clone`) returns `429 Tier limit`. Values
mirror `PROFILES_PER_TIER` in `@driftstack/api-types`:

| Tier            | Profiles cap |
| --------------- | -----------: |
| `free`          |            1 |
| `solo_manual`   |           10 |
| `team_manual`   |           50 |
| `agency_manual` |          200 |
| `api_starter`   |           25 |
| `api_builder`   |          100 |
| `api_scale`     |          500 |
| `enterprise`    |       custom |

The cap on enterprise tier is negotiated; the API returns
`profile_cap: null` on `/v1/account/me` for enterprise customers.

## Account folder and tag taxonomy

The GUI's empty folders (including optional icons) and reusable tags
are stored as one account-level taxonomy at
`GET /v1/account/me/organization` and
`PUT /v1/account/me/organization`. The read requires
`read:profiles`; the replacement write requires `write:profiles`.
Broad `read` / `write` and `account_owner` credentials satisfy the
corresponding granular gate.

These nested organization routes honor `X-Driftstack-Account`.
When a team workspace is selected, both `member` and `admin` can
read the owner's taxonomy, but only `admin` can replace it. The
server resolves that effective owner before body validation and
stores the taxonomy under the same owner as the profile collection.
With no header, the calling account remains the owner.

## Resource shape

```json
{
  "id": "prof_<uuid>",
  "name": "production",
  "archetype": "iphone17_ios18_7_safari26_4",
  "description": "primary prod-data scrape profile",
  "folder": "checkout-flows",
  "tags": ["prod", "us-east"],
  "icon": "🛒",
  "note": "rotate cookies weekly",
  "last_used_at": "2026-05-09T22:00:00.000Z",
  "created_at": "2026-04-15T11:30:00.000Z",
  "updated_at": "2026-05-09T22:00:00.000Z"
}
```

- `name` — unique within the account. Lowercase + hyphen recommended;
  max 120 chars. Must start and end with an alphanumeric character;
  allowed inner characters are letters, digits, spaces, underscore,
  hyphen, and dot. Leading/trailing whitespace is trimmed.
- `archetype` — the pinned device + OS + Safari version triple. New
  profiles default to `iphone17_ios18_7_safari26_4`. When supplied,
  the id must be present in the current
  [`GET /v1/archetypes`](/api/archetypes/) response; this includes any
  older combination the platform still marks `available`. Once set,
  the archetype is sticky for that profile's lifetime.
- `description` — free-form, max 2048 chars; nullable.
- `folder` — optional organising folder name; `null` when the profile
  isn't filed under a folder.
- `tags` — array of free-form organising tags; `[]` when none are set.
- `icon` — optional short emoji shown in the dashboard / GUI; `null`
  falls back to a monogram. Synced server-side so it follows the
  account across machines.
- `note` — optional short inline note; `null` when unset. Synced
  server-side alongside `icon`.
- `last_used_at` — touched by SessionsService when a session is
  created against this profile. `null` until first use.

## Create

`POST /v1/profiles`

```json
{
  "name": "production",
  "archetype": "iphone17_ios18_7_safari26_4",
  "description": "primary prod-data scrape profile"
}
```

`archetype` and `description` are optional. Returns the created
profile (200, not 201 — the API surface uses 200 for both
idempotent and one-shot resource creation).

Use `GET /v1/archetypes` to generate the request from the live selectable
catalog. Any id absent from the current response is rejected before the profile
repository is read or written. Omitting the field selects the catalog's
`default_archetype_id`.

Errors:

- `400 ValidationFailed` — invalid name shape, missing required
  field, `description` over 2048 chars, or an `archetype` absent from the live
  selectable catalog.
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

## Launch

`POST /v1/profiles/:id/launch`

```json
{ "label": "checkout-run-2026-05-20" }
```

`label` is an optional override with the same 120-character maximum as direct
session creation. The body is strict: any other key, including raw `proxy`, is
rejected before profile lookup or session creation. Everything else flows from
the profile (archetype + metadata inherited, `last_used_at` bumped
server-side fire-and-forget). One-shot wrapper around `POST
/v1/sessions` — equivalent to:

```json
{
  "profile_id": "prof_<uuid>",
  "archetype": "<profile.archetype>",
  "metadata": { "profile_id": "...", "profile_name": "..." }
}
```

but in a single round-trip, and the server stamps the linkage on
the session's metadata so the audit + usage trail tie back to the
profile.

Returns the freshly-minted session (same shape as `POST
/v1/sessions`). The customer then drives the session via the
normal `navigate` / `interact` / `wait` / `capture` /
`destroy` verbs (or via the desktop GUI's Live session view, which
mounts on the returned `session.id`).

This endpoint and `POST /v1/sessions` intentionally have no per-session
egress field. For customer-controlled egress, use
`POST /v1/agent-sessions` with a `proxy_id` referencing one of your saved
`/v1/account/me/proxies` configurations. Agent sessions apply that saved proxy
to the assigned browser runtime.

Errors:

- `404` if the profile isn't owned by the calling account
  (deliberate anti-enumeration — cross-account `profile_id` is
  indistinguishable from a missing one).
- `409 profile-in-use` if the profile already has a live session —
  a profile can run only one session at a time (the body's
  `active_session_id` names the live one). End it first, then launch.
- `400` for an unknown body key, a label longer than 120 characters, or an
  explicit raw `proxy` field. Raw proxy data is never applied.
- `400` for every body when deployment policy requires customer egress
  (`SESSION_PROXY_REQUIRED=true`, or inferred backend presence), because this
  direct surface has no typed consumed egress authority. Use a saved `proxy_id`
  with `POST /v1/agent-sessions` instead.
- Any other error the underlying `POST /v1/sessions` can return, most commonly
  `429` when the concurrent-session cap is reached.

## Clone

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

## Transfer

`POST /v1/profiles/:id/transfer`

```json
{ "recipient_account_id": "acc_3f2b1c9d-0e4a-4b6c-8d1e-2f3a4b5c6d7e" }
```

Moves a profile to another Driftstack account. The recipient finds
their `acc_<uuid>` account id on their **Settings** page and shares
it with you out-of-band (chat / email); you paste it here. The
lookup is by account id, not email — there is no address-enumeration
path.

The transfer creates a fresh profile under the recipient (inheriting
the source's `archetype` + `description`) and deletes the source from
your account in the same operation. Underlying browser state is not
carried across — the recipient's profile starts with a fresh state
slot under the same archetype. If the recipient already has a profile
with the same name, the new one is suffixed `${name} (transferred)`.

Returns:

```json
{
  "new_profile": { "id": "prof_…", "name": "…", "archetype": "…", "...": "…" },
  "recipient_account_id": "acc_…"
}
```

Errors:

- `400` — `recipient_account_id` is malformed (must be `acc_<uuid>`).
- `400` — recipient is your own account (transfer to yourself is a no-op).
- `404` — no account exists for that id, or the source profile isn't
  found / not owned by you.
- `429` — the recipient is at their tier's profile cap, or has hit the
  per-billing-cycle inbound-transfer cap (twice their profile cap).

## Export / Import

Export a profile as a versioned, metadata-only JSON envelope, then
import it (in the same account or another) to mint a fresh profile
from it. This is a file-based alternative to [Transfer](#transfer):
the source profile is left intact, and you move the JSON yourself
(commit it, attach it, hand it to a teammate). Only the metadata
travels — `name`, `archetype`, `description`. Underlying browser
state is not in the envelope.

Import is a new-profile write, so `envelope.profile.archetype` must be present
in the current selectable catalog. An export of an older retained profile still
succeeds, but importing that envelope returns `400 ValidationFailed` if its
pinned id is no longer selectable.

## Export

`GET /v1/profiles/:id/export`

```json
{
  "version": 1,
  "exported_at": "2026-05-20T12:00:00.000Z",
  "source_profile_id": "prof_<uuid>",
  "source_account_id": "<account-uuid>",
  "profile": {
    "name": "production",
    "archetype": "iphone17_ios18_7_safari26_4",
    "description": "primary prod-data scrape profile"
  }
}
```

`source_profile_id` and `source_account_id` are informational only —
they record where the file came from. Importing always mints a fresh
id, into whatever account holds the calling key. Consumers must honor
the envelope version and reject versions they do not understand.

## Import

`POST /v1/profiles/import`

```json
{
  "envelope": { "version": 1, "...": "..." },
  "name_override": "production-copy"
}
```

`envelope` is a v1 export envelope (paste the file). `name_override`
is optional — rename on import without editing the file; when
omitted, `envelope.profile.name` is used. Returns the created
profile (same shape as create). Tier-cap + name-conflict semantics
match [Create](#create): `429` if the import would exceed your
profile cap, `409` if the name already exists. Importing an envelope
from a different account is permitted (file-based transfer between
teammates).

Errors:

- `400 ValidationFailed` — the envelope is malformed, is not a v1 shape, or
  carries an archetype absent from the live selectable catalog.
- `409 Conflict` — `name` (or `name_override`) already exists.
- `429 TierLimit` — importing would exceed your tier's profile cap.

**SDK usage:**

```ts
const envelope = await client.profiles.export('prof_<uuid>');
const restored = await client.profiles.import({ envelope });
```

Export is a read — any valid bearer with `read` scope. Import
requires the `write:profiles` scope on the calling key (a broad
`write` key also satisfies it). Team RBAC: `X-Driftstack-Account`
is honored — admin members can import on the owner's account.

## Snapshots

Snapshots are immutable point-in-time metadata records of a
profile. The parent profile keeps evolving — its archetype, name,
description, and underlying browser state mutate as you use it.
The snapshot's recorded metadata (archetype, name, description) is
frozen the moment you capture it. Browser state (cookies, logins)
is NOT captured at v1 — see
[/api/profile-snapshots](/api/profile-snapshots/) for the full
contract.

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
description remain restorable.

## Stored-archetype compatibility

Catalog restrictions apply to new direct session/profile creates and profile
imports. Existing profiles preserve their stored archetype even after it leaves
the selectable catalog. They remain listable, readable, clonable, transferable,
snapshot-restorable, and launchable; these compatibility operations do not
silently rewrite the pinned browser identity.

## Delete (recycle bin)

`DELETE /v1/profiles/:id`

**Soft-deletes** the profile — it moves to the **recycle bin** rather than
being destroyed. A trashed profile is hidden from `GET /v1/profiles` and can't
be launched or looked up by id, but it's **recoverable** (see Restore below).
Deleting also **frees the name** immediately, so you can create a new profile
with the same name right away.

A trashed profile **still counts against your tier's profile cap** until it's
purged — soft-delete preserves the underlying encrypted state, so it occupies a
slot. Free the slot immediately with Purge (below), or wait for the 30-day
auto-purge.

Returns `204 No Content`, and is idempotent — re-deleting an already-trashed
profile (or an id that was never yours) also returns `204`.

Trashed profiles are **retained for 30 days**, then permanently purged (the
underlying state is hard-deleted at that point and is no longer recoverable).

## List trash

`GET /v1/profiles/trash` → `{ "data": [ ...profile ] }`

Lists your trashed profiles, newest-deleted first. Each row has the same shape
as a live profile plus a non-null `deleted_at` timestamp. Read scope suffices
(both team roles).

## Restore

`POST /v1/profiles/:id/restore` → the restored profile

Un-trashes a soft-deleted profile (write scope; admin-only on a team workspace,
same as delete). Returns:

- `404` if the id isn't one of your trashed profiles.
- `409 Conflict` if a **live** profile has since taken the trashed profile's
  name — rename the live one (or the restored profile) first, then retry.

## Purge (permanent delete)

`DELETE /v1/profiles/:id/purge` → `204 No Content`

Permanently deletes a **trashed** profile and **frees its cap slot
immediately** — use it to reclaim a slot without waiting for the 30-day
auto-purge. The underlying encrypted state is hard-deleted; this is
**irreversible** (no restore afterward). Write scope (admin-only on a team
workspace, same as delete). Returns `404` if the id isn't one of your trashed
profiles — purge only acts on the recycle bin, never on a live profile (delete
it first).

Read endpoints (GET) accept any valid bearer with `read` scope;
write endpoints (POST, PATCH, DELETE) require the `write:profiles`
scope on the calling key (a broad `write` key also satisfies it).

One exception, documented here because the endpoint is: **`POST
/v1/profiles/{id}/launch` requires `write:sessions`, not
`write:profiles`** — it creates a session, so it is gated as a session
write. A key scoped to `write:profiles` alone can manage profiles but
cannot launch one.
Team RBAC: `X-Driftstack-Account` is honored for both reads and
writes — member roles cannot write on the owner's account; admin
members can.

## Trim cached site data

`POST /v1/profiles/:id/trim`

Reclaims storage by clearing a profile's **re-fetchable caches**
(HTTP/media cache and per-origin CacheStorage / service-worker
registrations) while **keeping the identity state** — cookies,
`localStorage`, `IndexedDB`, and open tabs. Use it when an account
is near its storage cap and you want space back without losing the
profile's logins. No request body; write scope (`write:profiles`),
admin-only on a team workspace, same as the other mutating routes.

The trim runs out-of-session on the fleet against the profile's
last-saved encrypted state, so the response is a **discriminated
`200` body** in every case:

```json
// "ok" — trimmed; the smaller size is persisted immediately
{ "status": "ok", "size_bytes": 18874368, "bytes_reclaimed": 41943040 }

// "unavailable" — nothing ran; reason says why
{ "status": "unavailable", "reason": "profile is currently in use — stop its running session before clearing the cache" }

// "timeout" — the node didn't reply
{ "status": "timeout" }

// "error" — the node reported a failure; the stored state is untouched
{ "status": "error", "reason": "<node-reported failure>" }
```

`unavailable` covers the expected-inert states: the profile is bound
to a **still-running session** (stop it first — a live session would
save its full un-trimmed state back over the trimmed result), the
profile has **no saved state yet** (a fresh profile has nothing to
trim), or the deployment's profile storage / fleet control plane
isn't enabled. On `"ok"`, `size_bytes` (the new stored size) updates
the storage meter and launch-quota checks immediately. Returns `404`
if the profile isn't found or isn't owned by the calling account.

## Lifecycle interaction

A session is bound to a profile at creation time
(`POST /v1/sessions { profile_id }`). The session carries the
profile's state forward; on destroy, any state mutations are
persisted back to the profile row's underlying storage. Concurrent
sessions on the SAME profile are serialised at the driver layer
to avoid state-merge conflicts.

See [Session lifecycle](/guides/session-lifecycle/) for the full
flow.
