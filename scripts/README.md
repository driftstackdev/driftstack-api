# scripts/ — operator tools

Quick reference for the operator-facing scripts in this directory.
Read-only and dry-run modes are clearly marked. All deploy-related
scripts require SSH access to the Hetzner hosts (`root@<host>`;
autopilot pubkey appended 2026-05-12).

## Deploy + revert toolchain

| Script                   | Mode      | Purpose                                                                                            |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------- |
| `deploy-bridge.sh`       | mutating  | Manual SSH deploy of `origin/main` (or explicit SHA) to staging/prod. Auto-reverts on verify FAIL. |
| `revert-bridge.sh`       | mutating  | Revert to `.last-good-sha`. Supports `--dry-run` (exit 0 no-op, 2 revert-needed).                  |
| `post-deploy-verify.mjs` | read-only | 9 invariants vs public origin. `--json` for tooling.                                               |
| `deploy-status.sh`       | read-only | Snapshot of git_sha + uptime + activation flags. `--json`, `--check` (cron), `--quiet`.            |

Full runbook: `docs/runbooks/deploy-bridge.md`.

## Provisioning + migration

| Script                                   | Mode     | Purpose                                                             |
| ---------------------------------------- | -------- | ------------------------------------------------------------------- |
| `v278k-neon-split-cutover.sh`            | dry-run  | V-278.K — split shared Neon Postgres into prod + staging projects.  |
| `v278l-upstash-split-cutover.sh`         | dry-run  | V-278.L — split shared Upstash Redis into prod + staging instances. |
| `sentry-create-per-service-projects.mjs` | mutating | V-469 follow-up — provision Sentry projects per service.            |

## Smoke tests

| Script                   | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `smoke-oauth-client.mjs` | V-667.C — POST /v1/auth/oauth-client/start and validate authorize URL shape. |
| `smoke-postmark.mjs`     | V-665/V-486 — send fixture templates via Postmark, report per-template OK.   |
| `smoke-livekit.mjs`      | V-531.B — mint a LiveKit token, open WS handshake against the cloud.         |

## Local dev

| Script                 | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `dev-bootstrap.sh`     | One-shot signup + magic-link + API-key mint via debug-token mode.    |
| `install-git-hooks.sh` | Wire pre-commit + pre-push hooks (lint-staged + verify chain).       |
| `dr-rehearse.sh`       | V-510 — local DR scenarios (PG corruption, Redis loss, etc.).        |
| `chaos/run-all.sh`     | V-547.B — run all 5 chaos rehearsal scenarios in dry-run by default. |

## CI helpers

| Script                          | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `check-bench-regression.mjs`    | V-120 — gates PRs that regress benchmark numbers.              |
| `check-subprocessor-mirror.mjs` | V-493 — DPA Annex 3 ↔ sub-processors data-source parity check. |
| `generate-changelog.sh`         | Cuts a SDK changelog entry from git log between tags.          |

## V-528 privatization toolkit

`v528-*.sh` — one-off helpers used when splitting the repo into
public + private mirrors. See `docs/internal/v528-repo-privatization-runbook.md`.

## Conventions

- Bash scripts use `set -euo pipefail` and `#!/usr/bin/env bash`.
- Mutating scripts default to `--dry-run` where applicable; explicit
  `--execute` opt-in. Deploy scripts (deploy-bridge / revert-bridge)
  are exception: they always execute (no separate dry-run flag), but
  V-549.B auto-revert provides the rollback safety net.
- `--json` output mode where useful (post-deploy-verify, deploy-status)
  for tooling integration.
- Credentials never accept via CLI argument — always env vars
  (POSTMARK_API_TOKEN, LIVEKIT_API_KEY, etc.) per the security
  posture.
