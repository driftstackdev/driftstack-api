# V-455 — Comprehensive OpenAPI + SDK coverage audit

Per Rule L systematic discovery (V-441/V-445/V-452 pattern).
Enumerates every server route under `apps/server/src/routes/` and
classifies its coverage across:

1. **OpenAPI spec** (`apps/server/src/lib/openapi.ts`).
2. **TS SDK** (`packages/sdk-typescript/src/resources/*.ts`).
3. **Python SDK** (`packages/sdk-python/src/driftstack/resources/*.py`).
4. **Go SDK** (`packages/sdk-go/*.go`).

Symbols:

- ✅ — covered.
- ❌ — missing.
- 🚫 — intentionally not exposed (admin / staff / internal).
- 〰 — partial (e.g. only some sub-paths covered).

Generated 2026-05-09. Re-run by:

```
grep -rhEo "['\\\"]/v[0-9][^'\\\"]+['\\\"]" apps/server/src/routes/ | sort -u
grep -oE "'/v[0-9][^']+'" apps/server/src/lib/openapi.ts | sort -u
grep -roE "'/v[0-9][^']+'" packages/sdk-typescript/src
grep -roE "\"/v[0-9][^\"]+\"" packages/sdk-python/src
grep -roE "\"/v[0-9][^\"]+\"" packages/sdk-go
```

## Customer-facing surfaces

### Auth (`/v1/auth/*`)

| Route                                | OpenAPI | TS  | Py  | Go  | Notes                     |
| ------------------------------------ | ------- | --- | --- | --- | ------------------------- |
| POST /v1/auth/signup                 | ✅      | ✅  | ✅  | ✅  | V-401                     |
| POST /v1/auth/verify-email           | ✅      | ✅  | ✅  | ✅  | V-401                     |
| POST /v1/auth/login                  | ✅      | ✅  | ✅  | ✅  | V-401, V-423 union return |
| POST /v1/auth/refresh                | ✅      | ✅  | ✅  | ✅  | V-401                     |
| POST /v1/auth/logout                 | ✅      | ✅  | ✅  | ✅  | V-401                     |
| POST /v1/auth/magic-link/request     | ✅      | ✅  | ✅  | ✅  | V-402                     |
| POST /v1/auth/magic-link/consume     | ✅      | ✅  | ✅  | ✅  | V-402                     |
| POST /v1/auth/password-reset/request | ✅      | ✅  | ✅  | ✅  | V-402                     |
| POST /v1/auth/password-reset/confirm | ✅      | ✅  | ✅  | ✅  | V-402                     |
| POST /v1/auth/mfa/challenge          | ✅      | ✅  | ✅  | ✅  | V-401, V-445 SDK methods  |
| POST /v1/auth/mfa/step-up            | ✅      | ✅  | ✅  | ✅  | V-401, V-445 SDK methods  |
| POST /v1/auth/cli-authorize/initiate | ✅      | ✅  | ✅  | ✅  | V-460                     |
| POST /v1/auth/cli-authorize/exchange | ✅      | ✅  | ✅  | ✅  | V-460                     |
| POST /v1/auth/cli-authorize/bind     | ✅      | ✅  | ✅  | ✅  | V-460                     |

### Account self-service (`/v1/account/*`)

| Route                                          | OpenAPI | TS  | Py  | Go  | Notes                             |
| ---------------------------------------------- | ------- | --- | --- | --- | --------------------------------- |
| GET /v1/account/me                             | ✅      | ✅  | ✅  | ✅  | V-385/V-428/V-434                 |
| PATCH /v1/account/me                           | ✅      | ✅  | ✅  | ✅  | V-450                             |
| POST /v1/account/me/avatar                     | ✅      | ✅  | ✅  | ✅  | V-387/V-450                       |
| DELETE /v1/account/me/avatar                   | ✅      | ✅  | ✅  | ✅  | V-387/V-450                       |
| GET /v1/account/audit-log                      | ✅      | ✅  | ✅  | ✅  | V-449                             |
| GET /v1/account/audit-log/export               | 〰      | ❌  | ❌  | ❌  | OpenAPI partial; SDK gap (export) |
| GET /v1/account/email-preferences              | ✅      | ✅  | ✅  | ✅  | V-449                             |
| PUT /v1/account/email-preferences              | ✅      | ✅  | ✅  | ✅  | V-449                             |
| GET /v1/account/mfa                            | ✅      | ✅  | ✅  | ✅  | V-448                             |
| POST /v1/account/mfa/enroll                    | ✅      | ✅  | ✅  | ✅  | V-448                             |
| POST /v1/account/mfa/verify                    | ✅      | ✅  | ✅  | ✅  | V-448                             |
| DELETE /v1/account/mfa                         | ✅      | ✅  | ✅  | ✅  | V-448                             |
| POST /v1/account/mfa/disable                   | ✅      | 〰  | 〰  | 〰  | DELETE alias; SDKs use DELETE     |
| POST /v1/account/mfa/recovery-codes/regenerate | ✅      | ✅  | ✅  | ✅  | V-448                             |
| GET /v1/account/rate-limits                    | ✅      | ✅  | ✅  | ✅  | V-450                             |
| GET /v1/account/web-sessions                   | ✅      | ✅  | ✅  | ✅  | V-450                             |
| DELETE /v1/account/web-sessions                | ✅      | ✅  | ✅  | ✅  | V-450 (revoke-all-other)          |
| DELETE /v1/account/web-sessions/:id            | ✅      | ✅  | ✅  | ✅  | V-450                             |

