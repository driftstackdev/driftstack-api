# 2026-05-26 — staging hostname inconsistency (resolved 2026-07-13)

The original audit found three competing staging API spellings and an
unverified dashboard custom domain. The runnable topology is now explicit.

## Verified live topology

- API: `https://staging.driftstack.dev`
- Customer dashboard: `https://staging.driftstack-customer-dashboard.pages.dev`
- Admin dashboard: `https://staging.driftstack-admin-panel.pages.dev`
- Status: `https://staging.driftstack-status.pages.dev`

The customer dashboard value is Cloudflare Pages' stable `staging` branch
alias, not an immutable deployment preview. On 2026-07-13 the API returned
that origin from `/v1/auth/cli-authorize/initiate`; the authorize page was
HTTP 200, code/state isolation and pending exchange passed, and strict CORS
accepted the customer/admin/status aliases while rejecting an attacker
origin.

`app-staging.driftstack.dev` has no DNS record. It is no longer a runnable
environment value or Tauri shell capability. If a custom domain is added in
the future, provision it in Cloudflare first and change the server env, GUI
capability, and docs atomically only after DNS, TLS, browser activation, and
strict-CORS acceptance pass.

## Historical API spellings

`api-staging.driftstack.dev` was corrected to the then-configured dotted
nginx name in commit `3cf9e147`. Current deployment and verification scripts
use the live `staging.driftstack.dev` API origin. Remaining occurrences of
`staging-api.driftstack.dev` belong to the separate DR rehearsal safety list
or historical verification records; they are not customer quickstart values
and must not be copied into active environment configuration.

## Operator rule

Do not use a hostname merely because it satisfies the server's non-localhost
boot guard. Every `DASHBOARD_ORIGIN` must also be reachable and must match the
GUI shell-open capability plus the API's strict CORS allow-list.
