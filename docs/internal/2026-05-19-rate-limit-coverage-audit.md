# Rate-limit coverage audit (2026-05-19)

## Trigger

Tier-4 backlog slice per FULL AUTOPILOT directive: "Rate-limit
audit per endpoint (ensure no missing rate-limits on customer-
facing routes)."

## Method

```bash
# Per-file: count app.{get,post,delete,patch,put} declarations
# vs rateLimit(/Gate, references. Flag delta > 3.
for f in apps/server/src/routes/*.ts; do …; done
```

Then per-suspicious-file: grep for `ipRateLimit` (V-251 IP-based
gate) + auth requirements (`requireAuth` / `requireScope` /
`requireInternalAuth`) to identify the actual gating mechanism.

## Findings

207 `app.{verb}` declarations across `apps/server/src/routes/*.ts`;
account-bucket `rateLimit()` is invoked from a subset. The deltas
broke into 3 categories:

### Category A — Has rate-limiting via DIFFERENT mechanism (false-positive deltas)

| File                      | Delta | Mechanism                                                                                                                                                                                               |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`                 | 12    | `ipRateLimit` middleware (V-251) — IP-based gates on every signup / login / verify / password-reset / magic-link / resend route.                                                                        |
| `internal-atlas-priority` | 8     | Bearer-token gated via `requireInternalAuth` preHandler. Internal Agent-1-to-control-plane channel; per-token rate-limit happens implicitly via single-token-per-fleet-host design.                     |
| `admin-crypto-orders`     | 11    | `app.requireScope('driftstack_internal_admin')` preHandler — admin-only surface. Admin tier is intrinsically low-volume; lack of per-token rate limit is acceptable but defense-in-depth would add one. |
| `oauth.ts`                | 10    | Likely IP-rate-limited via the same V-251 path; needs verification. **FOLLOW-UP CHECK.**                                                                                                                |
| `agent-sessions.ts`       | 8     | Delta = the 8 disabled-route stubs registered in `registerAgentSessionsDisabledRoutes` (they FeatureUnavailable immediately; no point rate-limiting them).                                              |

### Category B — Confirmed coverage gaps

Sample-checked files with delta > 3 that aren't explained by A:

| File                        | Delta | Status                                                                                                                                                                                                                                      |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.ts`                | 5     | 5/10 routes have explicit rate-limit; 5 don't. Stripe webhook routes legitimately skip (gated by signature). Need to verify the other 5 aren't customer-callable; **FOLLOW-UP CHECK.**                                                      |
| `auth-oauth-client.ts`      | 4     | OAuth-client signup flow (Google/GitHub callback); should use V-251 IP gate similar to auth.ts. **CONFIRMED GAP.**                                                                                                                          |
| `admin-incidents.ts`        | 4     | Mix of admin-scope + status-subscriber routes; need per-route review. **FOLLOW-UP CHECK.**                                                                                                                                                  |
| `account-byok-anthropic.ts` | 4     | 4/8 routes have rate-limit. The /test endpoint is a customer-callable Anthropic-API roundtrip — should always be rate-limited to prevent customer burning their own API quota OR triggering Anthropic's abuse detection. **CONFIRMED GAP.** |

### Category C — Full coverage (delta = 0)

13 route files have 1:1 route-to-rate-limit ratio:

- webhooks / team / sessions-livekit-token / profile-snapshots /
  mac-nodes-register / legal / + 7 others.

## Pre-launch blockers

1. ~~**`auth-oauth-client.ts` IP-rate-limit gate**~~ — **CLOSED
   2026-05-20 (commit e7571faf).** AUTH_IP_LIMITS gained
   `oauthClientStart` / `oauthClientCallback` /
   `oauthClientConfirmMerge` entries (5/min/IP each); routes
   thread `ipRateLimit` preHandlers via the new
   `rateLimitStore` dep on `RegisterOAuthClientRoutesDeps`. The
   `/v1/auth/oauth/:provider/callback` redirector intentionally
   stays ungated (302 forwarder, no state mutation).

2. ~~**`account-byok-anthropic.ts` /test endpoint rate-limit**~~ —
   **NO-OP / already covered.** The route already uses
   `app.rateLimit('global')` as its preHandler; no additional
   gate needed. The audit's "missing rate-limit" framing was a
   false-positive on the initial grep — the `global` bucket
   suffices for this endpoint per the per-tier
   `TIER_RATE_LIMIT_DEFAULTS` defaults.

## Follow-up checks (not pre-launch blockers)

3. ~~**`oauth.ts`** — verify which routes already have IP gates~~ —
   **CLOSED 2026-05-20.** Verified: 5 admin routes gated via
   `requireScope('driftstack_internal_admin')` + 1 customer route
   via `requireAuth`. ZERO unauthenticated routes — the unauth
   OAuth surface lives in `auth-oauth-client.ts` (separate file)
   where the IP gates were added in commit 86cd8682 (batch 8).
   No additional IP gating needed.

4. ~~**`billing.ts`** — 5 routes without rate-limit~~ — **NO-OP /
   verified 2026-05-20.** Re-grep shows the 5 mounted billing
   routes (checkout-session / trial-pack / portal-session / billing
   GET / account-me-billing-portal) all use
   `app.rateLimit('global')` as preHandler. The 5 unrated
   entries the audit flagged were the disabled-stubs registered
   by `registerBillingDisabledRoutes` — those throw 503
   immediately without doing any work, so rate-limit isn't
   needed there.

5. ~~**`admin-incidents.ts`** — 4 routes without rate-limit~~ —
   **CLOSED 2026-05-20.** The two PUBLIC routes (GET
   `/v1/status/incidents` + GET `/v1/status/incidents/:id`)
   gained defense-in-depth IP gates: `statusIncidentsList` +
   `statusIncidentDetail` (60/min/IP each — generous to
   CDN-coalesced normal traffic at ~2/min legit; tight enough
   to catch direct-API abuse bypassing the CDN). The admin
   write routes have always been gated via `requireScope` +
   `rateLimit('global')`. AUTH_IP_LIMITS now 12 entries.

6. ~~**`internal-atlas-priority.ts`** — bearer-token gated, but token
   compromise could allow unbounded calls~~ — **CLOSED 2026-05-20.**
   Per-token rate-limit landed in the `requireInternalAuth`
   preHandler. Bucket key is `atlas_priority_token:<sha256-prefix>`
   (token hashed 16-char-prefix; plaintext never lands in bucket
   namespace / metrics labels — V-127 api-key-hash pattern).
   Capacity 1000/min sized comfortably for legitimate harvester
   - BS worker cadence (~10-100 req/min per token) with abuse-
     burst headroom. RateLimitedError thrown on cap-hit with
     retry-after seconds in the message.

7. **`admin-crypto-orders.ts`** — admin-only, but defense-in-depth
   would add per-admin-token rate-limit. Lower priority than 1-2.

## Verdict

**Pre-launch action: 2 fixes (~45min total) — auth-oauth-client
IP gates + byok-anthropic /test rate-limit.** Both close real
abuse vectors.

Other deltas surface follow-up work but aren't pre-launch
blockers (admin-scoped or signature-gated routes are
defense-in-depth, not single-point-of-failure).

## Methodology limitations

- `rateLimit(` regex misses cases where the rate-limit is wrapped
  in a custom factory (e.g. `signupGate` in auth.ts). Manually
  verified the 5 highest-delta files.
- Doesn't catch rate-limits applied AT THE NGINX/REVERSE-PROXY
  layer (Hetzner ingress); that's a separate audit.
- Doesn't catch per-route abuse-detection rules in Cloudflare
  WAF; out of scope.
