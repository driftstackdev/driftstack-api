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

## Deploy-path readiness — 2026-06-12 (staging soak target verified healthy)

The deploy-bridge soaks on **staging** before prod, so a broken staging would fail the deploy.
Verified both are up + consistent:

- `staging.driftstack.dev/health` → `{"ok":true}`, `/version` git_sha **`73f70d02`** (driver:mock).
- `api.driftstack.dev` (prod) → same git_sha **`73f70d02`**.

So the full path (staging soak → atomic prod swap → rollback-on-fail) is operationally ready; the
~26-commit delta is undeployed to BOTH staging + prod, and the soak step has a live target. No
pre-deploy operational blocker — go-live reduces to running `deploy-bridge.sh prod` when the
founder is ready.

### Env / boot-safety — verified 2026-06-12 (no new required env in the delta)

A deploy fails the staging soak if the new code can't boot — e.g. it needs an env var that's
unset. Verified the `73f70d02..5b974638` delta adds NONE:

- `apps/server/src/lib/config.ts` (the env-validation source-of-truth) + `index.ts` are
  **unchanged** in the delta → no new boot-required env. The prod env that boots `73f70d02`
  boots `5b974638` too.
- The only `bootstrap.ts` change (+10/-1) is benign: a `new SessionPageStateStore()` (in-memory
  `Map`, no env/external dependency, constructed only behind `FLEET_CONTROL_PLANE_ENABLED`) + the
  archetype-default string flip (iphone16pro→iphone17, the cutover). No new boot dependency.

⟹ The deploy will boot cleanly on the existing prod env (no missing-env soak failure). Combined
with migration 0072 = metadata-only-safe and staging = healthy, the go-live is de-risked on all
three axes the deploy touches: **boot, schema, and the soak target.**

### New-code correctness + auth-boundary audit — 2026-06-12 (4th de-risk axis)

Boot/schema/soak (above) confirm the deploy _runs_; this confirms the delta's NEW
customer-facing + behavior code is _correct_ before it ships. Read the four new
surfaces the delta adds:

- **`GET /v1/agent-sessions/:id/page-state`** (`4514311c`, route `agent-sessions.ts:894`):
  `requireAuth` + `rateLimit('global')` + owned-check that throws `NotFoundError` on
  `rec.accountId !== ctx.account.id` — the IDOR-safe 404 pattern (no existence leak),
  identical to the sibling transcript SSE route. Returns `null` when the store is unwired.
- **`interact:press` → `press_key`** (`c1f18a5a`, `agent-intent-to-dispatch.ts:164`):
  fails closed on an empty/absent key value; `PressKeyParamsSchema` is `{key: string 1..20}`
  `.strict()`; the harness does the resolves-to-real-key validation. No malformed dispatch.
- **`behavioral_pause` `word_count`/`duration_ms`** (`agent-intent-to-dispatch.ts:100`): both
  `z.number().int().nonnegative()`; `duration_ms` is harness-clamped to `CAP_MS` and the
  values are decomposer-emitted, so the unbounded-upper schema is not a server-side DoS.
- **`scroll_through:true` on reading pauses** (`711daf76`): an internal dispatch→harness
  flag (no customer/SDK surface), degrades byte-identically to a single in-place dwell for
  short content. Tell-fix only.

⟹ The new behavior/customer-facing code in the delta is auth-boundary + fail-closed clean.
Combined with boot/schema/soak, the go-live is de-risked on all four axes the deploy touches:
**boot, schema, soak target, and new-code correctness.**

### Delta re-verified at 33 commits — 2026-06-12 (~06:30, post-GUI-arc)

The delta grew by the simulator-window GUI arc (status bar `31d1d966` → drag `bb6c5e9d` →
control toolbar `c254b9f1` → Drift-mark branding `a7c5dd31` → no-overlap status strip
`000282e0` → archetype-driven auto-sizing `e36b9c20`) plus the keyset/redact fixes earlier
in the arc. Re-verified every readiness conclusion against `73f70d02..e36b9c20` (33 commits):

- **Migrations:** still exactly ONE — `0072` (metadata-only, verified safe above). Nothing new.
- **Required env:** `config.ts` + `index.ts` still untouched across the whole delta — no new
  boot-required env.
- **The 6 newest commits** touch ONLY `apps/gui-client/` + one server-side _test_ file (a
  content-parity pin) — zero server-runtime impact. The Tauri GUI ships separately from the
  API deploy (already current on the founder's machine at `000282e0`).
- **Soak target:** staging `/health` `{"ok":true}`.

⟹ All four de-risk axes (boot / schema / soak / new-code correctness) hold unchanged at the
larger delta. The go-live action is the same single founder command below.

## Remaining to go-live (per the cutover memory)

Correction after cross-checking the cutover memory: the frontend + GUI steps are **already
done** — only the prod API deploy is genuinely pending.

1. **Prod API deploy — THE ONE REMAINING STEP (founder-gated).** `DEPLOY_VIA_BUNDLE=1
./scripts/deploy-bridge.sh prod` (runs 0072; ships the delta above). Server-deploy is
   tag-triggered (`server-v*`), not push-triggered, so the accumulated main does NOT auto-ship —
   it's an explicit founder release action. Prod already accepts explicit `iphone17`
   (`ArchetypeSchema` is free-form) so GUI/dashboard iphone17 sessions already work; 0072 only
   flips the _omitted_ default.
2. ✅ **Web frontends** (customer-dashboard / marketing / docs / admin) — already deployed
   manually via `scripts/deploy-frontend.sh` at the cutover (~18:30 2026-06-11; recent commits
   are server-side / gui-client, so no frontend redeploy is needed for them).
3. ✅ **Tauri GUI** — rebuilt + swapped on the founder's machine at the cutover; only the
   _distributed_ build (customer download) remains, which is a distribution concern, not an
   API-go-live blocker.

So: the API go-live reduces to one safe, founder-gated `deploy-bridge.sh prod`. Nothing
auto-doable.
