---
layout: ../../layouts/DocLayout.astro
title: Profile management
description: Persistent profiles in Driftstack — create, list, reuse across sessions, and delete. How profiles relate to archetypes and tier limits.
---

# Profile management

A **profile** is a persistent identity Driftstack maintains across sessions. Cookies, local storage, IndexedDB, and the WebKit-fork's stealth state survive between session lifetimes when a session binds to a profile.

If a session doesn't bind a profile, it starts ephemeral — fresh cookies, fresh storage, no continuity. That's the right choice for one-shot fetches. For workflows that need login state, multi-step flows, or returning-visitor signals, bind a profile — pass `profile_id` on `sessions.create()`, or call `profiles.launch()` (see "Bind a session to a profile" below).

## Tier limits

Each tier has a profile cap, enforced at `POST /v1/profiles` creation time. Exceeding the cap returns `429` with an RFC 9457 `https://errors.driftstack.dev/tier-limit` problem body — the `detail` string names the tier and the cap.

| Tier        | Profile cap |
| ----------- | ----------- |
| Free        | 1           |
| Personal    | 10          |
| Team        | 50          |
| Agency      | 200         |
| API Starter | 25          |
| API Builder | 100         |
| API Scale   | 500         |
| Enterprise  | Custom      |

Pricing source of truth: [driftstack.dev/pricing](https://driftstack.dev/pricing/).

Self-hosted tiers don't enforce per-account profile caps — they enforce concurrent-session caps + archetype counts at the fleet level instead.

## Create a profile

`POST /v1/profiles` with at minimum a `name`. The `archetype` field is optional and defaults to the locked archetype (`iphone17_ios18_7_safari26_4` — current iPhone 17 on iOS 18.7 with Safari 26.4). Pin to an older archetype only if you have a behavioural-stability reason.

**TypeScript:**

```ts
const profile = await client.profiles.create({
  name: 'shopper-account-1',
  description: 'Returning-visitor profile for the shopping flow',
});
console.log(profile.id, profile.archetype);
```

**Python:**

```python
profile = client.profiles.create({
    "name": "shopper-account-1",
    "description": "Returning-visitor profile for the shopping flow",
})
```

**Go:**

```go
profile, err := client.Profiles.Create(ctx, &driftstack.CreateProfileRequest{
    Name:        "shopper-account-1",
    Description: "Returning-visitor profile for the shopping flow",
})
```

The response is the full `Profile`:

```json
{
  "id": "prof_01HV...",
  "name": "shopper-account-1",
  "archetype": "iphone17_ios18_7_safari26_4",
  "description": "Returning-visitor profile for the shopping flow",
  "last_used_at": null,
  "created_at": "2026-05-07T11:00:00.000Z",
  "updated_at": "2026-05-07T11:00:00.000Z"
}
```

`name` is unique within an account. Re-using a name returns `409 Conflict`.

## List profiles

`GET /v1/profiles` returns paginated results with cursor-based pagination.

```ts
const { data, has_more, next_cursor } = await client.profiles.list({ limit: 50 });
for (const p of data) console.log(p.name, p.last_used_at);
```

The `last_used_at` field updates every time a session binds to the profile — both on `POST /v1/sessions` with a `profile_id` and on `POST /v1/profiles/:id/launch`. Sort by it client-side to find recently active profiles.

## Get one profile

`GET /v1/profiles/:id`:

```ts
const profile = await client.profiles.get('prof_01HV...');
```

## Bind a session to a profile

`POST /v1/sessions` accepts an optional `profile_id` field as of 2026-05-20 (commit `fa8cb83a`). When supplied, the server inherits the profile's `archetype` as the default, stamps `{profile_id, profile_name}` into the session's `metadata`, and bumps the profile's `last_used_at` fire-and-forget:

```ts
const session = await client.sessions.create({
  profile_id: 'prof_01HV...',
  // archetype optional — inherited from profile when absent
  label: 'checkout-run-2026-05-20',
});
```

Cross-account `profile_id` returns `404` (anti-enumeration — indistinguishable from a missing one).

## Launch a profile (one-shot)

For the antidetect-browser flow (where the typical action is "give me a session on this profile, right now"), the SDK exposes `profiles.launch(id, body?)` as a one-round-trip alternative to `sessions.create({ profile_id })`:

```ts
const session = await client.profiles.launch('prof_01HV...', {
  // `label` for human-readable identification in the dashboard — the
  // only override this endpoint accepts today.
  label: 'checkout-run-2026-05-20',
});
```

Returns the freshly-minted session (same shape as `sessions.create`). The dashboard `/profiles` page exposes a per-row **Launch** button that calls this endpoint and surfaces the returned `session.id`; from there the customer drives the session via the desktop GUI client's Live session view or the standard `navigate`/`interact`/`wait`/`capture`/`destroy` verbs from any SDK.

`profiles.launch()` does not support customer-configurable egress yet — there's no `proxy` field to set, since `/v1/sessions`' execution backend has no driver-layer proxy plumbing today. If you need customer-controlled egress today, use `client.agentSessions.create({ proxy_id })` instead, which dispatches to the real device fleet and routes traffic through one of your saved account proxies.

Profile-bound sessions inherit the profile's storage state on launch and write new state back on clean destroy. (There is no idle timeout on any tier — the only auto-destroy is the free tier's 20-minute duration cap.) Without a `profile_id`, sessions start ephemeral.

