# Prod-deploy readiness — 2026-06-11 (Agent-2)

Snapshot of what a prod API deploy would ship, and confirmation it is migration-safe.
The prod deploy is **founder-gated** (a full release / go-live action); this note exists so
the go-live decision is informed, not so the deploy is auto-triggered.

## State

- **Prod (`api.driftstack.dev`) git_sha:** `73f70d02` (verified live via `/version`).
- **`origin/main` HEAD:** `d072dcf3`.
- **Undeployed delta:** ~24 commits ahead of prod — all individually pre-push-gate-green
  (22.6k-test suite per commit). Highlights:
  - **`8b52066b` — launch-archetype cutover** iphone16pro → **iphone17** (the v1.0 launch
    default; migration `0072`). ⚠️ Until this deploys, **prod still serves iphone16pro as
    the column default** for archetype-omitted profiles/sessions. Expected pre-launch state.
  - Floating-iPhone **simulator window** + the touch/`canPublishData`/macos-private-api
    fixes (`55b4022e`, `d6dfdf41`, `9a55f45f`, `69eb17f9`).
  - `pageState` consumer + endpoint, `press_key` dispatch, `scroll_through` reading-traversal.
  - `aba776b0` keyset-cursor UUID guard (malformed-cursor 500 fix) + `d072dcf3` its drift-guard.

## Pending migrations the deploy will run — VERIFIED SAFE

Only **one** migration is new vs prod (0067–0071 are already applied on `73f70d02`):

- **`0072_archetype_default_iphone17.sql`** — two `ALTER TABLE … ALTER COLUMN "archetype"
SET DEFAULT 'iphone17_ios18_7_safari26_4'` (profiles + sessions). **Metadata-only:**
  instant, NO table/data rewrite, NO lock on existing rows, NO constraint change; existing
  rows keep their pinned archetype (profile-archetype-pin stability contract). Non-breaking.

So the DB step of the deploy is trivial + safe. The deploy mechanism (`scripts/deploy-bridge.sh
prod`) additionally runs a migration-immutability + journal-integrity pre-gate, a staging soak,
an atomic swap, and rollback — see [[2026-06-09-go-live-runbook]].

## Remaining to go-live (per the cutover memory, founder-gated)

1. **Prod API deploy** — `deploy-bridge.sh prod` (runs 0072; ships the delta above). ← this note covers it.
2. **Dashboard + marketing frontend redeploy** (wrangler) — pick up iphone17 hero/copy.
3. **Tauri GUI rebuild + swap** — pick up the simulator + touch control (done locally for the
   founder's machine per the simulator memory; the distributed build is the remaining piece).

Nothing here is auto-doable (all founder-gated release actions). Surfaced for the go-live call.