### Sessions (`/v1/sessions`)

| Route                           | OpenAPI | TS  | Py  | Go  | Notes               |
| ------------------------------- | ------- | --- | --- | --- | ------------------- |
| POST /v1/sessions               | ✅      | ✅  | ✅  | ✅  |                     |
| GET /v1/sessions                | ✅      | ✅  | ✅  | ✅  |                     |
| GET /v1/sessions/:id            | ✅      | ✅  | ✅  | ✅  |                     |
| DELETE /v1/sessions/:id         | ✅      | ✅  | ✅  | ✅  | (destroy)           |
| POST /v1/sessions/:id/navigate  | ✅      | ✅  | ✅  | ✅  |                     |
| POST /v1/sessions/:id/interact  | ✅      | ✅  | ✅  | ✅  |                     |
| POST /v1/sessions/:id/wait      | ✅      | ✅  | ✅  | ✅  |                     |
| POST /v1/sessions/:id/capture   | ✅      | ✅  | ✅  | ✅  |                     |
| GET /v1/sessions/:id/state      | ✅      | ✅  | ✅  | ✅  |                     |
| POST /v1/sessions/:id/gui-input | ❌      | ❌  | ❌  | ❌  | **GAP** — GUI input |

### Profiles (`/v1/profiles`)

| Route                                  | OpenAPI | TS  | Py  | Go  | Notes                                      |
| -------------------------------------- | ------- | --- | --- | --- | ------------------------------------------ |
| POST /v1/profiles                      | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP** — base create unregistered |
| GET /v1/profiles                       | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP** — list                     |
| GET /v1/profiles/:id                   | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                            |
| PATCH /v1/profiles/:id                 | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                            |
| DELETE /v1/profiles/:id                | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                            |
| POST /v1/profiles/:id/clone            | ✅      | ✅  | ✅  | ✅  | V-313                                      |
| POST /v1/profiles/:id/snapshots        | ✅      | ✅  | ✅  | ✅  | V-312                                      |
| GET /v1/profiles/:id/snapshots         | ✅      | ✅  | ✅  | ✅  | V-312                                      |
| GET /v1/profile-snapshots              | ✅      | ✅  | ✅  | ✅  | V-312                                      |
| GET /v1/profile-snapshots/:id          | ✅      | ✅  | ✅  | ✅  | V-312                                      |
| POST /v1/profile-snapshots/:id/restore | ✅      | ✅  | ✅  | ✅  | V-312                                      |
| DELETE /v1/profile-snapshots/:id       | ✅      | ✅  | ✅  | ✅  | V-312                                      |

### API keys (`/v1/api-keys`)

| Route                        | OpenAPI | TS  | Py  | Go  | Notes |
| ---------------------------- | ------- | --- | --- | --- | ----- |
| POST /v1/api-keys            | ✅      | ✅  | ✅  | ✅  |       |
| GET /v1/api-keys             | ✅      | ✅  | ✅  | ✅  |       |
| DELETE /v1/api-keys/:id      | ✅      | ✅  | ✅  | ✅  |       |
| POST /v1/api-keys/:id/rotate | ✅      | ✅  | ✅  | ✅  | V-296 |

### Webhooks (`/v1/webhooks`)

| Route                                          | OpenAPI | TS  | Py  | Go  | Notes                          |
| ---------------------------------------------- | ------- | --- | --- | --- | ------------------------------ |
| POST /v1/webhooks                              | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP** — create       |
| GET /v1/webhooks                               | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP** — list         |
| GET /v1/webhooks/:id                           | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                |
| PATCH /v1/webhooks/:id                         | ❌      | ❌  | ❌  | ❌  | **GAP** — update events/desc   |
| DELETE /v1/webhooks/:id                        | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                |
| GET /v1/webhooks/:id/deliveries                | ❌      | ✅  | ✅  | ✅  | **OpenAPI GAP**                |
| POST /v1/webhooks/:id/rotate-secret            | ✅      | ✅  | ✅  | ✅  | V-359/V-416-418                |
| POST /v1/webhooks/:id/test                     | ✅      | ❌  | ❌  | ❌  | **SDK GAP** — V-356 test ping  |
| POST /v1/webhook-deliveries/:deliveryId/replay | ✅      | ✅  | ✅  | ✅  | V-307                          |
| POST /v1/webhooks/stripe                       | 🚫      | 🚫  | 🚫  | 🚫  | Stripe-hosted webhook receiver |

