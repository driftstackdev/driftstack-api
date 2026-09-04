---
layout: ../../layouts/DocLayout.astro
title: Team RBAC — invite, accept, act-as
description: End-to-end tutorial for setting up a multi-user team in Driftstack — invite a teammate, accept the invite, act on the owner's resources via X-Driftstack-Account.
---

# Team RBAC — invite, accept, act-as

This guide walks through the full lifecycle of a Driftstack team:
the **owner** invites a **member**, the member accepts, and the
member then runs sessions / manages resources scoped to the owner's
account.

You'll need:

- An owner account (already paying the subscription).
- A second teammate's email address.
- A Driftstack web session (sign in to the dashboard) OR an API key
  with `account_owner` scope.

The `account_owner` requirement covers invite, acceptance, and removal.
If an integration only lists team members, pending invites, or joined
owners, broad `read` is sufficient.

For the API reference (every endpoint, every field), see
[/api/team](/api/team/). This guide focuses on the customer flow.

## Step 1 — Invite a teammate (owner)

From the owner's dashboard, navigate to **Team** in the sidebar +
click **Invite member**. Fill in:

- **Email**: the teammate's email address. They'll be able to accept
  only when signed in to a Driftstack account on this address.
- **Role**:
  - `member` — read access to the owner's persisted session metadata /
    profiles / audit log / etc. Live session state requires `admin`.
    Cannot make changes.
  - `admin` — full read + write. Can create sessions, mint API
    keys, manage webhooks on the owner's behalf.

Programmatic equivalent:

```bash
curl -X POST https://api.driftstack.dev/v1/team/invites \
  -H "Authorization: Bearer $DRIFTSTACK_OWNER_KEY" \
  -H "content-type: application/json" \
  -d '{"email": "alice@example.com", "role": "admin"}'
```

The teammate receives an email with a 7-day accept link.

## Step 2 — Accept the invite (teammate)

The teammate signs up at <https://app.driftstack.io/signup/> using
the invitee email address (must match exactly), then clicks the
accept link from the invite email.

The link takes them to the dashboard's `/team/accept` page; the
page calls `POST /v1/team/invites/accept` with the token from the
URL. Server validates that the signed-in account's email matches
the invitee email + writes the membership row.

If the teammate already has an account (under the same email),
they can sign in first and then click the accept link.

## Step 3 — See the team you're on (member)

The member's `/v1/account/me` response includes a `teams[]` array
listing every owner they're a member of. The dashboard sidebar
displays an **Acting as** picker that:

- Lists the member's own account (default) + each owner team.
- Persists the selection to `localStorage.ds_act_as_account`.
- Auto-injects `X-Driftstack-Account: acc_<owner-uuid>` on every
  subsequent dashboard fetch.

Programmatic equivalent (no dashboard):

```bash
# member's own profile + team list
curl -H "Authorization: Bearer $MEMBER_KEY" \
  https://api.driftstack.dev/v1/account/me
# returns:
#   {
#     "id": "acc_…",
#     "email": "alice@example.com",
#     ...
#     "teams": [
#       { "owner_account_id": "acc_owner-uuid", "role": "admin",
#         "membership_id": "mem_…" }
#     ]
#   }

# alternative: dedicated read of teams the member is on
curl -H "Authorization: Bearer $MEMBER_KEY" \
  https://api.driftstack.dev/v1/team/owners
```

## Step 4 — Act on the owner's resources (member, admin role)

Once the member has a team, any `/v1/*` request can be scoped to
the owner by passing `X-Driftstack-Account: acc_<owner-uuid>`:

```bash
# create a session OWNED by the team owner; counts against the
# OWNER's concurrent cap. The request consumes sessions:create
# for the member first, then the same bucket for the OWNER using
# the owner's current tier/override.
curl -X POST https://api.driftstack.dev/v1/sessions \
  -H "Authorization: Bearer $MEMBER_KEY" \
  -H "X-Driftstack-Account: acc_owner-uuid" \
  -H "content-type: application/json" \
  -d '{}'
```

Role gating:

- **Persisted metadata reads** on `/v1/sessions` (list and detail): both
  `member` and `admin` allowed.
- **Agent-session reads are the exception.** `GET /v1/agent-sessions`
  requires `admin` even though it is a read: an agent session carries the
  model transcript and live control state, so the collection is not
  widened to read-only members. A `member` acting on an owner gets `403`
  there while the plain session list still works.
- **Live session state** (`GET /v1/sessions/:id/state`): `admin` only.
  It claims the driver and returns cookies/local storage; `member` gets
  `403` before any session or driver mutation.
- **Write endpoints** (POST / PATCH / DELETE / api-keys rotate):
  `admin` role only. `member` gets `403`.

Team-resource session and agent-session routes use dual rate-limit
accounting after those role checks. The member first spends from their
own bucket. A distinct selected owner then spends from the same bucket
key and cost, using the owner's current tier and active override.
Owner exhaustion returns a generic 429 with `Retry-After`; it does not
reveal the owner's policy or refund the member's already-consumed token.

Endpoints that honor the header:

