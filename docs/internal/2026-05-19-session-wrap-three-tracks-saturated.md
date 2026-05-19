# 2026-05-19 — session wrap: three drift-guard tracks saturated

## Summary

This Agent 2 autopilot session began with content-parity drift-guard
work and over **23 waves / 398 slices** progressively saturated three
distinct drift-guard track types:

| Track                                                       | Waves | Slice range | Saturation marker                                                           |
| ----------------------------------------------------------- | ----: | ----------: | --------------------------------------------------------------------------- |
| Content-parity (file X has line Y)                          |  1-11 |       1-346 | [Wave 12 / slice 347](./2026-05-19-drift-guard-saturation-batch-report.md)  |
| Cross-source-of-truth (file X line Y MATCHES file Z line W) | 13-17 |     348-372 | [Wave 18 / slice 373](./2026-05-19-cross-source-saturation-batch-report.md) |
| Integration-test (Fastify pipeline edge cases)              | 19-23 |     374-398 | This report                                                                 |

Each track saturated when continuing to ship more of the same began
producing marginal-value duplicates rather than genuine new
drift-guards. The Rule M v2 5-wave cap surfaced each saturation
boundary cleanly.

## What the integration-test track protected (waves 19-23)

The 25 integration tests on this track pinned **Fastify pipeline
behavior** that the unit-level content-parity + cross-source tracks
can't catch. Each exercises real route registration + middleware +
response generation.

| Slice range | Surface                            | Pins                                                                                                                                                                        |
| ----------: | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     374-378 | Activation-gate negative cases     | LK.2 + LK.3 + V-820 + AI-B4 recipes + AI-CHAT BYOK return 503/404 when AppDeps unwired                                                                                      |
|     379-383 | Security/operational invariants    | problem+json content-type + cross-account 404 anti-enumeration + bearer-token format + health probes + /metrics 401-on-missing-Bearer                                       |
|     384-388 | Routing + security edges           | Error-shape edges (invalid JSON, method-not-allowed) + URL canonicalization (path-traversal, %-encoding) + X-Powered-By absence + RFC 7807 instance field                   |
|     389-393 | Customer-surface response shapes   | /v1/api-keys list-NEVER-echoes-plaintext + session lifecycle + /openapi.json public+valid OpenAPI 3.x + /v1/account/me NEVER-leaks-key-hash + /version NEVER-leaks-env-vars |
|     394-398 | Request-parsing + auth-state edges | Authorization header parsing + Content-Type handling + suspended/revoked/expired states + POST body edges + X-Driftstack-Account fail-closed                                |

## Load-bearing pins across the full session

The full-session pin inventory protects these contracts against silent
drift:

### Security contracts

- **PKCE S256-only** across server + client + docs (no `plain` method)
- **OAuth cookie ↔ state 5-min TTL coupling** (asymmetric expiry =
  replay vector)
- **timingSafeEqual constant-time compare** across 5 signature/token
  verifiers
- **HS256 LiveKit JWT** algorithm across lib + route + docs
- **AES-256-GCM `[IV | tag | ciphertext]` envelope** shared across 4
  secret classes under MFA_ENCRYPTION_KEY
- **24h LiveKit TTL = 24h gui_control_key TTL** (Q2=C verdict locked)
- **Webhook signature headers** `x-driftstack-signature` +
  `x-driftstack-signature-prev` (rotation grace) — lowercase
  consistency across emitter + every SDK example
- **Secret-redaction list** mirrors across Sentry + Pino observability

### Anti-enumeration / fail-closed contracts

- **Cross-account 404 (NOT 403)** across customer-facing routes
- **X-Driftstack-Account fail-closed** on non-member access
- **Bearer auth rejects revoked + expired keys with 401**
- **/metrics scrape 401-on-missing-Bearer** (internal counters stay
  private)
- **/v1/api-keys list NEVER echoes plaintext** (plaintext-once
  contract)
- **/v1/account/me NEVER leaks key hash or TOTP secret**
- **/version NEVER leaks env vars**

### Activation-gate contracts

- **7-feature disabled-stub registrar roster** (billing +
  session-proxy + saved-proxies + agent-sessions + fleet-events +
  byok-anthropic + recipes) — every gated feature ships a
  FeatureUnavailableError stub
- **Customer-docs URL in disabled-stub details** (slice 87+88 /
  6efc0a34 fix-shape regression-prevention; no internal V-NNN +
  planning-file + handoff jargon in the SDK 503 body)

### Customer-trust contracts

- **Q4=A BYOK-always-wins over bundled-LLM** (founder verdict locked
  2026-05-16)
- **Bundled-LLM Anthropic-no-training privacy commitment**
- **DPA-affirmative-choice email-preferences** (no bulk opt-out;
  GDPR-compliant)
