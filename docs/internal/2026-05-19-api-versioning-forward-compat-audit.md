# /v1 API versioning forward-compat audit (2026-05-19)

## Trigger

Tier-4 backlog slice per FULL AUTOPILOT directive: "API versioning
audit: ensure /v1/ surface is forward-compatible." Existing policy
canonical at `docs/architecture/api-versioning.md` (V-220) and
customer-facing at `apps/docs/src/pages/api/versioning.md`.

## Method

1. Spot-check recent commits (Wave 29-NNN ARC 3 Slice 3 + Slice 4
   - audit-coverage docs) against the additive-vs-breaking matrix.
2. Inventory closed enums that the SERVER emits to clients (where
   adding a new value is a breaking change for strict consumers).
3. Inventory closed enums that the CLIENT sends to the server
   (where adding a new accepted value is additive).
4. Flag any latent forward-compat risks.

## Recent commits (Wave 29-NNN ARC 3) — all clean

| Commit     | Change                                                   | Class           | Note                                                                |
| ---------- | -------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `c18bab90` | Added `pair_mode_state` to AgentSession response shape   | **Additive**    | New optional field; `null` when not set. Existing consumers ignore. |
| `c18bab90` | Added POST `/v1/agent-sessions/:id/mode` endpoint        | **Additive**    | New endpoint.                                                       |
| `c18bab90` | Added `setMode` SDK method                               | **Additive**    | New SDK method.                                                     |
| `36e60493` | Added POST `/v1/agent-sessions/:id/input-event` endpoint | **Additive**    | New endpoint.                                                       |
| `36e60493` | Added `InputEvent` type to `@driftstack/api-types`       | **Additive**    | New export; 7-variant discriminated union.                          |
| `36e60493` | Added `sendInputEvent` SDK methods (TS + Py + Go)        | **Additive**    | New SDK methods.                                                    |
| `36e60493` | Added `agent_sessions:input_event` rate-limit bucket     | **Operational** | Not contract — per the policy doc, rate-limit caps are operational. |

ALL recent changes are additive per the policy. No breaking
changes shipped in this autopilot wave.

## Closed-enum inventory (server → client)

These are enums where the SERVER emits a value the client must
handle. Adding a new value breaks strict-typing consumers (TS
discriminated unions, Python TypedDict, Go strict string).

| Schema                               | Current values                                                                                         | Forward-compat risk                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccountStatusSchema`                | `active / suspended / deleted`                                                                         | LOW — V-666 admin force-suspend is the only extender; no plans.                                                                                                                                |
| `AccountTier` (enum 8 values)        | `trial_pack / solo_manual / team_manual / agency_manual / api_starter / .../ enterprise`               | MEDIUM — new tiers ship periodically. Each tier-add is technically breaking; mitigated by the SDK's "treat unknown as 'unknown_tier'" pattern (not implemented today).                         |
| `ApiKeyScope`                        | `…`                                                                                                    | LOW — additive scopes are append-only.                                                                                                                                                         |
| `SubscriptionStatusSchema`           | Stripe's status set                                                                                    | LOW — Stripe's set is stable.                                                                                                                                                                  |
| `AccountAuditActionSchema`           | 40+ values (see `packages/api-types/src/accounts.ts:211+`)                                             | **HIGH** — every new audited action (e.g. the BYOK/`proxy.created`/etc. emissions in `docs/internal/2026-05-19-audit-log-coverage-audit.md`) extends the enum. **PRE-LAUNCH ATTENTION** below. |
| `AdminAuditActionSchema`             | admin-only audit actions                                                                               | LOW — admin consumers are internal Driftstack tooling.                                                                                                                                         |
| `AccountRegionSchema`                | `us / eu / apac`                                                                                       | LOW — region set is stable.                                                                                                                                                                    |
| `BillingPeriodSchema`                | `monthly / annual`                                                                                     | LOW.                                                                                                                                                                                           |
| `AgentSessionMode`                   | `manual / ai / pair`                                                                                   | MEDIUM — Slice 5+ may introduce additional modes (e.g. `observation`). Currently locked, but follow-up may break.                                                                              |
| `PairModeState.kind` (discriminator) | `ai-driving / takeover-pending / human-driving / handback-pending / takeover-queued / handback-queued` | LOW — SDKs type as open `{ kind: string; … }` so additions are non-breaking.                                                                                                                   |

## Closed-enum inventory (client → server)

Additive per policy — server can accept new values without
breaking existing clients.

- `mode` parameter on POST `/v1/agent-sessions` (Slice 3 sets it
  per session) — `'manual' | 'ai' | 'pair'`. Server-permissive.
- `mode` body on POST `/v1/agent-sessions/:id/mode` (Slice 3) —
  same enum.
- `event.type` on POST `/v1/agent-sessions/:id/input-event`
  (Slice 4) — 7-variant discriminated union. Server-permissive.
- `intent.kind` on /sessions/:id/{navigate,interact,wait,capture} —
  4-kind union (`navigate / interact / wait / capture`). Server-permissive.

## Pre-launch attention

### High-risk forward-compat gap: AccountAuditActionSchema growth

Per `docs/internal/2026-05-19-audit-log-coverage-audit.md`, the
following audit-action extensions are queued pre-launch:

- `account.byok_anthropic_key_set / _cleared / _tested` (3 values)
- `proxy.created / proxy.deleted` (2 values)
- `account.bundled_llm_consent_changed` (1 value)

Each addition is technically breaking for strict-typed audit-log
API consumers. The customer-facing audit-log endpoint is
`GET /v1/account/audit-log` — its response contains an `action`
field typed as a closed enum.

**Mitigation options:**

1. **Ship the audit-emit infrastructure before launch but DON'T
   emit the new actions** until the SDK types are updated in the
   next minor version. Lands 6 new audit emissions silently.

2. **Make the SDK types open for the action field** (treat as
   `string` with a typed UNION but allow unknown values). Slight
   ergonomics regression — IDE autocomplete loses the closed set
   — but no breakage. **Recommended.**

3. **Ship all 6 audit-action additions in a single api-types
   minor version + SDK minor version**, document in the customer-
   facing API versioning page as a "schema-additive minor bump"
   per the V-220 policy. This is the cleanest path if the SDK
   types stay strict.

### Medium-risk: AccountTier closed enum

8 tier values today. Future tier additions (e.g. `enterprise_plus`,
`hobby`) are technically breaking. Founder verdict 2026-05-17 locked
the current pricing matrix; no near-term tier additions planned.

**Mitigation:** Same SDK type-loosening as #2 above. Open for
post-launch when pricing evolves.

## Verdict

**No pre-launch v1 breaking changes in the recent autopilot wave.**

**One latent forward-compat concern surfaced:**
`AccountAuditActionSchema` will gain 6 values pre-launch (per the
audit-log coverage audit's Tier 1 + Tier 2 recommendations).
Without SDK-side mitigation, strict-typed audit-log consumers
will break on the next minor version.

Recommended path: implement Option #2 above (loosen SDK action
type to `string` with TypedDict-on-known-set + passthrough). One
SDK minor version + zero customer migration effort.

Tracked as a follow-up slice. NOT a Tier-3 founder verdict —
purely SDK ergonomics.
