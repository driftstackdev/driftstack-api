# 2026-05-19 — cross-source invariant saturation batch report

## Summary

Continuation of the 2026-05-19 Agent 2 autopilot session. After
[the wave-12 drift-guard saturation
marker](./2026-05-19-drift-guard-saturation-batch-report.md), the
session pivoted to **cross-source-of-truth invariant tests** —
assertions that the same fact lives consistently across 2+ files.

By wave 17 (slices 348–372) the cross-source track has produced **25
new invariant tests** covering load-bearing contracts that span
multiple files. Per Rule M v2 5-wave cap, the cross-source track is
now self-locked and the next autopilot wave MUST pivot to a different
track.

## What was protected on the cross-source track

| Slice range | Invariant                                                                                                                                                                                           | Files spanned |
| ----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: |
|     348-352 | rotation-reminder constants + BYOK 60/90 staleness + LiveKit 24h TTL + magic-link 15-min TTL + OAuth 5-min cookie↔state coupling                                                                    |      2-4 each |
|     353-357 | docs/api/usage tier-table ↔ TIER*CONCURRENT_SESSION_LIMITS + MFA_ENCRYPTION_KEY 4-class shared + ses*/agt\_ id-prefix anti-cross + PKCE S256-only + activation-gate disabled-stub customer-docs-URL |      2-5 each |
|     358-362 | activation-gate 7-feature roster + plaintext brand-type suffix + LiveKit HS256 algorithm + rotation-reminder EmailService methods + webhook signature header names                                  |      2-5 each |
|     363-367 | problem+json content-type + Sentry/Pino shared secret-redaction + audit-log 10k-row export ceiling + timing-safe-equal pattern + audit-log filter passthrough                                       |      2-5 each |
|     368-372 | sub-processor list (DPA + sub-processors.md) + webhook 24h rotation grace + webhook 5-retry max-attempts + locked archetype slug + trial-pack 14-day window                                         |      3-5 each |

## High-value pins recorded

These pins catch drift classes that single-file content-parity can't:

- **OAuth cookie ↔ state TTL coupling**: asymmetric expiry on the two
  surfaces would either let a PKCE verifier outlive its signing state
  (replay vector) OR break legitimate flows mid-handshake.
- **MFA_ENCRYPTION_KEY 4-class shared**: drift on one class (e.g.
  refactor to a separate LIVEKIT_ENCRYPTION_KEY) would break the
  "rotate one env var → rotate all four ciphertexts" runbook.
- **ses*/agt* prefix anti-cross**: drift would let a session-id cross
  into the agent-session-token-mint flow (or vice versa) and 404
  every legitimate request.
- **PKCE S256-only**: drift to allowing `plain` anywhere in the stack
  weakens the entire PKCE security model.
- **Activation-gate disabled-stub customer-docs-URL invariant**:
  regression-prevention for the slice 87+88 / 6efc0a34 fix-shape —
  drift toward internal-jargon-in-SDK-body would orphan operators
  from working recovery paths.
- **Secret-redaction list**: drift on Sentry vs Pino would let a
  secret slip into one observability surface while the other keeps
  scrubbing it.
- **Sub-processor list (DPA ↔ sub-processors.md)**: GDPR-compliance
  contract — Customers must be able to verify the complete list from
  either canonical source.
- **Locked archetype slug**: customer-facing-pin-stability contract —
  drift would have customers' pinned profiles silently shift
  fingerprint, surprising downstream behavioural-detection systems.

## Track-pivot rationale

Per Rule M v2 (HARD self-lock after 5 consecutive same-track waves),
the session has now exhausted **two** drift-guard track types:

1. Content-parity (file X has line Y) — saturated at wave 11 / slice 347.
2. Cross-source-of-truth (file X line Y MATCHES file Z line W) —
   saturated at wave 17 / slice 372.

What remains on these tracks is mostly: (a) new source files added in
future feature work (normal new-file coverage), or (b) marginal-value
invariants where the third+ file is barely related to the first two.

Future autopilot waves should pivot to:

- **Integration tests** for end-to-end flows that the unit-level
  drift-guards don't cover (the 103 existing integration tests have
  gaps, e.g. `mac-nodes-register` LK.2 + `agent-sessions-livekit-
token` LK.3 have no integration coverage).
- **Real feature implementation** when a queued v2-#NNN item is
  ready.
- **Operational / deploy / runbook work** when concrete signals arise.
- **End the autonomous loop** if no alternative track has high-value
  work — surface to the founder for next-session direction.

## Numbers (cumulative session through wave 17)

| Metric                                 | Value |
| -------------------------------------- | ----: |
| Cumulative slices this session         |   372 |
| Content-parity drift-guard slices      |  ~280 |
| Cross-source-of-truth invariant slices |    25 |
| Stale-skip re-arms (R4-scrub fallout)  |    11 |
| Batch reports                          |     2 |
| Waves on each saturated track          | 5 + 5 |
