# Team roles taxonomy

**Status:** locked as of V-142 (2026-05-05) per founder DECISION 5 in
the overnight directive.
**Owner:** Driftstack engineering.
**Audience:** engineers working on multi-seat account support, which has
SHIPPED — `team_members` + `team_invites` in the schema, six routes under
`/v1/team/*`, and a live `apps/customer-dashboard/src/pages/team.astro`.
This line previously said the backend did not yet ship multi-user
accounts (V-822).

## Why this exists

Manual ladder tiers (Solo / Team / Agency) and API ladder tiers (Starter
/ Builder / Scale / Enterprise) include seats — Solo Manual + API
Starter are 1-seat; Team Manual = 5 seats; Agency Manual = 15 seats; API
ladder includes 5+ seats per tier. When multi-seat accounts ship,
each seat needs an addressable role with a clear capability surface.

`/team` UI scaffolded in V-139 surfaces the roles that exist — this doc
is the authoritative description of the DESIGN. Read the next section
for the gap between it and the implementation (V-822).

## The four roles

```
owner > admin > member > viewer
```

Each role inherits the role below it; permissions are additive.

> **V-822 — two of these four ship.** The Postgres enum is
> `pgEnum('team_role', ['member', 'admin'])`. `viewer` exists nowhere in
> the server, in `packages/api-types`, or in the dashboard's role picker,
> which offers Member and Admin. `owner` is real but is not a role VALUE —
> it is the account that owns the team, carried as
> `team_members.owner_account_id`, so there is no owner row to hold a role.
>
> The four-role model below is the locked V-142 design and is left intact
> as such. **Building `viewer` is an open product decision**, not a
> documentation fix — the read-only stakeholder case it exists for is
> currently served by giving someone `member`, which also lets them create
> sessions. Sections describing owner and viewer permissions are
> therefore aspirational, not a description of the running system.

### Owner

The single authoritative principal on the account. Created automatically
at signup; transferable on request via support workflow.

Permissions:

- Everything `admin` can do, plus:
- Manage billing — change plan, payment method, cancel subscription.
- Invite + remove team members.
- Change member roles (promote member → admin, demote admin → member, etc.).
- Transfer ownership.
- Delete the account (hard-delete cascade per /settings danger-zone).

There is exactly one owner per account. Ownership transfer is
transactional: the new owner accepts via email link, the old owner is
demoted to admin in the same operation. There is no "ownerless" state.

### Admin

Full operational control over the account's product surface, but no
billing or member-management.

Permissions:

- Everything `member` can do, plus:
- Create + revoke API keys with any scope (including the `admin`
  scope on individual keys — the ApiKeyScope `admin` is distinct from
  the team role `admin`; admin team-role grants the ability to mint
  admin-scope keys).
- Manage webhook endpoints (create, edit, delete, view DLQ).
- Configure rate-limit overrides via the customer dashboard
  (where exposed; admin-panel-side overrides remain Driftstack-staff-only).
- Manage profiles for any member (create, edit, delete cross-account
  profiles).
- Force-destroy any session in the account (not just their own).

Admins cannot:

- Manage billing.
- Invite or remove members.
- Change roles.

### Member

Default role for invited team members. Operational access scoped to
their own resources.

Permissions:

- Everything `viewer` can do, plus:
- Create + drive sessions.
- Create + manage their own profiles.
- Read their own session history + recordings.
- Use their personal API keys (created by an admin).
- View team-shared profiles created by admins (read-only).

Members cannot:

- Create API keys (admins mint them).
- Manage webhook endpoints.
- Force-destroy other members' sessions.
- See cross-member usage analytics (only their own).

### Viewer

Read-only access for stakeholders monitoring usage + billing
without operational involvement. Useful for finance / procurement /
compliance team members who need visibility without action authority.

Permissions:

- Read account-level usage analytics + billing state (subscription
  tier + status + invoice list).
- Read profile + session metadata (read-only — no creation, no
  destruction, no driving).
- Read webhook delivery history (no requeue, no DLQ action).
- Read audit log slice for their account.

Viewers cannot:

- Create or modify any resource.
- Drive sessions in the GUI client (the GUI client requires `gui_control`
  scope on an API key, which viewer-role members can't mint themselves).
- Make API calls from code (no API keys to use).

## API key scope ↔ team role mapping

Critical distinction: **API key scopes** gate `/v1/*` HTTP routes, and
**team roles gate them too** — the two compose, they are not split by
layer. They overlap in some places + diverge in others.

> **V-822 correction.** This paragraph used to say team roles gated the
> dashboard only and scopes gated the API. That is not what shipped and it
> is the most dangerous sentence in this document: an engineer adding a
> team-scoped route from that description writes a scope check, skips the
> role check, and ships a hole.
>
> What actually happens: a request carrying `X-Driftstack-Account` is
> resolved by `resolveEffectiveAccount()` against the caller's
> memberships. **Writes on another account require the `admin` role**
> (`effectiveAccountIdForWrite()` throws `ForbiddenError` for a member);
> **reads are role-agnostic** — a member can read the owner's audit log,
> usage and profiles. Thirteen route modules do this today: account-audit,
> account-me, admin, agent-sessions, agent-sessions-livekit-token,
> agent-sessions-transport-report, billing, email-preferences,
> profile-snapshots, profiles, recipes, sessions, webhooks.

| API key scope | Team roles allowed to mint a key with this scope |
| ------------- | ------------------------------------------------ |
| `read`        | owner, admin                                     |
| `write`       | owner, admin                                     |
| `admin`       | owner, admin                                     |
| `gui_control` | owner, admin                                     |

Members + viewers don't mint API keys — they use keys an admin minted
for them. This keeps key-creation auditable: the admin who minted the
key is the audit-row's `admin_account_id`, not the day-to-day user
of the key.

The scope enum itself is closed; adding a new scope is a breaking
change for strictly-typed SDK consumers and triggers the deprecation
cycle. See `docs/architecture/api-versioning.md` (V-220) §
"Per-resource versioning notes — `/v1/api-keys/*`" for the full
breaking-change taxonomy and the path V-174 took when expanding scopes.

## Backend implementation notes (SHIPPED — see the correction below)

> **V-822.** This section was headed "forward-looking" and described
> multi-seat as work still to do. It shipped. What is actually in the repo:
>
> - **Database**: `team_members` and `team_invites`, joining `accounts` to
>   `accounts` — NOT to a `users` table, which does not exist in this schema
>   at all. Columns are `owner_account_id`, `member_account_id`, `role`,
>   `invited_at`, `accepted_at`, `invited_by_account_id`.
> - **Role enum**: `pgEnum('team_role', ['member', 'admin'])` — see the
>   correction under "The four roles".
> - **Routes**: six under `/v1/team/*` — `POST` and `GET /v1/team/invites`,
>   `POST /v1/team/invites/accept`, `GET /v1/team/members`,
>   `GET /v1/team/owners`, `DELETE /v1/team/members/:id`. The paths below are
>   the sketch, and differ: there is no `PATCH .../role` endpoint, and
>   `/v1/team/owners` was never sketched.
> - **Auth**: membership rides on `AccountContext.teams` and is resolved per
>   request by `resolveEffectiveAccount()`, not via "the API key's owning
>   user" — there is no user to own it.
>
> The sketch is kept below as the record of what was planned. Read it as
> history, not as a description of the running system.

The original forward-looking sketch, verbatim:

V-079 auth-flow schema only models single-user accounts today
(`accounts` table 1:1 with `users` table). Multi-seat accounts require:

1. **Database**: a `team_members` table joining `accounts` to
   `users` with a `role: enum('owner', 'admin', 'member', 'viewer')`
   column + `invited_at` + `joined_at` + `invited_by_user_id`.
2. **Auth**: `AccountContext` extends to carry the calling user's
   role via the API key's owning user. Permissions checks branch on
   `ctx.role` for any team-role-gated route.
3. **Routes**:
   - `POST /v1/team/invite` (owner-only) — sends magic-link signup
     to a candidate email + role.
   - `POST /v1/team/accept` (public — magic-link consumer) — creates
     the user account + adds the team_members row.
   - `GET /v1/team/members` — lists current members + pending invites.
   - `PATCH /v1/team/members/:id/role` (owner-only) — promote/demote.
   - `DELETE /v1/team/members/:id` (owner-only) — remove member.
4. **Email**: 2 new transactional templates — invite + role-change-
   notification. Postmark template ids per V-052 sub-processor list.
5. **Customer dashboard**: `/team` page wires to the live endpoints
   above; existing scaffolded UI is the contract.

When this work lands as a V-NNN, this doc gets a "Wire-up" section
documenting the schema migration + endpoint shapes.

## Why 4 roles, not 3 or 5

Considered alternatives:

- **3 roles (owner / admin / member)** — simpler but loses the
  read-only "stakeholder" use case. Finance team members who need
  invoice + usage visibility shouldn't have the ability to create
  sessions; viewer-as-distinct fixes that.
- **5 roles (owner / admin / billing-only / member / viewer)** —
  considered a billing-only role for finance. Ruled out: viewer
  already covers "read billing"; carving out a separate billing-only
  role adds permission-matrix surface without proportional benefit.

The 4-role taxonomy is the locked design as of V-142. Future
expansion (e.g. "developer" role for code-only access without
profile management) is possible but not currently scheduled.
