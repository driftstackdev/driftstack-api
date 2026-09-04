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

**Repo scope for `driftstack` / `webkit-driftstack`** — updated 2026-08-26 by the
owner, superseding the blanket prohibition that stood here.

- **A1 stays on device FINGERPRINTS full time** and owns the fork's
  fingerprint-matching surface. Do not disturb that lane.
- **A3 may work `driftstack` and `webkit-driftstack`** for everything else the
  product needs there — harness plumbing, device/input, capture orchestration.
  Granted by the owner directly, in A3's own session.
- **A2 (this repo's agent) still does not write those repos.** Nothing here
  needs them: measured 2026-08-26, every correlator, `harness-control-codec.ts`,
  `fleet-control-registry.ts` and `harness-control-protocol.ts` live in
  `apps/server/src`, and `inputLogical` — the tap-coordinate space — is in
  `apps/gui-client/src`. ⛔ **"Harness control plane" is the server-side code
  that SPEAKS to the harness; it is not the harness.** Two ledger rows sat
  blocked on a boundary neither was behind because that distinction was missed.

⚠️ Concurrent writers to the same fork source have bitten before. Use a worktree
for fork edits rather than relying on timing.

Cross-agent dependencies coordinate via planning file 133 schema + `docs/internal/cross-agent-control-plane-contract.md`.

**⚠️ A2↔A3 CHANNEL — corrected 2026-08-26. BOTH halves of the old note are now false.**

⛔ It used to say the file bus was structurally unreachable for A3, and to route handoffs
through `docs/internal/OPEN-ITEMS.md` in THIS repo. Neither holds, and following it writes a
handoff into a path that does not exist:

- **The ledger MOVED.** `docs/internal/OPEN-ITEMS.md` was carved out of this public repo in
  `c99b4e75e` and now lives at **`/Users/john/code/driftstack/docs/internal/OPEN-ITEMS.md`**,
  byte-identical. Appending here silently creates a new untracked file nobody reads.
- **A3 reaches the bus.** The blanket prohibition this section cited was superseded by the
  owner's grant recorded at the top of this file — A3 works `driftstack` directly and posts to
  `operations/agent-bus/live/A3.md`, which A1 reads.
- ⚠️ **`operations/agent-bus/A1-A3-BUS.md` is the DEAD channel** (last write 2026-07-12). The
  live lanes are `live/A1.md` and `live/A3.md`; check mtimes, not the filename.

- **A2 ↔ A1:** the file bus WORKS. A1 lives in `driftstack` and writes `live/A1.md` daily.
  A2 has a Rule-G write carve-out for `live/A2.md` only. Post there for A1.
- **A2 ↔ A3:** use **`docs/internal/OPEN-ITEMS.md`** in THIS repo — the only durable artifact
  both agents can write. Rows carry an owner; each agent edits its own.
- **Low-latency A2 ↔ A3:** the cross-session socket (`ListAgents` → `SendMessage`, peer named
  `A3`). ⚠️ **It is NOT durable** — it dies with both sessions and leaves no artifact. Anything
  that must outlive the session goes in OPEN-ITEMS.md as well as over the socket.
  A session started before cross-session messaging existed registers no
  `/tmp/cc-socks/<pid>.sock` and is invisible to `ListAgents`; it must be restarted to be
  reachable at all (this is how A3 was unreachable for weeks).

⚠️ **Check your correspondent is ALIVE before treating a post as a handoff.** For A1:
`grep -oE "\[A1[^]]{0,40}" /Users/john/code/driftstack/operations/agent-bus/live/A1.md | tail -1`.
For A3: `ListAgents`. Writing into a dormant lane is not delegation, and "blocked on X" is not a
real status unless X has responded recently.

To post for A1: append at the bottom of `live/A2.md` as `**[A2 <date> W#### | …]**`, then
`git add` that ONE path (NEVER `git add -A` — concurrent writers) and commit
(`Driftstack <dev@driftstack.dev>`, no AI trailer). Shared working tree: peers read the
working-tree file directly and the origin push lags, so a local pathspec-commit is enough — do
NOT `git pull --rebase` (A1/A3 WIP blocks it) or push the whole repo.

## ⛔ Committing in the shared tree — owner-approved 2026-08-26

**Always commit by pathspec: `git commit <paths> -F -`.** Never a bare `git commit`.
Untracked files need `git add -- <paths>` FIRST, because a pathspec cannot introduce a
file git does not know — the commit silently does nothing.

**Why the pathspec belongs on the COMMIT and not only the `add`.** `git add <one-path>`
writes into an index that may already hold a peer's files, and a bare `git commit` then
commits **the whole index**. A pathspec commit takes the WORKTREE at those paths, so a
poisoned index cannot travel through it.

**It is not hypothetical. In one session it prevented six incidents:**

- **Five stale-index reversions.** `lint-staged` stashes unstaged work, formats, then
  restores — and when the other agent commits inside that window the restore writes
  superseded content back into the INDEX. Signature every time: worktree-vs-HEAD **0**
  changed lines, index-vs-HEAD 4–30. A bare commit would have reverted a peer's committed
  work with every check green.
- ⛔ **One deletion of authentication.** A peer was mutation-testing `middleware/auth.ts`
  with `requireAuth` removed. For ~250s the shared tree held an admin middleware that did
  not authenticate, and a bare commit at that instant would have landed it behind a gate
  that looked green — the suite having run before the mutation and after the restore,
  never against what was on disk.

**Repairing a poisoned index:** `git reset -q -- <path>` (index ← HEAD, worktree
untouched). ⚠️ NOT `git checkout -- <path>`, which restores FROM the index and hands back
the stale content. `git checkout HEAD -- <path>` is for a poisoned WORKTREE.

**Mutating a security primitive in a shared tree** — auth, scopes, crypto, rate limits:

1. **Tell the peer BEFORE it goes in, not after it comes out.** A trap covers your process
   dying; it does nothing about the window where the mutation is legitimately live.
2. **Trap the restore** — `trap 'cp "$SNAP/f" "$F"' EXIT INT TERM`. A sequential
   mutate/test/restore leaves the file mutated if the command times out.
3. **Run the narrowest set that answers the question**, then widen. Exposure is the
   runtime of the suite you chose.

⚠️ **A negative from a subset is a statement about the subset.** The same auth mutation
scored 1 catcher against a `*auth*` + `*admin*` glob and **357** against the full suite —
the specs exercising a middleware are named for the FEATURE, not the middleware. When a
mutation on a widely-used primitive is caught by ONE test and that test is a text pin,
widen before believing it.

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
- **Marketing**: `https://driftstack.io` (Cloudflare Pages)
- **Customer dashboard**: `https://app.driftstack.io` (Cloudflare Pages)
- **Docs**: `https://docs.driftstack.io`
- **Test suite**: 1800+ files passing (latest verify via `npm test`)
- **Production deploy**: SHA in `/version` endpoint; auto-revert wired; 4 activation flags (sentry/email/livekit/oauthClient)

Verify current state via `bash scripts/deploy-status.sh` or check Sentry + Postmark + LiveKit dashboards.

## SSH access (Agent 2 authorized 2026-05-12)

Pubkey `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBT/DdhTI/beA8BtpnKAmkJ+kdDzUITP8JB/WP5a0Mu joeltheunissen89@gmail.com` authorized on both prod + staging. Use SSH directly for env wires, deploy operations, service restarts. Do NOT frame items as "operator action needed" when SSH + Tier-1 autonomy authorized.

Smoke-test verification: `ssh root@128.140.37.74 "echo connected; whoami; hostname"`.
