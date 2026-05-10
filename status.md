# Driftstack API — current status

**Last updated:** 2026-05-10
**Most recent wave:** Wave 19 (V-530.C + V-540.A)
**Mode:** Autopilot active. Waves 1-18 closed; Wave 19 lands this commit;
Waves 20-26 queued per the overnight directive. Team morning review point:
`docs/internal/wave-15-18-overnight-batch-report.md` (5-minute scan covers
Waves 15-18 Track E artifacts; Wave 19 work is post-batch-report and
focuses on Track B real-impl depth + Track A coverage audit).

## Wave 19 — what landed

- **V-530.C** — third sub-slice of behavioural-simulation real impl:
  dwell time models (3 shapes: tight / normal / long-tailed) +
  element-region-aware click-position bias (CLICK_REGIONS table —
  image/video get 2 regions, others 1). `generateRegionAwareTouchEvent`
  builds on V-530.A by weighted-sampling a region and scaling dwell.
  18 property-style tests including region-weight ratio empirical
  verification. Suite 1384 → 1402.
- **V-540.A** — E2E coverage audit doc at
  `docs/internal/v540-e2e-coverage-audit.md`. 32 routes vs 12 specs
  mapped; 4 HIGH-leverage gaps (account-mfa, billing, legal,
  profile-snapshots) recommended for V-540.B implementation in the
  next wave.

## Wave 18 — what landed

- **V-532.A** — recipe-library navigation flow kickoff: 2 reference
  recipes (`SEARCH_FLOW_GENERIC`, `PAGINATED_LISTING_GENERIC`) + 3
  builder helpers (`navigateAndWait`, `tapAndWait`, `typeInto`) + 2
  recipe builders + 11 property-style tests. Suite 1373 → 1384.
- **Track E batch report** —
  `docs/internal/wave-15-18-overnight-batch-report.md` consolidates
  V-524 / V-525 / V-526.A / V-527 / V-528 / V-531 / V-532.A into a
  single team-morning-review doc with a 75-minute review-and-execute
  path.

## Wave 17 — what landed

- **V-526.A** — sanitization sweep policy + first-file POC on branch
  `cleanup/v526-sanitize` (`0db414b`). `docs/internal/v526-sanitization-sweep-policy.md`
  defines the rules + a 75-file checklist; `.env.example` has 2 V-NNN
  comment markers removed. Bulk sweep deferred to V-526.B.
- **V-528** — privatization runbook at
  `docs/internal/v528-repo-privatization-runbook.md`. 7-step sequence
  the team triggers tomorrow + reversibility analysis at each step + 3
  open questions surfaced for team review (publish posture, api-types
  bundling, external announcement).
- **V-531** — webrtc-streaming server-side encode pipeline + cross-agent
  contract for the WKWebView frame extraction (Agent 1 implements on
  harness side per `docs/internal/v531-cross-agent-contract.md`). New
  `FrameSource` interface + `MockFrameSource` + `EncodePipeline` with
  pass-through codec for solo testing. 14 new property-style tests.
  Suite 1359 → 1373.

## Wave 16 — what landed

- **V-525** — SDK extraction plan at `docs/internal/v525-sdk-extraction-plan.md`
  - extraction script at `scripts/extract-sdk-repos.sh`. Script ran once
    tonight; 3 local branches materialized: `sdk-extract/typescript` (`6980d36`,
    57 commits), `sdk-extract/python` (`2c9a9cb`, 50 commits), `sdk-extract/go`
    (`fdfb9cf`, 50 commits). No remote push; no GitHub repo creation. Gated
    on Track E manual trigger.
- **V-530.B** — second sub-slice of behavioural-simulation real impl:
  scroll velocity profiles with exponential decay (`v(t) = v0 * exp(-decay*t)`),
  per-element-class flick/friction defaults, analytic per-tick deltas,
  seeded determinism. 19 property-style tests. Suite 1340 → 1359.
- **V-535 pass-2** — README polish: "Pre-launch / Phase 2" framing replaced
  with neutral "Active development"; apps + packages clusters in the repo
  layout filled in to match disk reality (7 apps + 9 packages listed).

## Wave 15 — what landed (recap)

