# Wave 15-18 overnight batch report — Track E + Track B + Track C

**Date:** 2026-05-10 → 2026-05-11 overnight window
**Branches touched:** `main` (Waves 15-18) + `cleanup/v526-sanitize` (V-526.A)
**Test count progression:** 1325 → 1340 (W15) → 1359 (W16) → 1373 (W17) → 1384 (W18)
**Status:** All artifacts STAGED. No GitHub remote operations performed. No
force-push. No private-flip. No SDK publish. The Driftstack team triggers
those manually after reviewing this report.

## Quick read — what the team needs to review

1. **V-524** — public-repo leak audit. 911 files classified. → `docs/internal/v524-public-leak-audit.md`
2. **V-525** — SDK extraction plan + 3 local branches (TS / Py / Go) materialized via `git subtree split`. → `docs/internal/v525-sdk-extraction-plan.md`
3. **V-526.A** — sanitization sweep policy + first file on branch `cleanup/v526-sanitize` (`0db414b`). → `docs/internal/v526-sanitization-sweep-policy.md`
4. **V-527** — commit-msg hook installed; rejects all 11 synthetic V-205 / V-211 violators + both historical violators (`63a20c1`, `ef649a1`). → `scripts/git-hooks/commit-msg`
5. **V-528** — privatization runbook + 3 open questions for team review. → `docs/internal/v528-repo-privatization-runbook.md`
6. **V-531** — webrtc-streaming server-side encode pipeline + cross-agent contract for Agent 1 to pick up. → `docs/internal/v531-cross-agent-contract.md`

## Tier-3 verdicts accepted (locked)

1. **V-488 OAuth UX → invite-only client registration** for v1.
2. **V-493 sub-processors** → MacStadium + LiveKit marked `(planned, not yet engaged)`.
3. **V-205 history scrub** → deferred to post-Track-E privatization (runs in
   Step 5 of V-528 runbook, after private flip in Step 4).

## Track E progression — privatization sequencing

```
Wave 15 ──→ V-524 (audit)
            V-527 (hook)
Wave 16 ──→ V-525 (extraction plan + script + 3 branches materialized)
Wave 17 ──→ V-526.A (sanitization policy + first file on branch)
            V-528 (privatization runbook)
Wave 18 ──→ (this report — Track E batch consolidation for team review)
```

After team review tomorrow, the runbook in V-528 takes over:

```
[STEP 1] copy LICENSE to each extract branch
[STEP 2] apply per-SDK adjustments (V-525 plan)
[STEP 3] create 3 GitHub repos + push branches      ──┐
[STEP 4] flip driftstack-api private                  │── irreversible
[STEP 5] V-205 force-push scrub (now safe)            │   from here
[STEP 6] redirect external links                      │
[STEP 7] enable SDK CI + tag first releases         ──┘
```

## Track B progression — real implementation slices

V-530 (behavioural-simulation) + V-531 (webrtc-streaming) + V-532
(recipe-library) all moved beyond stub-mock state into real-implementation

- property-test coverage:

```
V-530.A (W15) — per-element-class touch event distributions (7 classes,
                seeded mulberry32 PRNG, 15 property tests).
V-530.B (W16) — scroll velocity profiles with exponential decay
                (per-class flick/friction defaults, analytic per-tick
                deltas, 19 property tests).
V-531.A (W17) — webrtc-streaming FrameSource interface + MockFrameSource
                + EncodePipeline (pass-through "raw" codec for solo
                testing; real codec wiring deferred to V-531.B);
                cross-agent contract published for Agent 1.
V-532.A (W18) — recipe-library navigation flows (search + paginated
                listing recipes + builder helpers).
```

Sub-slices remaining (surfaced in commit bodies per the anti-substitution
clause; not silently re-scoped):

- V-530.C (W19+) — dwell time models + click-position distributions.
- V-530.D (later) — idle-period jitter + multi-touch gesture sequencing.
- V-531.B (Agent 1 + Agent 2 integration wave) — real codec (libvpx /
  openh264) wired behind EncodePipeline; production IpcFrameSource
  consumer side once Agent 1 ships the WkWebViewFrameSource producer side.
- V-532.B/C/D — fill-form / paginate refinements; infinite-scroll +
  cart + checkout; multi-step wizard.

