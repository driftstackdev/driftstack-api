# Driftstack API — current status

**Last updated:** 2026-05-11
**Most recent iteration:** 42 (V-530.E multi-touch gestures; V-530 series CLOSED)
**Mode:** Active development. Iterations 1-25 closed; iterations 26-34 landed
in one window per the iteration-26+ plan. Team review point: the internal
batch report for iterations 26-42 (covers them in full — 25 substantive
V-NNN slices, target hit).

## Iterations 26-42 — rollup

**25 substantive V-NNN slices** on `main` across 17 iterations on top of
the iteration-25 close (`92af6a9..cdfa176`) — hit the 25–40 target lower bound.
V-655 (V-NNN customer-surface scrub of 44 files) is staged on
`cleanup/v526-sanitize` per the V-528 privatization HOLD.

Phase-3 series CLOSED this window:

- **V-530** (behavioural-simulation) — A + B + C + D + E.
- **V-532** (recipe-library) — A + B + C + D.
- **V-533** (recapture-automation) — A + B + C (modulo sister-repo
  fork-side worker per V-533 contract).

V-540.B (E2E coverage) shipped 12 specs covering customer-facing
`account/*`, profile-snapshots, team, auth-cli, status-subscribe,
legal, billing-read.

Other slices: V-534.A/B (gui-client deep-link parser + consumer
refactor), V-654 (repo-label correction in the cross-repo contract
notes), V-655 (V-NNN scrub on cleanup branch), V-664 (changelog script tests), V-665 (Postmark
email-failure categorisation).

Tests: **1565/1565 green across 139 test files** at HEAD `cdfa176`
(was 1429 / 132 at the iteration-25 close; +136 across the window).

## Iteration 20 — what landed

- **V-533.A** — recapture capture-matrix runner + dedup + cross-repo
  contract. `expandCaptureMatrix` fans out (archetypes × version
  transition) into per-archetype `TriggerRecaptureOpts`. `dedupComparisons`
  - `groupComparisonsByCategory` + `summarizeComparisons` helpers.
    The contract lives in the internal design notes — the WebKit fork
    consumes queued runs from this service's `RecaptureService.listRuns`.
    17 property-style tests. Suite 1402 → 1419.
- **V-541** — cost monitoring + alerting design doc (internal
  design notes). 4-dimension cost model
  - per-tier alert thresholds + admin endpoint surface. Design-only;
    V-541.B/C/D implementation slices deferred.

## Iteration 19 — what landed

- **V-530.C** — third sub-slice of behavioural-simulation real impl:
  dwell time models (3 shapes: tight / normal / long-tailed) +
  element-region-aware click-position bias (CLICK_REGIONS table —
  image/video get 2 regions, others 1). `generateRegionAwareTouchEvent`
  builds on V-530.A by weighted-sampling a region and scaling dwell.
  18 property-style tests including region-weight ratio empirical
  verification. Suite 1384 → 1402.
- **V-540.A** — E2E coverage audit doc (internal design
  notes). 32 routes vs 12 specs
  mapped; 4 HIGH-leverage gaps (account-mfa, billing, legal,
  profile-snapshots) recommended for V-540.B implementation in the
  next iteration.

## Iteration 18 — what landed

- **V-532.A** — recipe-library navigation flow kickoff: 2 reference
  recipes (`SEARCH_FLOW_GENERIC`, `PAGINATED_LISTING_GENERIC`) + 3
  builder helpers (`navigateAndWait`, `tapAndWait`, `typeInto`) + 2
  recipe builders + 11 property-style tests. Suite 1373 → 1384.
- **Track E batch report** — an internal report for iterations
  15-18 consolidates V-524 / V-525 / V-526.A / V-527 / V-528 / V-531 / V-532.A into a
  single team-review doc with a 75-minute review-and-execute
  path.

## Iteration 17 — what landed

- **V-526.A** — sanitization sweep policy + first-file POC on branch
  `cleanup/v526-sanitize` (`0db414b`). An internal sweep-policy doc
  defines the rules + a 75-file checklist; `.env.example` has 2 V-NNN
  comment markers removed. Bulk sweep deferred to V-526.B.
