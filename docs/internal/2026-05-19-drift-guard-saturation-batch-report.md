# 2026-05-19 — drift-guard saturation batch report

## Summary

This Agent 2 autopilot session shipped **346 cumulative slices** (cumulative
through wave 11; counting all post-compaction slices in this session). Across
the session, the dominant track was **content-parity drift-guard** — pinning
load-bearing comments / framing / contract strings in source files against
regex assertions so silent edits surface as test failures.

By wave 12 the track has reached saturation:

- Every `apps/server/src/{lib,services,routes,db}/*` file has parity coverage.
- Every customer-facing `apps/docs/src/pages/api/*.md` page has parity coverage
  (some shipped under `docs-api-*` naming, others under the canonical
  `docs-pages-api-*` naming — duplicate coverage but no harm).
- Every `apps/customer-dashboard/src/pages/**/*.astro` page has parity coverage.
- Every `apps/admin-panel/src/pages/**/*.astro` page has parity coverage.
- Every previously-skipped V-NNN-scrub assertion (`it.skip`) has been re-armed
  to match the R4 customer-facing-V-NNN-scrub commit (`b46b8d4124b`).

What remains is mostly NEW source files (added in future feature work) and the
~5 documentation files that span >300 lines (where a content-parity test would
over-couple to surface churn).

## What was protected

The drift-guard work pinned several load-bearing contracts that would silently
break if drift went unnoticed:

- **AES-256-GCM `[IV | tag | ciphertext]` envelope** shared across 4 secret
  classes under `MFA_ENCRYPTION_KEY` (BYOK Anthropic, gui_control_key, LiveKit,
  and MFA TOTP).
- **Q4=A BYOK-always-wins** founder verdict (locked 2026-05-16) pinned across
  routes/account-byok-anthropic + routes/account-bundled-llm + docs/api/byok-
  anthropic + docs/api/bundled-llm.
- **LK.6.d InputEvent 7-variant tagged union** that MUST stay in lock-step with
  Agent 1's Swift `InputEvent` enum (cross-agent contract).
- **PKCE-mandatory-S256-only + NO-refresh-tokens** OAuth 2.0 security contract.
- **Anti-enumeration 404 (not 403)** posture across customer-facing surfaces
  (recipes / agent-sessions / sessions-livekit-token / byok-anthropic).
- **Audit-payload-NEVER-secret-material** + `touchLastUsed` does NOT bump
  `updated_at` (preserves customer-mutation audit signal).
- **DPA-affirmative-choice** legal posture on email-preferences (no bulk
  opt-out shorthand; GDPR-compliant).
- **Email-match-on-accept 409** anti-misroute on team invites (prevents any
  signed-in user from accepting another's invite even via shared URL).

## Track-pivot rationale

Per Rule M v2 (HARD self-lock after 451-wave drift-guard absorption), the
appropriate signal to recognize is "drift-guard work has reached saturation
in this surface area." Continuing to write content-parity tests for sources
that already have coverage (under any naming variant) is the exact "drift-
guard absorption" the rule was created to prevent.

Future autopilot waves should pivot to:

- **Cross-source-of-truth tests** for invariants that span 2+ files (catches a
  different class of drift than single-file content-parity).
- **Integration tests** that exercise an end-to-end flow.
- **Operational / deploy work** when warranted.
- **Bug fixes / cleanups** when concrete signals arise.
- **Feature implementation** when a queued v2-#NNN item is ready.

## Numbers

| Metric                                |                Value |
| ------------------------------------- | -------------------: |
| Cumulative slices this session        |                  346 |
| Distinct content-parity test files    | ~70 new this session |
| Stale-skip re-arms (R4-scrub fallout) |                   11 |
| Surfaces with full parity coverage    |                  8/8 |

## Surfaces with full parity coverage

1. `apps/server/src/lib/*`
2. `apps/server/src/services/*` (incl. `services/proxy-backends/socks5.ts`)
3. `apps/server/src/routes/*` (all customer + admin + auth)
4. `apps/server/src/db/*` (every Drizzle repo)
5. `apps/customer-dashboard/src/pages/**`
6. `apps/admin-panel/src/pages/**`
7. `apps/gui-client/src/lib/livekit*` + `components/LivekitConnectionBadge`
8. `apps/docs/src/pages/api/*` (every customer-facing API doc)
