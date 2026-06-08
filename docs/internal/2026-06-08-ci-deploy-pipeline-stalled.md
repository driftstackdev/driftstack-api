# ⚠️ CI / Deploy pipeline stalled since 2026-06-08 ~18:08Z — FOUNDER ACTION

**Status: SURFACED, not fixed (root cause is GitHub-account scope — billing/minutes).**

## Symptom

GitHub Actions stopped triggering after commit `d4e17781` (the openapi
drift-guard, ~18:08Z). The **6 commits pushed since** triggered **zero**
CI / Deploy / GUI-build runs:

| commit     | what                                   | CI?     | Deploy? |
| ---------- | -------------------------------------- | ------- | ------- |
| `ec091bc9` | search server (route+driver+api-types) | ❌ none | ❌ none |
| `1c06197e` | search 3 SDKs + openapi                | ❌      | ❌      |
| `1688fb00` | search docs                            | ❌      | ❌      |
| `b6af43ae` | login server                           | ❌      | ❌      |
| `2d1b6eec` | login 3 SDKs + openapi                 | ❌      | ❌      |
| `2a2e15c9` | login docs                             | ❌      | ❌      |

`gh run list` newest run = `d4e17781` @ 18:08:20Z. `gh run list --commit <sha>`
for each of the above = empty. Confirmed it's not a transient gap (6 commits,
spanning the session).

## What it is NOT

- Actions is **enabled** (`gh api repos/.../actions/permissions` →
  `{"enabled":true,"allowed_actions":"all"}`).
- **No `.github/workflows/` file changed** in `d4e17781..2a2e15c9` (so it's not
  a broken-trigger / bad-YAML regression I introduced).
- Pushes **did** reach `origin/main` (HEAD = `2a2e15c9`); only the Actions
  trigger is missing.

## Leading cause (founder to confirm)

**GitHub Actions minutes / spending-limit exhausted.** Today's volume was
heavy — every push fired CI (6–17 min each) + Deploy + GUI cross-platform build

- doc-site deploy. When included minutes / the spending cap are hit, GitHub
  accepts the push but silently does not start workflow runs (matches exactly
  what we see: enabled, no YAML change, no runs). Alternatives: a GitHub Actions
  incident (check githubstatus.com), or org-level Actions throttling.

**Founder action:** check the org's Actions **billing / spending limit** (raise
it or wait for the monthly minutes reset), or confirm a GitHub incident. Once
restored, a no-op push (or re-run) will deploy `origin/main` (`2a2e15c9`) and
re-verify CI.

## Impact (LOW, but real)

- **Prod is stuck at `d4e17781` (W247).** `/version` git_sha = `d4e1778`,
  `driver:"mock"`. The `extract` op IS live (deployed at `c1cf4374`); **`search`
  and `login` routes are NOT deployed** — `POST /v1/sessions/:id/{search,login}`
  would 404 in prod until a deploy runs. Low impact: prod is `driver:mock` +
  pre-launch (no customers exercising these; the real path is the unwired
  fleet/harness driver).
- **CI is not re-verifying pushes.** W248–W253 were verified by the **local
  pre-push gate** (the same eslint/ruff/tsc/vitest suite CI runs) — so the code
  is verified, just not independently by GitHub. Treat the local gate as
  authoritative until Actions is restored.

## Why I did NOT route around it

A manual SSH deploy to prod (Tier-1 authorized) could unstick prod, but: (a) the
undeployed routes are mock-backed + pre-launch (≈zero functional gain now), and
(b) the root cause is account-wide (billing) and affects ALL future CI+deploys,
which a one-off manual deploy doesn't fix. Surfacing for the founder to restore
the pipeline is the correct call over a route-around while away. If the founder
wants prod current before the pipeline is fixed, `bash scripts/deploy-bridge.sh`
(or the deploy runbook) does an SSH deploy of `origin/main`.

## For the autopilot (next waves)

- Keep relying on the **local pre-push gate** as the verification of record.
- Don't manufacture churn pushes that just pile up undeployed.
- Re-check `gh run list` each wave; when a run appears after `d4e17781`, the
  pipeline is back — note it + confirm prod `/version` advances.