- **V-527** — commit-msg hook installed extending the sister-repo V-205
  pattern with V-211 anonymity regex (founder / personal-name tokens).
  Canonical source at `scripts/git-hooks/commit-msg`; per-clone installer
  at `scripts/install-git-hooks.sh`. 11/11 synthetic regression cases
  pass; both historical attribution-violator commits (`63a20c1`,
  `ef649a1`) REJECT under the new hook.
- **V-524** — public-repo leak audit at `docs/internal/v524-public-leak-audit.md`.
  911 tracked files classified into 5 buckets. Staging only — no acts
  performed. Feeds V-525 / V-526 / V-528.
- **V-530.A** — first sub-slice of behavioural-simulation real implementation:
  per-element-class touch event distributions (7 classes) + seeded
  PRNG + 15 property-style tests across all classes.
- **V-535** — README sanitization first pass: internal-log references
  (V-NNN, D-NNN) removed, stale SDK status corrected, contributing
  section rewritten in standard pull-request language.

## What's live right now

All 6 customer-facing URLs HTTP 200 with TLS 1.3 end-to-end (Cloudflare
Full strict mode):

- https://driftstack.dev/ — marketing site (Cloudflare Pages)
- https://www.driftstack.dev/ — marketing site (Cloudflare Pages)
- https://docs.driftstack.dev/ — docs site (Cloudflare Pages)
- https://app.driftstack.dev/ — customer dashboard (Cloudflare Pages)
- https://api.driftstack.dev/health — Fastify control plane (Hetzner production)
- https://staging.driftstack.dev/health — staging mirror (Hetzner staging)

Tests: **1402/1402 green** across 129 test files (unit + integration +
gui-jsdom). Typecheck clean. Full `npx vitest run` empirical proof from
this wave.

## Persistent rules holding

- **V-205 attribution.** `Driftstack <dev@driftstack.dev>` author on every
  commit; zero AI-tooling trailers; enforced by V-527 commit-msg hook
  going forward.
- **V-211 anonymity.** No personal-name strings in commits or customer-
  facing surfaces; enforced by V-527 hook for commits; V-526 sweep
  scheduled for in-tree string leaks.
- **V-455 audit** — fully closed; 1169/1169 baseline tests green at
  closure (Wave 0 baseline) → 1340/1340 at Wave 15.
- **V-278 LIVE** — `https://api.driftstack.dev/health` returns 200 at
  Cloudflare Full (strict) TLS posture.

## Awaiting external input

- **Postmark account approval** — submitted 2026-05-09 via postmarkapp.com/help.
  Until approved, signups for non-`@driftstack.dev` recipients silently
  drop at the Postmark layer (see
  [`docs/internal/postmark-approval-request.md`](./docs/internal/postmark-approval-request.md)).
- **F-001** mobile UI bug — needs device + URL + screenshot to reproduce.
- **F-003** OAuth — pending Client IDs + secrets for Google Cloud Console
  - GitHub Developer Settings. Callback URL pattern
    `https://api.driftstack.dev/v1/auth/oauth/<provider>/callback`.
- **V-528 GitHub-private flip** — runbook lands W17; private-flip
  triggered manually after V-524 audit + V-525 extraction plan reviewed.
- **V-205 history scrub** — gated on V-528 privatization (force-push
  against a private repo carries zero customer-visible blast radius).

## Reference docs

- [`docs/progress/v278-final-state.md`](./docs/progress/v278-final-state.md)
  — full V-278 deployment final state + sub-processor map.
- [`docs/progress/tuesday-pickup.md`](./docs/progress/tuesday-pickup.md)
  — queue for next session (pre-Wave-15 snapshot).
- [`docs/verification-log.md`](./docs/verification-log.md) — full V-NNN
  history (~23,800 lines as of Wave 15).
- [`docs/internal/v524-public-leak-audit.md`](./docs/internal/v524-public-leak-audit.md)
  — Wave 15 public-repo leak audit.
- [`docs/internal/v455-coverage-audit.md`](./docs/internal/v455-coverage-audit.md)
  — pre-launch coverage audit (closed).

## Wave 18 — queued

Per the overnight directive: V-532 recipe-library kickoff (common
navigation flows per file 56: login / search / fill-form / paginate /
infinite-scroll / cart / checkout / multi-step wizard) + Track E
batch report ready for team morning review + 1 more P-track from
Track C or D.
