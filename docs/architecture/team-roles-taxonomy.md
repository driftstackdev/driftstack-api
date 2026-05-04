# Team roles taxonomy

**Status:** locked as of V-142 (2026-05-05) per founder DECISION 5 in
the overnight directive.
**Owner:** Driftstack engineering.
**Audience:** future engineers wiring multi-seat account support
(currently scaffolded in `apps/customer-dashboard/src/pages/team.astro`,
backend doesn't yet ship multi-user accounts in V-079 schema).

## Why this exists

Manual ladder tiers (Solo / Team / Agency) and API ladder tiers (Starter
/ Builder / Scale / Enterprise) include seats — Solo Manual + API
Starter are 1-seat; Team Manual = 5 seats; Agency Manual = 15 seats; API
ladder includes 5+ seats per tier. When multi-seat accounts ship,
each seat needs an addressable role with a clear capability surface.

`/team` UI scaffolded in V-139 surfaces the four-role taxonomy already
— this doc is the authoritative description.

## The four roles

```
owner > admin > member > viewer
```

Each role inherits the role below it; permissions are additive.

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

Critical distinction: **team roles** gate dashboard UI access; **API key
scopes** gate `/v1/*` HTTP routes. They overlap in some places + diverge
in others.

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

## Backend implementation notes (forward-looking)

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