- **Email-match-on-accept 409** on team invites (anti-misroute)
- **Sub-processor list (DPA ↔ sub-processors.md)** consistency
- **Locked archetype slug stability** (pinned profiles don't shift)
- **Trial-pack 14-day window** across 5 surfaces
- **BYOK 60-day reminder + 90-day staleness** across service + docs

### Operational contracts

- **Webhook 24h rotation grace** + 5-retry max-attempts
- **Webhook 1min/5min/15min/30min/60min backoff schedule**
- **Audit-log 10k-row export ceiling**
- **MS_PER_DAY shared** as `24 * 60 * 60 * 1000` constant
- **rotation-reminder constants**: `REMINDER_THRESHOLD_DAYS=60`,
  `COOLDOWN_DAYS=7`, `ROTATION_TARGET_DAYS=90` across BYOK and
  webhook reminder services
- **`__brand: '-plaintext'` suffix convention** across BYOK and
  gui_control_key encryption modules

## Track-pivot rationale

After three saturated tracks, future autopilot waves face a real
decision:

1. **More drift-guard work** — but the high-value gaps are pinned;
   continuing would produce duplicate-naming coverage of files
   already protected. Memory:
   [drift-guard-saturation-signal](~/.claude/memory/feedback_drift_guard_saturation_signal.md).
2. **Real feature implementation** — blocked on founder action
   (Stripe LIVE cutover 2026-05-21, BV KvK closure, queued v2-#NNN
   items waiting on verdicts).
3. **Operational / deploy / runbook work** — no concrete signals
   in the autopilot queue right now.
4. **End the autonomous loop** — explicitly signal to the founder
   that the loop has reached a productive end-of-line.

The session's last reasonable autonomous output is **this report**.

## Verification (added waves 27-28)

All 25 integration test files shipped in waves 19-23 verified
passing on wave 27:

```
Test Files  25 passed (25)
     Tests  102 passed (102)
  Duration  17.79s
```

All 25 cross-source-of-truth invariant files shipped in waves
13-17 verified passing on wave 28:

```
Test Files  25 passed (25)
     Tests  134 passed (134)
  Duration  2.62s
```

A 34-file sample of the content-parity drift-guard track shipped
in waves 7-11 verified passing on wave 29:

```
Test Files   34 passed (34)
     Tests  273 passed (273)
  Duration  2.57s
```

The 5 files that received stale-skip re-arms during waves 3, 6,
and 8 (slices 303-307 + 318-322 + 328) verified passing on wave 30:

```
Test Files   5 passed (5)
     Tests  47 passed (47)
  Duration  1.19s
```

Re-armed assertions: legal/sub-processors changelog + api-
changelog 4-V-anchor entries + docs/reference (errors + rate-
limits + scopes) + docs/sdk (TS + Python + Go quickstart +
versioning) + webhooks/endpoints + webhooks/events + browserless
V-312 profile-persistence.

Combined: **556 tests across 89 files** verified green end-to-end
across all three drift-guard tracks + the stale-skip re-arm set
(~280 content-parity slices shipped, 34 sampled here as a
representative cross-section + the 11 R4-scrub re-arms). All new
test files type-check clean under `tsc --noEmit -p apps/server/
tsconfig.test.json` (verified wave 25; only pre-existing older
tests in `tests/unit/` have type errors — none introduced by this
session). Lint-staged hooks ran on every commit; no lint failures
landed in the committed history.

## Numbers (cumulative through wave 23)

| Metric                                 |              Value |
| -------------------------------------- | -----------------: |
| Cumulative slices this session         |                398 |
| Content-parity drift-guard slices      |               ~280 |
| Cross-source-of-truth invariant slices |                 25 |
| Integration-test slices                |                 25 |
| Stale-skip re-arms (R4-scrub fallout)  |                 11 |
| Session-wrap batch reports             | 3 (incl. this one) |
| Saturated tracks                       |   3 of 3 attempted |

## Recommended next-session direction

When the founder returns:

1. **Check the Stripe LIVE cutover (2026-05-21)** — Q.2 safety guard
   should disengage automatically per memory
   [stripe-live-post-bv-kvk](~/.claude/memory/project_stripe_live_post_bv_kvk.md).
2. **Review v2-#NNN queue** for items ready to ship (founder verdict
   locked, no remaining blockers).
3. **Consider whether the Agent 1 fork-side work** is far enough along
   to enable the multi-archetype dashboard selector + SDK union per
   memory
   [multi-archetype-coordination-queued](~/.claude/memory/project_multi_archetype_coordination_queued.md).
4. **Spot-check the production deploy** if any concerning signals
   surfaced (Sentry, Postmark, LiveKit dashboards).
