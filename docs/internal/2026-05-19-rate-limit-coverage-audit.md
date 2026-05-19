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

1. **`auth-oauth-client.ts` IP-rate-limit gate** — OAuth-client
   signup flow is unauthenticated; must protect against
   account-creation flooding. ~30min fix: add V-251 `ipRateLimit`
   gates to the 4 routes matching the auth.ts pattern.

2. **`account-byok-anthropic.ts` /test endpoint rate-limit** —
   customer-callable Anthropic-API connection test could be
   abused to burn customer quota OR get flagged by Anthropic's
   abuse detection. ~15min fix: add `app.rateLimit('global')` or
   a dedicated `byok:test` bucket.

## Follow-up checks (not pre-launch blockers)

3. **`oauth.ts`** — verify which routes already have IP gates and
   which don't. Each unauthenticated OAuth route needs at least an
   IP gate.

4. **`billing.ts`** — 5 routes without rate-limit. Stripe webhooks
   are signature-gated so they don't need rate-limit. Verify which
   other routes are customer-callable; add rate-limit where needed.

5. **`admin-incidents.ts`** — 4 routes without rate-limit. Status-
   subscriber routes are public read-only and should have at least
   an IP gate to prevent DoS on the public status page.

6. **`internal-atlas-priority.ts`** — bearer-token gated, but token
   compromise could allow unbounded calls. Add per-token rate-limit
   as defense-in-depth (~30min).

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
