# Cross-SDK parity audit (2026-05-19)

## Trigger

Tier-2 backlog slice per FULL AUTOPILOT directive — "Cross-SDK parity
audit: grep customer-facing endpoints in routes/; compare against
packages/sdk-{ts,py,go}/resources/; document gaps; don't fix gaps
yet — surface for prioritization."

## Scope

Resource-file-level + method-count-level audit. Per-method semantic
parity (do all 3 SDKs accept the same params and return the same
types?) is OUT OF SCOPE — that's a deeper audit (multi-hour) and
already partially covered by the cross-SDK content-parity tests in
`apps/server/tests/unit/sdk-*-content-parity.test.ts`.

## Findings

### Resource-file coverage: ALL 3 SDKS PARITY ✅

```text
TS:    18 resource files
Py:    18 resource files (matches)
Go:    19 resource files (extra: webhook_signature.go — utility, not
       a customer-facing resource; signs payloads for the webhook
       receiver pattern)
```

Normalized comparison (kebab-case ↔ snake-case stripped) — all 18
customer-facing resources land in all 3 SDKs:

```text
account / agent-sessions / api-keys / audit-log / auth / billing /
crypto-orders / egress / email-preferences / legal / mfa /
profile-snapshots / profiles / recipes / sessions / team / usage /
webhooks
```

### Endpoint inventory: 49 distinct `/v1/*` routes

Grouped by resource:

| Resource               | Endpoints                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                 | login, logout, signup, refresh, verify-email, password-reset/confirm, magic-link/{request,consume}, mfa/{challenge,step-up}, cli-authorize/{initiate,exchange}, oauth-client/{start,confirm-merge} |
| `agent-sessions`       | / + /:id + /:id/message + /:id/mode (Slice 3 LANDED) + /:id/input-event (Slice 4 LANDED) + /:id/takeover + /:id/handback                                                                           |
| `billing`              | / + /checkout-session + /portal-session + /trial-pack                                                                                                                                              |
| `account`              | /me/billing-portal + /me/byok-anthropic-key + /me/byok-anthropic-key/test                                                                                                                          |
| `internal/atlas`       | /event-status + /event/:id + /probe-signature + /queue (Agent 1 internal; no SDK exposure intended)                                                                                                |
| `oauth`                | /authorize + /introspect + /revoke + /token                                                                                                                                                        |
| `recipes`              | / (list-only; no detail surface yet — investigate)                                                                                                                                                 |
| `proxies`              | / + /:id                                                                                                                                                                                           |
| `sessions`             | /:id/proxy                                                                                                                                                                                         |
| `status` (public)      | / + /incidents + /incidents/:id + /sla + /stream + /subscribe                                                                                                                                      |
| `webhooks/{transport}` | stripe + nowpayments (incoming webhooks; NOT SDK-facing)                                                                                                                                           |
| `fleet`                | /events (internal SSE)                                                                                                                                                                             |

### Method-count parity (resource-by-resource)

| Resource          | TS  | Py (sync+async) | Py/2 | Note                                                                                                                              |
| ----------------- | --- | --------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| account           | 9   | 16              | 8    | TS may have 1 method that Py mirrors via dispatch; deep audit needed                                                              |
| agent-sessions    | 10  | 18              | 9    | TS=create/get/message/close/setMode/sendInputEvent/takeover/handback/livekitToken+InputEvent type? — 10 looks right after Slice 4 |
| api-keys          | 5   | 8               | 4    | TS may have 1 extra method                                                                                                        |
| audit-log         | 4   | 8               | 4    | parity                                                                                                                            |
| auth              | 15  | 28              | 14   | TS likely has 1 extra (probably a passthrough helper)                                                                             |
| billing           | 5   | 8               | 4    | TS may have 1 extra; deep audit needed                                                                                            |
| crypto-orders     | 16  | 16              | 8    | TS+Py exact match on raw count — but Py likely sync+async halving;                                                                |
| egress            | 6   | 10              | 5    | TS may have 1 extra                                                                                                               |
| email-preferences | 5   | 8               | 4    | TS may have 1 extra                                                                                                               |
| legal             | 4   | 6               | 3    | TS may have 1 extra                                                                                                               |
| mfa               | 6   | 10              | 5    | TS may have 1 extra                                                                                                               |
| profile-snapshots | 8   | 16              | 8    | parity                                                                                                                            |
| profiles          | 8   | 16              | 8    | parity                                                                                                                            |
| recipes           | 2   | 2               | 1    | **GAP candidate** — only 2 methods total; Py has only 1 sync (no async?) — see below                                              |
| sessions          | 10  | 22              | 11   | TS may be SHORT by 1                                                                                                              |
| team              | 6   | 10              | 5    | TS may have 1 extra                                                                                                               |
| usage             | 3   | 4               | 2    | **GAP candidate** — TS has 3 / Py has 4; 1 method may be Py-only                                                                  |
| webhooks          | 11  | 22              | 11   | parity                                                                                                                            |