## Track C progression — README sanitization

```
V-535 pass-1 (W15) — V-NNN/D-NNN refs removed; stale SDK status corrected;
                     contributing section rewritten in standard
                     pull-request language.
V-535 pass-2 (W16) — engineering-audience framing tightened; apps +
                     packages listing filled in to match disk reality.
```

V-211 + V-205 regex sweep on README after pass-2: zero hits.

## Cross-agent V-NNN handshakes outstanding

| V-NNN | This repo (Agent 2) | Sister repo (Agent 1)                                           |
| ----- | ------------------- | --------------------------------------------------------------- |
| V-531 | ✓ Wave 17           | ⏳ Agent 1 implements WkWebViewFrameSource against the contract |

V-527 hook backport to driftstack + webkit-driftstack (extending V-205-only
regex with V-211 anonymity regex) was flagged as a follow-up for Agent 1
in the V-527 V-log entry. Not blocking; the sister-repo hooks still catch
V-205 violations under their existing regex.

## Open questions surfaced (V-528 runbook lists these for team review)

1. **Publish-tag posture for SDK releases.** Manual tag on each new repo
   vs automated publish on merge to `main`? Manual is the conservative
   choice for the first few releases; auto-publish reduces friction once
   the SDK churn slows.
2. **`@driftstack/api-types` posture.** Bundle into `@driftstack/sdk` for
   single-package install (V-525 plan recommends this) OR publish
   api-types as its own npm package first and reference it as a
   dependency? Bundling is simpler; separate publish is more
   API-first-y.
3. **External announcement.** Blog post / status-site banner about the
   privatization + new SDK repos? OR silent flip on the assumption that
   API-using customers don't notice repo-shape changes? Silent is safest;
   the new SDK repos auto-resolve via npm/PyPI/Go module names anyway.

## Anti-actions held throughout Waves 15-18

- ❌ No GitHub-private flip executed (Step 4 of V-528 — manual trigger
  required).
- ❌ No force-push of V-205 historical scrub (gated on private flip).
- ❌ No GitHub remote repo creation for the new SDK repos.
- ❌ No npm / PyPI / Go publish.
- ❌ No silent re-scope of any V-NNN slice — sub-slice splits
  (V-NNN.A/B/C) surfaced in commit bodies + V-log entries every time.
- ❌ No work on driftstack or webkit-driftstack repos (Rule G — Agent 1
  scope).

## Verification chain

- `git log --oneline` shows Waves 14 → 15 (`5cf296c`) → 16 (`0f7c81e`)
  → 17 (`476380a`) → 18 (this commit) on `main`.
- `git branch --list` shows the 3 SDK extraction branches +
  `cleanup/v526-sanitize` all present.
- `npx vitest run` returns 1384/1384 pass at this commit.
- `.git/hooks/commit-msg` accepts every wave commit message; rejects all
  11 synthetic V-205 / V-211 violators + both historical violators.

## What the team can do tomorrow

1. **5 min:** scan this batch report.
2. **15 min:** review V-524 + V-525 + V-528 in detail.
3. **15 min:** review `cleanup/v526-sanitize` branch diff.
4. **10 min:** answer the 3 open questions above (publish posture +
   api-types bundling + announcement).
5. **30 min:** if all OK, follow V-528 runbook Step 1 → Step 7.

Total: ~75 min of careful review + execution for the public-repo posture
flip + 3 new SDK repos materialised. Reversible until Step 4.

## Continuation queue (Waves 19+)

Per the overnight directive's plan, when autopilot resumes after team
reactivation:

- **Wave 19:** V-530.C (dwell + click-position) + V-536 onboarding-flow
  polish + V-540 E2E coverage expand.
- **Wave 20:** V-531.B (real codec + integration with Agent 1) + V-533
  recapture-automation kickoff + V-541 cost monitoring + alerting.
- **Wave 21:** V-532.B+ (login + search + fill-form recipes) + V-534
  gui-client deepen + V-542 backup verification.
- **Wave 22:** V-530-534 batch verification + V-543 customer success doc
  - V-544 changelog automation.

Track A continuation (V-509 / V-512 / V-515 / V-518 follow-up depth) +
Track C/D depth slices queued for Waves 23-26.
