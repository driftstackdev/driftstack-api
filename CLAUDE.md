# Driftstack API — repository context (Agent 2 scope per Rule G)

## ⚠️ Session start protocol — read in order

On any new session in this repo, read in this order:

1. **`/Users/john/code/driftstack/ORCHESTRATOR-STATE.md`** — persistent cross-session context. Current launch state, all Tier-3 verdicts LOCKED, active arcs per agent, founder action queue, critical memory rules. Updated at end of significant sessions.

2. **`./AGENTS.md`** (this repo) — operational binding rules: founder anonymity policy, git identity policy, attribution policy, customer-facing copy policy, drift-guard test pattern, etc.

3. **`/Users/john/code/driftstack/CLAUDE.md`** — root project context + verification protocol + signal-matching standard.

4. **`/Users/john/code/driftstack/docs/planning/`** recent files (especially 130+):
   - `132-ml-expansion-roadmap.md` — Three-Layer surface generalization (Agent 2 implements file 132 Phase 7 customer-facing AI as v1.0 per founder verdict 2026-05-16)
   - `133-egress-architecture-cross-agent.md` — EGRESS binding spec (cross-agent split, 7 Tier-3 verdicts LOCKED, Phase 1 SOCKS5 → Phase 2 OpenVPN → Phase 3 WireGuard)
   - Other planning files per task scope

5. **`./docs/internal/`** recent batch reports for in-flight work continuity.

If subsequent work conflicts with ORCHESTRATOR-STATE.md, treat ORCHESTRATOR-STATE.md as authoritative for cross-session decisions.

## ⚠️ Cross-repo scope (Rule G binding)

This repository (`driftstack-api`) is Agent 2's scope ONLY:

- `apps/server` — Fastify control plane
- `apps/customer-dashboard` — customer self-service UI
- `apps/admin-panel` — internal admin UI
- `apps/marketing-site` — public marketing
- `apps/docs` — customer docs
- `apps/status-site` — uptime/incident page
- `apps/gui-client` — Tauri desktop client (file 128)
- `packages/sdk-{typescript,python,go}` — customer SDKs
- `packages/api-types` — shared API types
- `packages/behavioural-simulation` — file 05/103 implementation
- `packages/webrtc-streaming` — file 07 LiveKit integration
- `packages/recipe-library` — file 56 navigation flows
- `packages/recapture-automation` — file 102/123 capture orchestration
- `packages/webhook-delivery` — webhook subsystem

**DO NOT touch** `driftstack` or `webkit-driftstack` repos (Agent 1 scope: WebKit fork, atlas, capture orchestration).

Cross-agent dependencies coordinate via planning file 133 schema + `docs/internal/cross-agent-control-plane-contract.md`.

**⚠️ A2↔A3 CHANNEL — POST TO THE LIVE OUTBOX FIRST.** Two layers exist and they are NOT interchangeable (`operations/agent-bus/live/README.md` is the authority):

1. **`operations/agent-bus/live/A2.md` — YOUR OUTBOX, and the layer agents actually read.** Only A2 appends to it; all agents read all three of `live/A{1,2,3}.md`. This is the low-latency channel. **Post here.**
2. `operations/agent-bus/A2-A3-BUS.md` — the durable PAIRWISE ARCHIVE. Material outcomes get copied here once it is clean. It is a record, not a channel.

⛔ This line used to name the pairwise file as "THE BUS", and that cost real messages: on 2026-08-25 three posts — including a wire-contract proposal and a "please review" on a change made inside A3's own files — went to the archive while the live layer sat untouched. Never edit or commit another agent's outbox (`live/A1.md`, `live/A3.md`).

To post: append at the bottom of `live/A2.md` as `**[A2 <date> W#### | …]**`, keep it compact, then `git add operations/agent-bus/live/A2.md` (NEVER `git add -A` — concurrent writers) + commit (`Driftstack <dev@driftstack.dev>`, no AI trailer). Shared working tree: peers read the working-tree file directly and the origin push lags, so a local pathspec-commit is enough — do NOT `git pull --rebase` (A1/A3 WIP blocks it) or push the whole repo.

⚠️ **Check that your correspondent is ALIVE before treating a post as a handoff.** `grep -oE "\[A3[^]]{0,40}" operations/agent-bus/live/A3.md | tail -1` gives their last entry. A3 has been silent on every bus since 2026-08-01; A1 writes to `live/A1.md` daily. Writing into a dormant agent's lane is not delegation, and "blocked on A3" is not a real status unless A3 has posted recently. A peer session may also be reachable directly — check `ListAgents` and message it rather than assuming the file is read.

## Key rules (full set in ORCHESTRATOR-STATE.md + AGENTS.md)

- **V-205 attribution**: all commits `Driftstack <dev@driftstack.dev>`; ZERO AI-tooling strings (Claude / Anthropic / GPT / Copilot / noreply) in commit messages or bodies; V-527 commit-msg hook enforces.
- **V-211 anonymity**: zero personal-name references in public-facing surfaces.
- **Rule K**: no idle wakes during autopilot — switch tracks if blocked, never halt.
- **Rule M**: ≥3 tracks per wave HARD multi-track (no single-track absorption).
- **Rule R**: per-wave commit discipline ≤50 files uncommitted.
- **Rule L**: empirical proof per slice; integration tests catch real bugs (see W1037+ lesson: SESSION_ID_RE prefix mismatch + ownership check broken caught by integration tests).
- **Credentials via env vars only**: SSH-write to `/opt/driftstack/api/.env` on Hetzner prod + staging; NEVER commit to repo files (even gitignored); NEVER echo in Bash output; NEVER log values.
- **/loop 3m via Skill invocation** is canonical autopilot mechanism (NOT CronCreate direct registration).

## Production state (verify before assuming current)

- **Prod**: Hetzner CPX32 at `https://api.driftstack.dev` (root@128.140.37.74)
- **Staging**: Hetzner CPX22 at `https://staging.driftstack.dev` (root@116.203.22.197)
- **Marketing**: `https://driftstack.dev` (Cloudflare Pages)
- **Customer dashboard**: `https://app.driftstack.dev` (Cloudflare Pages)
- **Docs**: `https://docs.driftstack.dev`
- **Test suite**: 1800+ files passing (latest verify via `npm test`)
- **Production deploy**: SHA in `/version` endpoint; auto-revert wired; 4 activation flags (sentry/email/livekit/oauthClient)

Verify current state via `bash scripts/deploy-status.sh` or check Sentry + Postmark + LiveKit dashboards.

## SSH access (Agent 2 authorized 2026-05-12)

Pubkey `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBT/DdhTI/beA8BtpnKAmkJ+kdDzUITP8JB/WP5a0Mu joeltheunissen89@gmail.com` authorized on both prod + staging. Use SSH directly for env wires, deploy operations, service restarts. Do NOT frame items as "operator action needed" when SSH + Tier-1 autonomy authorized.

Smoke-test verification: `ssh root@128.140.37.74 "echo connected; whoami; hostname"`.
