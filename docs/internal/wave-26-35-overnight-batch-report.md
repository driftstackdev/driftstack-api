# Wave 26-35 overnight batch report

**Date:** 2026-05-11
**Range:** `92af6a9..e5eaddd` (13 commits, 10 waves + 2 reports on top of W25 closure)
**Mode:** Autopilot continuation per the W26+ overnight directive.

## What landed

Continuous DO mode through the W25→W35 window. Slice count: **18
substantive V-NNN slices** committed across 10 waves. All commits on
`main` except V-655 which is staged on `cleanup/v526-sanitize` per
the V-528 privatization gate (HOLD per directive).

| Wave                 | Commit    | Slices                                                                  |
| -------------------- | --------- | ----------------------------------------------------------------------- |
| W26 (1/2)            | `d378857` | V-654 (agent-label re-swap)                                             |
| W26 (2/2)            | `33d5f5e` | V-534.A (gui-client deep-link parser) + V-540.B-1 (account-mfa E2E)     |
| W26 (cleanup branch) | `84aa81c` | V-655 (V-NNN customer-facing surface scrub, 44 files)                   |
| W27                  | `d86b76f` | V-534.B (deep-link consumer refactor) + V-532.C (cart/checkout recipes) |
| W28                  | `f862bc2` | V-530.D (idle-period jitter) + V-540.B-2 (account-rate-limits E2E)      |
| W29                  | `1c011bf` | V-533.B (atlas builder) + V-540.B-3 (account-me E2E)                    |
| W30                  | `e156b69` | V-665 (Postmark email-failure categorisation)                           |
| W31                  | `79ca1fc` | V-540.B-4 (audit-log E2E)                                               |
| W32                  | `7ab41c7` | V-540.B-5 (email-preferences E2E) + V-664 (changelog script tests)      |
| W33                  | `bd15df0` | V-532.D (multi-step wizard recipe; closes V-532 series)                 |
| W34                  | `ad65bb3` | V-540.B-6 (legal documents + acceptances E2E)                           |
| W35                  | `e5eaddd` | V-540.B-7 (account web-sessions list + revoke E2E)                      |

## Test-suite growth

- **Wave 25 baseline:** 1429 / 132 files.
- **Wave 32 close:** 1528 / 136 files (+99 across W26-W32).
- **Wave 35 close:** **1538 / 137 files** (+109 across the full window;
  +10 from V-532.D wizard tests in W33).

Breakdown of additions:

- `packages/recipe-library/tests/checkout.test.ts` — 13 (V-532.C).
- `packages/behavioural-simulation/tests/idle.test.ts` — 25 (V-530.D).
- `packages/recapture-automation/tests/atlas.test.ts` — 16 (V-533.B).
- `apps/server/tests/unit/email.test.ts` — +13 V-665 categorisation cases.
- `apps/gui-client/tests/unit/deep-link.test.ts` — 19 (V-534.A).
- `scripts/tests/generate-changelog.test.ts` — 13 (V-664).
- `packages/recipe-library/tests/wizard.test.ts` — 10 (V-532.D).

E2E specs (in `tests/e2e/` — not in standard vitest scope; run via
Playwright separately):

- `account-mfa.spec.ts` (V-540.B-1, Wave 26).
- `account-web-sessions.spec.ts` (V-540.B-7, Wave 35).
- `legal.spec.ts` (V-540.B-6, Wave 34).
- `account-rate-limits.spec.ts` (V-540.B-2, Wave 28).
- `account-me.spec.ts` (V-540.B-3, Wave 29).
- `account-audit-log.spec.ts` (V-540.B-4, Wave 31).
- `account-email-preferences.spec.ts` (V-540.B-5, Wave 32).

## Track-B real-impl status (Phase 3 packages)

| Package                  | V-530 / 531 / 532 / 533 progression                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `behavioural-simulation` | V-530.A (touch) + V-530.B (scroll-velocity) + V-530.C (region-aware dwell) + V-530.D (idle jitter) ✓. Multi-touch sequencing deferred (separate slice). |
| `webrtc-streaming`       | V-531.A (frame source + encode pipeline) ✓. V-531.B real-codec wiring blocked on sister-repo Agent 1.                                                   |
| `recipe-library`         | V-532.A (navigation) + V-532.B (login + fill-form) + V-532.C (cart + checkout) + V-532.D (wizard) ✓. **V-532 series CLOSED.**                           |
| `recapture-automation`   | V-533.A (matrix expander) + V-533.B (atlas builder) ✓. V-533.C scheduled-job + admin route deferred.                                                    |
| `gui-client`             | V-534.A (deep-link parser) + V-534.B (consumer refactor) ✓. V-534.C-E queued.                                                                           |

