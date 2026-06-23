# A2 Ultracode Launch-Readiness Audit — 2026-06-23

Founder enabled **ultracode** ("most exhaustive, correct answer; token cost not a constraint") + "always stay productive / no stopping". This is the in-repo continuity record (see also memory `project_ultracode_launch_readiness_audit_2026_06_23`).

## Method

**7 confirmed-only multi-agent audits.** Each: adversarial finders per surface → every candidate finding verified by **3 independent lenses** (exploitability / reachability / impact), each defaulting to _refuted_; a finding is **confirmed only if ≥2 of 3 lenses** independently judge it real. This filters plausible-but-wrong findings. Run via the Workflow tool (pipeline: find → per-finding parallel verify → synthesize → completeness critic).

## Headline

**ZERO criticals/highs across the entire A2 attack surface.** No API auth bypass, no cross-tenant data exfil, no money loss, no RCE, no SSRF-to-internal, no privilege escalation. Every confirmed issue is medium/low, and each is fixed-committed or being implemented.

## Per-surface results

| Audit                | Surfaces                                                                                                                   | Confirmed                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Server               | auth/access, billing-crypto, fleet-control, agent-sessions, webhooks-ssrf, secrets/crypto, tenant-isolation, ratelimit-dos | **M1** cross-node guard gap, **M2** node-IP leak, **L1** SSE caps (all med/low)                                                    |
| GUI/Tauri            | ipc/caps, secret-handoff, webview-xss, rust-eval                                                                           | **1**: `setup()` eval-injection (med, local-only)                                                                                  |
| SDK + dashboard      | sdk-parity, sdk-credential, dashboard-xss-auth                                                                             | **5**: MFA-seed→qrserver (med), Python retry-inversion, all-SDK non-idempotent retry, TS+Py pagination guard, retry-defaults drift |
| Gap-fill             | tenant-isolation (re-run), deep-link `driftstack://`                                                                       | **0** (clean — OAuth-CSRF + ndjsonPath concerns refuted)                                                                           |
| Packages + admin     | webhook-delivery, webrtc-streaming, behavioural-sim, admin-panel                                                           | **1**: LiveKit token mint ignores `session.nodeId` → wrong Mac in multi-box fleet (med, timely for 2nd-worker bring-up)            |
| Recipe-redact        | redact.ts bypasses, redact-is-only-path                                                                                    | **0** (clean — chokepoint holds; 10 tests; userinfo+query+OAuth-fragment+type all covered)                                         |
| Recapture-automation | scheduler/selection/dedup                                                                                                  | **0** (clean — selects correctly; fingerprint-data correctness stays A1/A3)                                                        |

## Fixes — COMMITTED (push HELD, batching to avoid extra prod restarts)

- `07b2637f` GUI eval-injection guard (`is_valid_b64_payload` before `setup()` eval) — cargo + fmt clean
- `1e6687a7` server M1/M2/L1 (M1 reviewed incl. bootstrap wiring: `makeSessionPageStateRelay` + `isCrossNodeSpoof`; M2 `scrubNodeDiagnostics`; L1 SSE backpressure + concurrency cap)
- `148981a2` pageState `stalled` contract (A3 W2845) + `a051b83e` its regression test — GUI "Reconnecting — page unresponsive" badge over the last frame
- `a9271aec` base= launch-handoff regression test (already pushed)
- `140a2b83` LiveKit token mint bound to `session.node_id` (new `getDetailByNodeIdOrId`; fixes wrong-Mac token in a multi-LiveKit-box fleet; 61 tests incl. binding scenarios)
- `5d4b7eb8` SDK+dashboard: MFA local-QR (seed no longer leaves origin, verified bit-for-bit vs qrcode@1.5.4) + SDK retry-safety gate (idempotent/keyed-only) + Python crypto inversion + pagination-guard parity + unified retry defaults
- `204d123d` re-pinned the 8 cross-SDK content-parity drift guards to the new SDK design
- `b315074c` docs: corrected the documented retry defaults (250/8000 → unified 200/10000) in README + /sdk/installation + 4 pins
- `95c709ff` pre-push hardening (from adversarial verify w83xq1aht): SSE slot-leak window (acquire slot after cleanup wired) + stalled-badge reset on session-swap/navigate
- driftstack `8f4e1aaab` — bus reply A2 W2846 (A3 unblocked on `stalled`)

## Pre-push adversarial verification (w83xq1aht)

All 7 fixes re-verified by 2 lenses each before shipping: **5 GO** (eval/M1/M2/LiveKit/SDK), **2 low follow-ups found + fixed** (the SSE slot-leak + stalled reset above). No blocker survived.

## GUI shipped

Both Tauri apps (eval guard + stalled badge) rebuilt → deep-re-signed → installed to /Applications (verified seals). Re-building once more for the stalled-reset (`95c709ff`). First launch shows a one-time keychain re-grant (cdhash changed — expected).

## REMAINING

Full-suite pre-push verify (running) → **one consolidated push** (auto-deploys server+dashboard+docs to prod+staging) → reinstall the just-rebuilt GUI. The founder's one fresh-launch verify (control/cookies/stalled) closes it.

## Verified-clean (don't re-audit without new signal)

auth/OAuth, billing/crypto money paths, tenant isolation, deep-link boundary, webhook-delivery SSRF/signing, behavioural-sim, admin-panel authz, recipe credential-redaction, recapture selection. GUI suite green (1132 tests).