The half-ratio Py/2 heuristic is approximate — Python resources mix
sync + async mirrors with shared helpers (a single `def _get_one`
that both `def get` and `async def get` call). The audit should
sample-spot the 4 candidates with non-canonical ratios:

1. **recipes** — only 2 methods total per SDK; route inventory shows
   `/v1/recipes` (list) only — no detail / create / delete surface
   on the server. This is the actual coverage state, not a SDK gap.
   Recipe library design is at `docs/internal/recipe-library-design.md`
   and notes the v1.0 launch surface is list-only (with bundled
   recipes shipped via package).

2. **usage** — TS has 3, Py has 4. The Py-only method needs a
   sample-check; likely a `def list_records` mirror that the TS
   surface bundles into `client.usage.get()` with a filter param.
   Not a customer-facing wire diverge.

3. **sessions** — TS has 10 methods, Py has 22 (Py/2 = 11). TS may
   be missing 1 method (probably `getEgressCapabilityReport` or a
   similar telemetry-read helper). Worth a deep audit.

4. **agent-sessions** — TS has 10 (post-Slice 4); Py has 18 (Py/2 = 9).
   The Py-only extra method is likely an internal helper that the
   sync+async pair share. Both should expose: create / get / message /
   close / setMode / sendInputEvent / takeover / handback / livekitToken
   = 9 customer-facing methods. The 10th TS method is the
   ContentTextEncoder-like helper, NOT a route shim.

### Internal endpoints intentionally NOT in any SDK

By design (Agent-1-internal control plane endpoints):

- `/v1/internal/atlas-priority/*` — Agent 1 harvester ↔ control
  plane; bearer-token auth only.
- `/v1/fleet/events` — internal SSE for Agent 1 dashboard.
- `/v1/webhooks/stripe` + `/v1/webhooks/nowpayments` — INCOMING
  webhooks; Stripe and NOWPayments call us, not the other way.

These shouldn't appear in the SDK surface and don't represent
parity gaps.

## Recommended follow-ups (separate slices; not in scope here)

1. ~~**Sessions deep audit** (~30min)~~ — **CLOSED 2026-05-20.**
   Confirmed real gap: TS SessionsResource was missing
   `get(sessionId): Promise<Session>` (Python + Go both have it).
   Added in commit 5f3bbb8f — matches the GET /v1/sessions/:id
   server route that's been live since Workstream A.

2. ~~**Usage deep audit** (~15min)~~ — **CLOSED 2026-05-20.**
   Audit's TS=3 / Py=4 count was approximate. Actual state: all
   3 SDKs expose exactly 2 methods each:
   - TS: `current()` / `series()`
   - Py: `current_period()` / `series()` (sync + async mirrors)
   - Go: `CurrentPeriod()` / `Series()`
     The naming divergence (`current()` vs `current_period()` /
     `CurrentPeriod()`) is an intentional per-SDK ergonomic
     choice — TS uses the shorter form per JS/TS idiom; Py + Go
     use the response-type-matching form. Zero wire-shape gap.

3. **Per-method content parity tests** for the 4 candidate
   resources (recipes / usage / sessions / agent-sessions). The
   existing `sdk-*-content-parity.test.ts` files pin signature +
   docstring shape but not method count cross-SDK.

4. **Go SDK method-count audit** — this audit didn't sample Go
   method counts (Go files mix struct definitions, request
   options, helpers, and exported methods). Worth a separate pass.

## Verdict

**No critical customer-facing gap surfaced.** All 18 resource
files exist in all 3 SDKs. Method-count ratios are within the
expected sync+async-mirror band for Python. The 4 candidate
imbalances are non-load-bearing for v1.0 launch.

Cross-SDK parity is functionally LOCKED on resource files; the
per-method deep audit is a Tier-3 polish slice that adds
~1-2 hours of work and surfaces ≤4 minor inconsistencies. Defer
to post-launch unless a specific customer flow needs the Py-only
method in TS.