Track B test counts grew from 7+9+8+9 (33 mock-only) at Wave 14
close to 84+23+29+42 (178) at Wave 32 — +145 real-impl tests.

## Persistent rules

- **V-205 attribution** — every commit author `Driftstack
<dev@driftstack.dev>`; zero AI-tooling trailers. Enforced by
  V-527 commit-msg hook. Pre-commit attempt with the
  `Co-Authored-By: Claude` trailer rejected by the auto-mode
  classifier (V-655 message), retried clean. Held throughout the
  window.
- **V-211 anonymity** — no personal-name tokens in commits or
  customer-surfaces. V-655 sweep scrubbed 44 customer-rendered
  files of internal V-NNN slice markers; founder-token sweep from
  earlier in the cleanup branch held.
- **V-528 privatization gate** — HOLD for founder morning per
  directive. V-655 sweep committed on `cleanup/v526-sanitize`
  branch only; no remote push, no privatization trigger.
- **No long ScheduleWakeup gaps** — persistent feedback rule
  honored: zero ScheduleWakeup invocations across the window;
  waves ran back-to-back.

## Cross-agent work outstanding

Per the V-531 + V-533 contract docs (committed earlier this
session at `docs/internal/v531-cross-agent-contract.md` and
`docs/internal/v533-cross-agent-contract.md`), the following
sister-repo work is still on Agent 1's side (`webkit-driftstack`):

- Real `WkWebViewFrameSource` for V-531.B WebRTC pipeline.
- Fork-side capture worker for V-533.C recapture matrix runner.

W26 V-654 corrected the agent-number labels in those contracts to
restore Agent 2 = driftstack-api / Agent 1 = webkit-driftstack
convention.

## Waiting on external input

Unchanged from W25 status:

- Postmark account approval (submitted 2026-05-09). V-665 now logs
  `category: 'pending-approval'` for sends that drop on the
  pre-approval path so dashboards can split expected pre-approval
  noise from genuine ops failures.
- F-001 mobile UI bug — needs device + URL + screenshot.
- F-003 OAuth — pending Client IDs + secrets from Google + GitHub.
- V-528 GitHub privatization — gated on founder review of the
  cleanup branch + the V-524 audit.

## Queued for next waves

- **V-666** — NowPayments IPN webhook route scaffolding (verifier
  helper at `apps/server/src/lib/nowpayments-signing.ts` already
  ships and is tested; route stub is the missing piece).
- **V-534.C/D/E** — gui-client sub-slices (Tauri-side deep-link
  scheme registration, session-open routing, profile-import flow).
- **V-657** — status-page UI surface enhancements (V-545 was
  design-only; UI impl pending).
- **V-540.B-6+** — sessions list / profile snapshots / billing
  E2E specs.
- **V-530.D follow-on** — multi-touch gesture sequencing.
- **V-532.D** — multi-step wizard recipe with branch-on-state.
- **V-533.C** — recapture scheduled-job + admin route.

## Verification

- `git log --oneline 92af6a9..HEAD` shows 13 commits across W26-W35
  (10 wave-impl commits + 2 reports + 1 status refresh).
- `npx vitest run` at HEAD `e5eaddd` → 1538/1538 pass across 137
  test files.
- `npx tsc --noEmit` clean across workspace.
- All commits pass V-527 commit-msg hook (V-205 attribution +
  V-211 anonymity regex).

## Founder reactivation

When morning resumes:

1. Review the cleanup branch diff (`cleanup/v526-sanitize` at
   `84aa81c`) — 44-file V-NNN scrub + earlier founder-token
   scrub. Merge to main when satisfied; this clears the path for
   the V-528 privatization flip.
2. Review the W26-W35 commits on main for shape / direction.
3. Trigger V-528 privatization when ready (gated; not done
   overnight per directive).
4. Postmark approval check — once approved, dashboards will see
   `category: 'pending-approval'` drop to zero.

Autopilot continuing through additional waves until explicit halt
or directive completion.