### Billing (`/v1/billing`)

| Route                             | OpenAPI | TS  | Py  | Go  | Notes |
| --------------------------------- | ------- | --- | --- | --- | ----- |
| GET /v1/billing                   | ✅      | ✅  | ✅  | ✅  | V-420 |
| POST /v1/billing/checkout-session | ✅      | ✅  | ✅  | ✅  | V-420 |
| POST /v1/billing/trial-pack       | ✅      | ✅  | ✅  | ✅  | V-420 |
| POST /v1/billing/portal-session   | ✅      | ✅  | ✅  | ✅  | V-420 |

### Team (`/v1/team`)

| Route                        | OpenAPI | TS  | Py  | Go  | Notes |
| ---------------------------- | ------- | --- | --- | --- | ----- |
| POST /v1/team/invites        | ✅      | ✅  | ✅  | ✅  |       |
| GET /v1/team/invites         | ✅      | ✅  | ✅  | ✅  |       |
| POST /v1/team/invites/accept | ✅      | ✅  | ✅  | ✅  |       |
| GET /v1/team/members         | ✅      | ✅  | ✅  | ✅  |       |
| DELETE /v1/team/members/:id  | ✅      | ✅  | ✅  | ✅  |       |
| GET /v1/team/owners          | ✅      | ✅  | ✅  | ✅  |       |

### Usage (`/v1/usage`)

| Route                | OpenAPI | TS  | Py  | Go  | Notes |
| -------------------- | ------- | --- | --- | --- | ----- |
| GET /v1/usage        | ✅      | ✅  | ✅  | ✅  |       |
| GET /v1/usage/series | ✅      | ✅  | ✅  | ✅  | V-452 |

### Legal (`/v1/legal`)

| Route                   | OpenAPI | TS  | Py  | Go  | Notes                                   |
| ----------------------- | ------- | --- | --- | --- | --------------------------------------- |
| GET /v1/legal/documents | ❌      | ❌  | ❌  | ❌  | **GAP** — version + content_hash        |
| GET /v1/legal/required  | ❌      | ❌  | ❌  | ❌  | **GAP** — what customer needs to accept |
| POST /v1/legal/accept   | ❌      | ❌  | ❌  | ❌  | **GAP** — accept doc versions           |

### Status (`/v1/status`)

| Route                                 | OpenAPI  | TS  | Py  | Go  | Notes                                                      |
| ------------------------------------- | -------- | --- | --- | --- | ---------------------------------------------------------- |
| GET /v1/status                        | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public status; SDK exposure intentionally omitted (V-459). |
| GET /v1/status/incidents              | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public; SDK 🚫 by design.                                  |
| GET /v1/status/sla                    | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public; SDK 🚫 by design.                                  |
| GET /v1/status/stream                 | 🚫       | 🚫  | 🚫  | 🚫  | SSE stream — typed differently.                            |
| POST /v1/status/subscribe             | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public double-opt-in subscribe; SDK 🚫.                    |
| POST /v1/status/subscribe/confirm     | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public; SDK 🚫.                                            |
| POST /v1/status/subscribe/unsubscribe | ✅ V-459 | 🚫  | 🚫  | 🚫  | Public; SDK 🚫.                                            |

**SDK exposure decision** — `/v1/status/*` is a public, no-auth surface
consumed by the marketing-site status indicator and external uptime
monitors. Customers monitor vendor status from outside their integration
code (status pages, third-party probes); embedding it in `client.status.*`
would invite anti-patterns where customer code branches on the vendor
status response. Reclassified 🚫 (intentional non-exposure).

## Admin / staff surfaces (intentionally NOT in customer SDKs)

These routes power the admin panel; they're 🚫 for customer SDKs by design but should still be in OpenAPI for the admin-internal SDK surface.

