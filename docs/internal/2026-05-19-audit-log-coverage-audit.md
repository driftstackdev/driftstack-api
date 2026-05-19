# Audit-log coverage audit (2026-05-19)

## Trigger

Tier-4 backlog slice per FULL AUTOPILOT directive: "which routes
don't emit audit-action events that should?"

## Method

1. Grep `apps/server/src/services/*.ts` for `emitAuditBestEffort`
   / `accountAudit` / `recordAction` to enumerate the services
   that DO emit.
2. Compare against `AccountAuditActionSchema.options` enum in
   `packages/api-types/src/accounts.ts` (canonical action set).
3. Spot-check route files for security-sensitive endpoints that
   modify account state but don't appear to thread through an
   audit-emitting service.

## Findings

### Services emitting audit events (10 of 56 route+service files)

| Service                              | Actions emitted                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `account-lifecycle.ts`               | `subscription.tier_changed`                                                                |
| `agent-pair-mode-heartbeat-sweep.ts` | `agent_session.pair_mode.timeout`                                                          |
| `api-keys.ts`                        | `api_key.minted` / `api_key.revoked` / `api_key.rotated` / `api_key.revoked_by_admin`      |
| `auth-flows.ts`                      | `account.email_verified` / `account.login` / `account.logout` / `account.password_changed` |
| `mfa.ts`                             | `account.mfa_enrolled` / `account.mfa_disabled` / `account.recovery_code_used`             |
| `profile-snapshots.ts`               | `profile.created` (snapshot variant)                                                       |
| `profiles.ts`                        | `profile.created` / `profile.deleted` / `profile.exported` / `profile.imported`            |
| `sessions.ts`                        | `session.created` / `session.destroyed` / `session.destroyed_by_admin`                     |
| `team-members.ts`                    | `team.member_invited` / `team.invite_accepted` / `team.member_removed`                     |
| `webhooks.ts`                        | `webhook_endpoint.created/updated/deleted/secret_rotated` / `webhook_delivery.replayed`    |

### Coverage gaps — routes that DON'T thread through an audit-emitting service

Spot-checked the security-sensitive routes; 6 known gaps:

| Route                                                                   | What it modifies                              | Audit status                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/account/me/byok-anthropic-key`                                | Persists customer's Anthropic key (encrypted) | **GAP — known + DEFERRED.** File comment at `apps/server/src/routes/account-byok-anthropic.ts:15-22` documents a follow-up slice that adds 3 enum values (`account.byok_anthropic_key_{set,cleared,tested}`). Class-A schema change. |
| `DELETE /v1/account/me/byok-anthropic-key`                              | Clears customer's stored Anthropic key        | **GAP — same as above.**                                                                                                                                                                                                             |
| `POST /v1/account/me/byok-anthropic-key/test`                           | Connection-tests the customer's key           | **GAP — same as above.**                                                                                                                                                                                                             |
| `POST/DELETE /v1/proxies/:id` (saved-proxies)                           | Creates/deletes a saved proxy                 | **GAP.** No audit emit on the service-side either; security-sensitive (proxy credentials are encrypted at rest, but proxy URL is plaintext + scope-bound).                                                                           |
| `POST /v1/billing/checkout-session`                                     | Initiates a Stripe Checkout session           | **GAP.** No audit — but Stripe's own audit log is the source of truth here. Verdict: ACCEPTABLE — Stripe is the audit boundary for billing.                                                                                          |
| `POST /v1/billing/portal-session` + `GET /v1/account/me/billing-portal` | Returns a Stripe portal URL                   | **GAP — same as above.** ACCEPTABLE.                                                                                                                                                                                                 |
| `PUT /v1/account/me/bundled-llm-settings`                               | Updates customer's bundled-LLM consent + caps | **GAP.** Customer-driven consent flag changes should be auditable for compliance. Class-A enum extension needed: `account.bundled_llm_consent_changed`.                                                                              |

### Acceptable gaps (not customer-action-driven)

- `recipes` — read-only customer surface (list bundled recipes); no
  modification ⇒ no audit needed.
- `email-preferences` — modifies a single boolean per-customer; low
  audit value. Marginal — could add `account.email_preferences_changed`
  for completeness, but not load-bearing for compliance.
- `crypto-orders` (V-666) — admin-only surface; admin actions emit
  via `admin.refund_recorded` + `admin.support_note` patterns.

## Recommendations

### Tier 1 — Required pre-launch (security/compliance)

1. **BYOK Anthropic audit emission.** 3-action enum extension +
   service-side emit. Already DEFERRED with explicit file comment;
   needs a dedicated slice. Risk: customer can't audit who set/
   cleared their key — bad story for incident response.
   Estimated effort: 2-3hr (enum migration + 3 emit sites + 3
   integration tests).

2. **Saved-proxies audit emission.** 2-action enum extension
   (`proxy.created` / `proxy.deleted`). Customer needs to audit
   which proxies have been minted under their account (especially
   for shared-team-RBAC sessions where any member can mint).
   Estimated effort: 1-2hr.

### Tier 2 — Nice-to-have for v1.0 (compliance polish)

3. **Bundled-LLM consent audit.** 1-action enum extension
   (`account.bundled_llm_consent_changed`). Per V-485 the consent
   toggle is the trigger for switching from BYOK-required to
   deployment-fallback billing — auditable should be the default
   for any consent change.
   Estimated effort: 1hr.

4. **Email-preferences audit (optional).** 1-action enum extension.
   Low value but trivial to add.

### Tier 3 — Already covered (verified)

- account lifecycle (signup/login/logout/email-verified/password-changed): ✓
- api-key lifecycle: ✓
- session lifecycle: ✓
- profile lifecycle (created/deleted/exported/imported): ✓
- webhook endpoint lifecycle: ✓
- team membership: ✓
- MFA enrollment + recovery code use: ✓
- agent-session pair-mode transitions: ✓
- admin actions (refund/support): ✓

## Out of scope

- **Slice 4 input-event** — not audit-emitted yet, but the route
  returns 503 today (pre-harness). Per Slice 4 design doc, audit
  emit is bucketed per 1s for high-frequency mousemove streams
  (raw per-request audit at 120Hz would be cost-prohibitive).
  Lands when harness end-to-end is wired.
- **agent-decompose internal events** (`agent.decompose.claude` /
  `agent.decompose.deterministic`) — these emit from
  `services/agent-runtime.ts`, not via accountAudit. Different audit
  channel (decompose-usage table) — not in scope here.

## Verdict

**Pre-launch blocker:** BYOK Anthropic audit emission (Tier 1
#1). Customer credential-management surfaces MUST be auditable;
the deferred slice should be queued before v1.0 launch.

**Pre-launch nice-to-have:** Saved-proxies + bundled-LLM consent
audit emission (Tier 1 #2 + Tier 2 #3). Adds ~3-4 hours of work
total.

**Post-launch acceptable:** Email-preferences audit + any
additional polish.