- **V-528** — privatization runbook (internal design
  notes). 7-step sequence
  the team triggers tomorrow + reversibility analysis at each step + 3
  open questions surfaced for team review (publish posture, api-types
  bundling, external announcement).
- **V-531** — webrtc-streaming server-side encode pipeline + cross-repo
  contract for the WKWebView frame extraction (the WebKit fork implements
  it on the harness side per the internal contract notes). New
  `FrameSource` interface + `MockFrameSource` + `EncodePipeline` with
  pass-through codec for solo testing. 14 new property-style tests.
  Suite 1359 → 1373.

## Iteration 16 — what landed

- **V-525** — SDK extraction plan (internal design notes)
  - extraction script at `scripts/extract-sdk-repos.sh`. Script ran once
    in this iteration; 3 local branches materialized: `sdk-extract/typescript` (`6980d36`,
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

## Iteration 15 — what landed (recap)

- **V-527** — commit-msg hook installed extending the sister-repo V-205
  pattern with V-211 anonymity regex (founder / personal-name tokens).
  Canonical source at `scripts/git-hooks/commit-msg`; per-clone installer
  at `scripts/install-git-hooks.sh`. 11/11 synthetic regression cases
  pass; both historical attribution-violator commits (`63a20c1`,
  `ef649a1`) REJECT under the new hook.
- **V-524** — public-repo leak audit (internal design notes).
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

- https://driftstack.io/ — marketing site (Cloudflare Pages)
- https://www.driftstack.io/ — marketing site (Cloudflare Pages)
- https://docs.driftstack.io/ — docs site (Cloudflare Pages)
- https://app.driftstack.io/ — customer dashboard (Cloudflare Pages)
- https://api.driftstack.dev/health — Fastify control plane (Hetzner production)
- https://staging.driftstack.dev/health — staging mirror (Hetzner staging)

Tests: **1429/1429 green** across 131 test files (unit + integration +
gui-jsdom). Typecheck clean. Full `npx vitest run` empirical proof from
this iteration.

## Persistent rules holding

- **V-205 attribution.** `Driftstack <dev@driftstack.dev>` author on every
  commit; zero AI-tooling trailers; enforced by V-527 commit-msg hook
  going forward.
- **V-211 anonymity.** No personal-name strings in commits or customer-
  facing surfaces; enforced by V-527 hook for commits; V-526 sweep
  scheduled for in-tree string leaks.
- **V-455 audit** — fully closed; 1169/1169 baseline tests green at
  closure (iteration-0 baseline) → 1340/1340 at iteration 15.
- **V-278 LIVE** — `https://api.driftstack.dev/health` returns 200 at
  Cloudflare Full (strict) TLS posture.

## Awaiting external input

- **Postmark account approval** — submitted 2026-05-09 via postmarkapp.com/help.
  Until approved, signups for non-`@driftstack.dev` recipients silently
  drop at the Postmark layer (see the internal Postmark
  approval-request notes).
- **F-001** mobile UI bug — needs device + URL + screenshot to reproduce.
- **F-003** OAuth — pending Client IDs + secrets for Google Cloud Console
  - GitHub Developer Settings. Callback URL pattern
    `https://api.driftstack.dev/v1/auth/oauth/<provider>/callback`.
- **V-528 GitHub-private flip** — runbook landed in iteration 17; private-flip
  triggered manually after V-524 audit + V-525 extraction plan reviewed.
- **V-205 history scrub** — gated on V-528 privatization (force-push
  against a private repo carries zero customer-visible blast radius).

## Reference docs

- [`docs/progress/v278-final-state.md`](./docs/progress/v278-final-state.md)
  — full V-278 deployment final state + sub-processor map.
- [`docs/progress/tuesday-pickup.md`](./docs/progress/tuesday-pickup.md)
  — pickup queue (pre-iteration-15 snapshot).
- The full V-NNN history (~23,800 lines as of iteration 15) is kept in the
  internal verification records.
- The iteration-15 public-repo leak audit (V-524) and the pre-launch
  coverage audit (V-455, closed) are kept in the internal design notes.

## Iteration 18 — queued

Per the iteration plan: V-532 recipe-library kickoff (common
navigation flows per file 56: login / search / fill-form / paginate /
infinite-scroll / cart / checkout / multi-step wizard) + Track E
batch report ready for team review + 1 more P-track from
Track C or D.
