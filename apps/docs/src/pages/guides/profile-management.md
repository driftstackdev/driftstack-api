---
layout: ../../layouts/DocLayout.astro
title: Profile management
description: Persistent profiles in Driftstack — create, list, reuse across sessions, and delete. How profiles relate to archetypes and tier limits.
---

# Profile management

A **profile** is a persistent identity Driftstack maintains across sessions. Cookies, local storage, IndexedDB, and the WebKit-fork's stealth state survive between session lifetimes when you bind the session to a profile.

If you don't bind a profile, each session starts ephemeral — fresh cookies, fresh storage, no continuity. That's the right choice for one-shot fetches. For workflows that need login state, multi-step flows, or returning-visitor signals, bind a profile.

## Tier limits

Each tier has a profile cap, enforced at `POST /v1/profiles` creation time. Exceeding the cap returns `402` with a `profile_cap_reached` body and an upgrade link.

| Tier          | Profile cap |
| ------------- | ----------- |
| Trial pack    | 1           |
| Solo Manual   | 10          |
| Team Manual   | 50          |
| Agency Manual | 200         |
| API Starter   | 25          |
| API Builder   | 100         |
| API Scale     | 500         |
| Enterprise    | Custom      |

Pricing source of truth: [driftstack.dev/pricing](https://driftstack.dev/pricing).

Self-hosted tiers don't enforce per-account profile caps — they enforce concurrent-session caps + archetype counts at the fleet level instead.

## Create a profile

`POST /v1/profiles` with at minimum a `name`. The `archetype` field is optional and defaults to the locked archetype (`iphone16pro_ios18_7_safari26_4` — current iPhone 16 Pro on iOS 18.7 with Safari 26.4). Pin to an older archetype only if you have a behavioural-stability reason.

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
  "id": "prf_01HV...",
  "name": "shopper-account-1",
  "archetype": "iphone16pro_ios18_7_safari26_4",
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

The `last_used_at` field updates every time a session binds to the profile. Sort by it client-side to find recently active profiles.

## Get one profile

`GET /v1/profiles/:id`:

```ts
const profile = await client.profiles.get('prf_01HV...');
```

## Bind a session to a profile

When a session is created with a profile reference, it inherits the profile's storage state on launch and writes new state back on clean destroy (or clean idle-timeout). Without a profile, the session starts ephemeral.

**TypeScript:**

```ts
const session = await client.sessions.create({ label: 'login flow' });
```

The exact field shape for profile binding on session creation is part of the live API contract; consult the OpenAPI spec at `https://api.driftstack.dev/openapi.json` or the SDK type definitions for the most current schema.

## Delete a profile

`DELETE /v1/profiles/:id`. Permanent — storage state is wiped.

```ts
await client.profiles.delete('prf_01HV...');
```

If a session is currently bound to the profile, the deletion blocks until the session ends (or returns `409 Conflict` if you set `force=false`, the default).

## Profile-name conventions

Profile names are free-form strings up to 120 characters. Conventions that work well:

- `<flow>-<account-or-persona>-<index>` — e.g. `signup-test-acct-3`, `shopper-personaA-1`.
- `<environment>-<purpose>` — e.g. `staging-smoke`, `prod-canary`.

Names ARE visible in the dashboard and any team-member access logs. Don't put PII or secrets in profile names; use `description` for human notes if you need them.

## Archetypes

An **archetype** is the device + OS + browser fingerprint a session impersonates. The locked default (`iphone16pro_ios18_7_safari26_4`) tracks current iPhone — when iOS 18.8 ships, the locked archetype slug bumps and new profiles default to the new fingerprint.

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