## Delete a profile

`DELETE /v1/profiles/:id`. Soft-delete — the profile moves to a **recycle bin**: hidden from your list, its name freed for reuse, but restorable for 30 days (after which it's permanently purged).

```ts
await client.profiles.delete('prof_01HV...');
```

Idempotent — there's no `force` flag, and re-deleting an already-trashed profile still returns `204`. To recover, list `GET /v1/profiles/trash` then `POST /v1/profiles/:id/restore` (see the [API reference](/api/profiles/#delete-recycle-bin)).

## Clone a profile

`POST /v1/profiles/:id/clone`. Duplicates the profile metadata into a new row carrying the source's `archetype` + `description`. Underlying storage state is NOT cloned — the new profile starts with a fresh state slot under the same archetype.

```ts
// Auto-derived "(copy)" / "(copy 2)" / ... naming.
const copy = await client.profiles.clone('prof_01HV...');

// Or pass an explicit name.
const named = await client.profiles.clone('prof_01HV...', { name: 'staging-mirror' });
```

Tier-cap + name-conflict are checked the same way as `create`: 429 if your tier limit would be exceeded, 409 on explicit-name collision, 404 if the source profile isn't yours or doesn't exist. The audit-log entry for the new profile carries `payload.cloned_from: "profile_<uuid>"` (the internal `profile_` prefix; see [audit-log payload reference](/api/audit-log/#payload-reference) for the format).

## Snapshots — immutable point-in-time copies

A snapshot is a frozen copy of a profile. The parent profile keeps evolving — its name, description, and storage state mutate as you use it. The snapshot does not.

**Capture.** `POST /v1/profiles/:id/snapshots`.

```ts
const snap = await client.profileSnapshots.capture('prof_01HV...', {
  label: 'before-iOS-26',
  description: 'pre-rollout reference', // optional
});
// snap.id — "psnap_<uuid>"
// snap.parent_archetype, snap.parent_name — frozen at capture time
```

**List.** Per-profile or cross-account.

```ts
const perProfile = await client.profileSnapshots.listForProfile('prof_01HV...');
const everySnapshot = await client.profileSnapshots.list();

// Iterate every snapshot in your account, walking cursor pages.
for await (const s of client.profileSnapshots.iterate()) {
  console.log(s.label, s.captured_at);
}
```

**Restore.** Creates a NEW profile (the original is never modified).

```ts
const restored = await client.profileSnapshots.restore(snap.id, {
  name: 'restored-from-baseline',
});
```

Tier-cap + name-conflict apply the same way as create. The audit-log entry on the new profile carries `payload.restored_from_snapshot: "psnap_<uuid>"` (the public `psnap_` prefix; see [audit-log payload reference](/api/audit-log/#payload-reference)).

**Delete.** `DELETE /v1/profile-snapshots/:id`.

Snapshots have no automatic lifecycle. Capture as many as you want; they sit until you delete them. Deleting the parent profile sets `parent_profile_id` to `null` but keeps the snapshot — the captured `parent_archetype`, `parent_name`, and state stay restorable.

The same surface is available in the Python and Go SDKs as `client.profile_snapshots.*` and `client.ProfileSnapshots.*` respectively.

## Profile-name conventions

Profile names are free-form strings up to 120 characters. Conventions that work well:

- `<flow>-<account-or-persona>-<index>` — e.g. `signup-test-acct-3`, `shopper-personaA-1`.
- `<environment>-<purpose>` — e.g. `staging-smoke`, `prod-canary`.

Names ARE visible in the dashboard and any team-member access logs. Don't put PII or secrets in profile names; use `description` for human notes if you need them.

## Archetypes

An **archetype** is the device + OS + browser fingerprint a session impersonates. The locked default (`iphone17_ios18_7_safari26_4`) tracks current iPhone — when iOS 18.8 ships, the locked archetype slug bumps and new profiles default to the new fingerprint.

Profiles pin to one archetype at creation time. The pin is stable: a profile created against `iphone16pro_ios18_7_safari26_4` keeps that fingerprint forever, even after the locked default rolls forward. This stability is intentional — re-using a profile shouldn't surprise downstream behavioural-detection systems with a sudden iOS bump.

To migrate a profile to a newer archetype, create a fresh profile pinned to the new archetype and walk through any session-state migration manually.

## What gets persisted

When a session binds to a profile, on session destroy the profile's storage state captures:

- HTTP cookies (incl. `Secure`, `HttpOnly`, `SameSite` attributes; partition keys preserved).
- WebStorage: `localStorage` and `sessionStorage` (per-origin partitions).
- IndexedDB databases (per-origin partitions).
- Service Worker registrations + Cache Storage entries (per-origin partitions).
- The WebKit-fork's stealth state (canvas/font/audio noise seeds — re-used across sessions to keep the fingerprint stable).

What does NOT persist:

- The DOM tree of the last page (sessions always start with a fresh page).
- Active WebSocket / EventSource connections (open a fresh one on the next session).
- WebRTC peer connections.

## Next steps

- **[Session lifecycle](/guides/session-lifecycle/)** — full lifecycle reference including profile-binding semantics.
- **[API versioning](/api/versioning/)** — how additive fields roll out without breaking existing SDK calls.
- **[Webhook events](/webhooks/events/)** — `profile.created`, `profile.deleted` event subscriptions.
