# Admin scope reach mitigation — V-135 Cloudflare Access dependency

V-253 / V-246-P1-003. Operational note documenting a security-posture
dependency that the codebase relies on but doesn't enforce in app
code.

## TL;DR

The Driftstack API has a known scope-architecture gap: API keys with
the customer-facing `'account_owner'` scope can reach `/v1/admin/*`
routes alongside Driftstack-staff keys with the
`'driftstack_internal_admin'` scope. The mitigation is operational —
**Cloudflare Access on the `admin.driftstack.dev` origin** (V-135)
prevents the customer from reaching the admin origin in the first
place, regardless of API key scope.

> **DO NOT remove or bypass the Cloudflare Access front-door without
> first closing the scope reach in app code.** Doing so re-introduces
> the gap as an exploitable customer→admin escalation path. The
> mitigation is load-bearing; it is not "nice-to-have."

## What's actually in app code

`apps/server/src/services/auth.ts` lines ~255-267 carry a `KNOWN GAP`
comment documenting the architecture:

- `'driftstack_internal_admin'` is the canonical staff scope; admin
  routes ALL accept it.
- `'account_owner'` is the customer-dashboard scope (web sessions
  issued to dashboard users with that role). The original V-174 scope
  split intentionally allowed `account_owner` to also reach
  `/v1/admin/*` so the customer dashboard's "account settings" pages
  could call admin endpoints scoped to the calling customer's own
  account (e.g. listing your own audit log via the admin route surface
  before V-216 added a customer-facing audit endpoint).
- The gap: nothing in app code prevents `account_owner` from calling
  `/v1/admin/*` against ANOTHER customer's account. Account scoping
  in handler bodies prevents most cross-account leaks, but the surface
  is exposed.

## What V-135 actually does

`admin.driftstack.dev` is a separate Cloudflare Pages project (V-135
admin panel scaffolding). The DNS record points at Cloudflare's edge.
Cloudflare Access policy enforces:

- Authenticated identity required (Driftstack staff Google Workspace
  account; future: Okta or similar).
- Access list scoped to `@driftstack.dev` email domain only (and
  optionally specific named identities).
- Customer-facing API keys CANNOT pass the access policy — they're not
  identities Cloudflare Access recognizes.

Net effect: even though app code accepts `account_owner` scope on
`/v1/admin/*` routes, a customer's API key can't reach the admin
origin to send the request in the first place. The customer would
have to reach the canonical API origin (`api.driftstack.dev`) which
exposes only `/v1/*` (non-admin).

## Conditions for safely closing the V-135 dependency

The mitigation can be removed (V-135 deployment retired or relaxed)
ONLY after the underlying scope reach is closed in app code. Closure
shape (queued as V-NNN follow-up):

1. Split admin routes into two registration paths:
   - `/v1/admin/*` accepts ONLY `driftstack_internal_admin` scope.
   - Customer-facing equivalents land under `/v1/account/*` with
     `account_owner` scope (e.g. `/v1/account/audit-log` already
     exists per V-216; `/v1/account/me` per V-237; future
     `/v1/account/*` endpoints replace any remaining customer use of
     `/v1/admin/*`).
2. Update auth.ts `KNOWN GAP` comment to "RESOLVED V-NNN" and remove
   the `account_owner` reach into `/v1/admin/*`.
3. Audit existing customer-dashboard code to confirm no live caller
   relies on `account_owner` → `/v1/admin/*`.
4. Verify with an integration test that asserts `account_owner` keys
   get 403 on `/v1/admin/*` post-fix.

Until those four steps land, V-135 Cloudflare Access is the
load-bearing mitigation.

## Verification checklist (founder, on Cloudflare config)

When configuring Cloudflare for `admin.driftstack.dev`, verify:

- [ ] Cloudflare Access policy is in place on the `admin.driftstack.dev`
      hostname (Application → Access → Applications).
- [ ] Access policy is set to **Bypass: NEVER allow without identity**.
- [ ] Identity provider is configured (Google Workspace recommended;
      Okta also acceptable).
- [ ] Access list is scoped to `@driftstack.dev` email domain only OR
      to a named list of staff identities. **Do NOT use `Allow: any
authenticated user`** — that would let any Google Workspace
      account in the world reach the admin panel.
- [ ] Session duration is set conservatively (24h or less) so a
      compromised laptop with an active session doesn't have
      indefinite access.
- [ ] `apps/admin-panel/` build target is set to deploy ONLY to
      `admin.driftstack.dev`, never to a public URL.

## Related

- V-135 — admin panel separate origin scaffolding.
- V-174 — scope architecture split (D-035 documents the scope model).
- V-216 — customer-facing audit log endpoint (closed one customer use
  of `/v1/admin/*`).
- V-237 — `/v1/account/me` customer self-profile (closed another).
- V-246-P1-003 — pre-launch security audit finding that surfaced this
  note.
- V-253 — this V-log entry.
