# Admin scope boundary — V616 closed in application code

V-253 / V-246-P1-003 originally documented Cloudflare Access as an
operational mitigation for an authorization gap. V616 supersedes that posture:
the application now enforces the customer/staff boundary itself.

## Current contract

- `/v1/admin/*` requires the exact `driftstack_internal_admin` scope.
- `account_owner` controls only the caller's own customer account.
- The deprecated `admin` token remains parseable for stored legacy keys and
  satisfies `account_owner` plus customer `admin:*` checks. It never satisfies
  `driftstack_internal_admin`.
- Cloudflare Access on `admin.driftstack.io` remains required defense in
  depth, but it is no longer the authorization boundary protecting the API.

The `admin` database-enum value is intentionally retained. Removing it before
all stored legacy keys are rotated or revoked would turn safe customer keys into
authentication failures; keeping it does not grant staff authority.

## Regression evidence

V616 closes both copies of the scope predicate:

- `apps/server/src/lib/errors-helpers.ts::scopesSatisfy`
- `apps/server/src/services/auth.ts::requireScope`

The test matrix proves that legacy `admin` still satisfies `account_owner`,
cannot satisfy `driftstack_internal_admin`, and receives `403` from a real
`/v1/admin/accounts/:id/tier` route. Explicit `driftstack_internal_admin`
continues to pass the same route.

Customer-facing equivalents already live under `/v1/account/*`, including
`/v1/account/audit-log` (V-216) and `/v1/account/me` (V-237). Customer clients
must never call `/v1/admin/*`.

## Cloudflare Access checklist

Application-layer enforcement does not make the admin origin public. Keep the
separate identity perimeter configured as defense in depth:

- [ ] Cloudflare Access policy covers `admin.driftstack.io`.
- [ ] Bypass is never allowed without identity.
- [ ] The identity provider is restricted to named Driftstack staff identities
      or the controlled `@driftstack.dev` organization.
- [ ] Do not use `Allow: any authenticated user`.
- [ ] Session duration is 24 hours or less.
- [ ] `apps/admin-panel/` deploys only to the protected admin origin.

## Related

- V-135 — separate protected admin-panel origin.
- V-174 — original scope architecture split.
- V-216 — customer-facing audit-log endpoint.
- V-237 — customer self-profile endpoint.
- V-253 / V-246-P1-003 — historical finding, superseded by V616.
- V616 — exact internal-admin authorization and legacy-alias closure.