| Route                                                   | OpenAPI | Notes           |
| ------------------------------------------------------- | ------- | --------------- |
| GET /v1/admin/overview                                  | ✅      |                 |
| GET /v1/admin/accounts                                  | ❌      | **OpenAPI GAP** |
| GET /v1/admin/accounts/:id                              | ❌      | **OpenAPI GAP** |
| POST /v1/admin/accounts/:id/audit-note                  | ❌      | **OpenAPI GAP** |
| POST /v1/admin/accounts/:id/quota-override              | ✅      |                 |
| POST /v1/admin/accounts/:id/refund-record               | ❌      | **OpenAPI GAP** |
| POST /v1/admin/accounts/:id/suspend                     | ✅      |                 |
| POST /v1/admin/accounts/:id/tier                        | ✅      |                 |
| POST /v1/admin/accounts/:id/unsuspend                   | ✅      |                 |
| GET /v1/admin/accounts/:id/usage                        | ✅      |                 |
| GET /v1/admin/api-keys                                  | ✅      |                 |
| POST /v1/admin/api-keys/:id/revoke                      | ❌      | **OpenAPI GAP** |
| GET /v1/admin/audit-log                                 | ✅      |                 |
| POST /v1/admin/incidents                                | ❌      | **OpenAPI GAP** |
| GET /v1/admin/incidents/:id                             | ❌      | **OpenAPI GAP** |
| POST /v1/admin/incidents/:id/resolve                    | ❌      | **OpenAPI GAP** |
| POST /v1/admin/incidents/:id/updates                    | ❌      | **OpenAPI GAP** |
| GET /v1/admin/rate-limit-overrides                      | ✅      |                 |
| GET /v1/admin/sessions                                  | ✅      |                 |
| POST /v1/admin/sessions/:id/destroy                     | ❌      | **OpenAPI GAP** |
| GET /v1/admin/status-subscribers                        | ❌      | **OpenAPI GAP** |
| POST /v1/admin/status-subscribers/:id/force-unsubscribe | ❌      | **OpenAPI GAP** |
| GET /v1/admin/validation-schedules                      | ✅      |                 |
| POST /v1/admin/validation-schedules/:archetype          | ✅      |                 |
| POST /v1/admin/validation-schedules/:archetype/trigger  | ✅      |                 |
| GET /v1/admin/webhook-deliveries/:id                    | ✅      |                 |
| POST /v1/admin/webhook-deliveries/:id/replay            | ✅      |                 |
| GET /v1/admin/webhook-dlq                               | ✅      |                 |
| POST /v1/admin/webhook-dlq/:id/requeue                  | ✅      |                 |

## Aggregate gap counts

| Surface category | Total routes | OpenAPI gaps                        | SDK gaps (TS / Py / Go) |
| ---------------- | ------------ | ----------------------------------- | ----------------------- |
| Auth             | 14           | 0 (V-460 closed)                    | 0 (V-460 closed)        |
| Account          | 18           | 0 (only audit-log/export partial)   | 1 (audit-log/export)    |
| Sessions         | 10           | 1 (gui-input)                       | 1 (gui-input)           |
| Profiles         | 12           | 5 (base CRUD)                       | 0                       |
| API keys         | 4            | 0                                   | 0                       |
| Webhooks         | 10           | 6 (base CRUD + deliveries + PATCH)  | 2 (PATCH + test)        |
| Billing          | 4            | 0                                   | 0                       |
| Team             | 6            | 0                                   | 0                       |
| Usage            | 2            | 0                                   | 0                       |
| Legal            | 3            | 3                                   | 3                       |
| Status (public)  | 7            | 0 (V-459 closed; 1 SSE intentional) | 6 (intentional)         |
| Admin            | 27           | 11                                  | 🚫 (admin-only)         |

**Customer-facing OpenAPI gaps after V-460:** 1 route (gui-input).
**Customer-facing SDK gaps after V-460:** 10 routes (TS / Py / Go each).
**Admin OpenAPI gaps:** 11 routes (Tier-2 follow-up).

## Per-gap closure slices (priority order)

Tier 1 (customer-facing OpenAPI parity — most impactful):

- **V-456** — register `/v1/profiles` base CRUD in OpenAPI (5 routes; SDKs already cover).
- **V-457** — register `/v1/webhooks` base CRUD + deliveries + PATCH in OpenAPI (6 routes).
- **V-458** — register `/v1/legal/*` (3 routes) + add SDK methods.
- **V-459** — register `/v1/status/*` (6 routes) in OpenAPI; SDK exposure intentionally 🚫 (status is monitoring data — out-of-band by design). ✅ shipped.
- **V-460** — register `/v1/auth/cli-authorize/*` (3 routes) + add three-SDK methods. ✅ shipped.
- **V-461** — register `/v1/sessions/:id/gui-input` + add SDK method.
- **V-462** — register `/v1/account/audit-log/export` properly + add SDK method.
- **V-463** — `/v1/webhooks/:id/test` SDK methods (V-356 send-test wrapper).
- **V-464** — `/v1/webhooks/:id` PATCH SDK method (update events / description).

Tier 2 (admin OpenAPI parity):

- **V-465** — register 11 missing /v1/admin/\* routes in OpenAPI.

Each slice ships per V-NNN convention with closure verification:
spec test paths fixture extended, three-SDK build/test green.