| Resource          | Which routes                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions          | every `/v1/sessions` route you can call                                                                                                                                                                                                     |
| Agent sessions    | every `/v1/agent-sessions` route, including `/message`. Note the collection READ needs `admin` — see above                                                                                                                                  |
| Profiles          | every `/v1/profiles` route — not just CRUD, but `trash`, `restore`, `purge`, `clone`, `export`, `import`, `transfer`, `trim`                                                                                                                |
| Profile snapshots | every `/v1/profile-snapshots` route, and `/v1/profiles/{id}/snapshots`                                                                                                                                                                      |
| Profile taxonomy  | `/v1/account/me/organization` — GET (member/admin), PUT (admin only)                                                                                                                                                                        |
| API keys          | every `/v1/api-keys` route, including `{id}/rotate`                                                                                                                                                                                         |
| Webhooks          | every `/v1/webhooks` route — GET / POST / PATCH / DELETE plus `{id}/deliveries`, `{id}/rotate-secret`, `{id}/test`, and delivery replay. The Stripe and NOWPayments receivers under this prefix are provider callbacks, not customer routes |
| Audit log         | GET + `/export`                                                                                                                                                                                                                             |
| Email preferences | GET / PUT (PUT = admin)                                                                                                                                                                                                                     |
| Usage             | GET, `/series`                                                                                                                                                                                                                              |
| Billing           | `GET /v1/billing` only — checkout and portal sessions are per-caller                                                                                                                                                                        |

This table was previously narrower than the server: it named four profile
methods where every profile route honors the header, and omitted webhook
PATCH, rotate-secret and test entirely. If you are unsure about a route
not listed here, the safe assumption is that it operates on your own
account.

Endpoints that do NOT honor the header (operate on the caller's
own account regardless):

- `/v1/team/*` — managing your own team is always per-caller.
- Exact `/v1/account/me` — always returns the caller's own profile +
  team list. Its nested `/v1/account/me/organization` profile
  taxonomy is listed above and does honor the header.
- `/v1/auth/*` — authentication is per-caller.
- `/v1/recipes/*` — the header is IGNORED here, not rejected. A recipe is
  always created under your own account. What team membership does give
  you is reach into the SOURCE: `POST /v1/recipes` accepts an
  `agent_session_id` owned by a team you hold `admin` on, and snapshots it
  into a recipe that belongs to you. Sending `X-Driftstack-Account` does
  not place the recipe under the owner.

## Step 5 — Audit the team's actions (owner)

When an endpoint emits an audit entry for a member's action on the
owner's resources, that entry is written to the OWNER's audit log
with:

- `account_id`: the owner.
- `actor_account_id`: the member when that endpoint propagates team
  actor context.
- `actor_key_id`: the member's API key id when that context is
  propagated.

Not every endpoint currently emits an audit entry or propagates team
actor context. Treat these actor fields as endpoint-specific
provenance, not as a complete record of every team action.

So the owner sees, in their audit log, "Member alice@example.com
(`acc_…`) created session `ses_…` on this account at 2026-05-08
14:02 UTC".

Get the log:

```bash
curl -H "Authorization: Bearer $OWNER_KEY" \
  https://api.driftstack.dev/v1/account/audit-log?limit=50
```

Or download it as CSV:

```bash
curl -H "Authorization: Bearer $OWNER_KEY" \
  "https://api.driftstack.dev/v1/account/audit-log/export?format=csv" \
  > team-history.csv
```

(See [GDPR Article 20 portability](/api/audit-log/#export)
for the export ceiling + cursor pagination beyond 10K rows.)

## Removing a member (owner)

When a teammate leaves:

```bash
curl -X DELETE https://api.driftstack.dev/v1/team/members/$MEMBERSHIP_ID \
  -H "Authorization: Bearer $OWNER_KEY"
```

The membership row is deleted; the member's auth-cache is
invalidated immediately so their `X-Driftstack-Account` header
stops working on the next request. Their own account stays — only
the team relationship is severed.

A `team.member_removed` audit entry lands on the owner's log; the
member is NOT separately notified by Driftstack (the owner can do
that via their own channels).

## Common patterns

### Multiple admins on a team

A team can have any number of `admin`-role members, but every one
of them is invited by the **owner** — `POST /v1/team/invites`
requires the `account_owner` scope and always creates invites for
the caller's own team (as noted above, `/v1/team/*` never honors
`X-Driftstack-Account`, so an admin calling invite would be
inviting people to their _own_ team, not the owner's). The owner
is always implicitly "admin" on their own team (no separate
membership row).

Each admin retains an independent actor budget, but all admins targeting
the same owner share that owner's budget. For example, simultaneous
session creates by two admins contend on one owner
`sessions:create` bucket; adding admins never multiplies owner capacity.

### Read-only collaborators

Use `role: 'member'` for read-only access. Useful for:

- Auditors / compliance reviewers (read the audit log + usage
  reports without write capability).
- Junior teammates being onboarded (read session list/detail metadata +
  profiles without risk of accidentally minting a key or destroying a
  session).

### Graceful key rotation across the team

When the owner rotates an API key (`POST /v1/api-keys/:id/rotate`),
the new plaintext is shown ONCE on the rotating client. If multiple
teammates use the same key (e.g. across CI machines), the rotation
flow is:

1. Owner (or admin member) rotates → new key, 24h grace on the old.
2. Teammates have 24h to swap deployments to the new key.
3. After 24h the old key auto-expires server-side.

Teammates calling the rotation endpoint themselves require admin
role + `X-Driftstack-Account` header pointing at the owner.

## Privacy note

A team member is a separate Data Subject from the owner. Their
account email is processed under [Privacy §3.1](https://driftstack.io/legal/privacy/#31-account-data)
on the same legal basis as any other Customer contact. Removing the
member from the team does not delete their Driftstack account; only
the membership relationship.

## Next steps

- [/api/team/](/api/team/) — full reference for every endpoint +
  field shape.
- [/api/api-keys/](/api/api-keys/) — API key minting + rotation
  flows; both honor `X-Driftstack-Account`.
- [/webhooks/replay/](/webhooks/replay/) — replay individual
  deliveries; admin-only on team owners.
