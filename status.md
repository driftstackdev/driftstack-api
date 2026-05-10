# Driftstack API — current status

**Last updated:** 2026-05-10
**Most recent wave:** Wave 16 (V-525 / V-530.B / V-535 pass-2)
**Mode:** Autopilot active. Waves 1-15 closed; Wave 16 lands this commit;
Waves 17-26 queued per the overnight directive.

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

Tests: **1359/1359 green** across 126 test files (unit + integration +
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

## Wave 17 — queued

Per the overnight directive: V-526 sanitization sweep (apply pass on
files classified `sanitize-then-keep` in V-524, staged in
branch `cleanup/v526-sanitize`) + V-528 privatization runbook +
V-531 webrtc-streaming kickoff (server-side encode pipeline w/ mock
frame source; cross-agent contract doc at
`docs/internal/v531-cross-agent-contract.md`). Scheduled via
ScheduleWakeup.
