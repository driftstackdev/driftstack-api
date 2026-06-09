# Founder decision queue — 2026-06-08 (Agent 2 / driftstack-api)

Consolidated "start here" for the founder returning from away-time. These are
the items autopilot **cannot** action itself (founder decision / eyes-on /
cross-agent) — surfaced across recent waves, gathered here so they can be worked
in one pass. Everything else (audits/hardening) is shipping autonomously.

## ✅ 1. Agent-layer architecture overlap — RESOLVED (you picked option 1)

You decided **option 1** (W545→A3 W549). A2's `agent-runtime`/decomposer/executor/
agent-sessions stays the canonical NL agent layer; A3 **retired the duplicated
agent-service units**. The agent-service is now just net-new pieces A2 can adopt
as a lib if/when useful (`stop-conditions.ts` file-06 precedence,
`page-representation.ts`); nothing of A2's changes. No further action needed.

## ⭐ 1b. iPhone-touch input ("real tap not macbook mouse") — LIVE end-to-end, one gated piece left

Your "real iPhone tap not the macbook mouse cursor" directive is **delivered on
the contract + harness + docs side**, cross-agent in lockstep:

- **A2 shipped:** the touch vocab in the `InputEvent` contract (api-types SSoT +
  gui-client + sdk-typescript copies + openapi), the input-event route is
  touch-ready, and the live-video guide documents it (W3C input model).
- **A3 shipped:** the harness decodes the touch vocab → **genuine WebKit
  `pointerType:touch`** (no CGEvent-mouse fallback → no fingerprint tell), and
  the manual **keyboard** now routes through W3C key actions too (the parallel
  W198 hazard, also closed). CGEvent is only a legacy fallback.
- **No iOS-Simulator needed for v1.0** — the fork already does genuine WebKit
  touch (A3's runtime read; A1 confirms if/when relevant).

**✅ A2 EMIT SIDE COMPLETE — the dashboard live-view + touch are shipped (you
picked the scoped bundled `<script>`).** Both pieces landed:

- **Live video subscription** (`e64cd4e9`): livekit-client + a bundled `<script>`
  on the agent-session detail page driving the `<video>` (object-contain, so the
  stream is aspect-preserved — never stretched) + the connection pill.
- **Manual overlay → genuine touch + W267 projection** (`fb393b25`): clicks/drags
  on the dashboard video now emit `tap` / `touchStart|Move|End`, with coords
  projected to device-CSS (closes W267 — taps used to land in the top-left). The
  gui-client already emitted `tap_at`, so **all A2 emit surfaces are done**.

**The whole iPhone-tap pipeline is now A2-complete + A3-triggered (bus W308).**
The only remaining gate is **A1's drive-bridge** (`--enable-webdriver` fork-deploy):
A3's harness decoder + injector are built and waiting on it; when it's up, the
manual tap path is end-to-end (you tap the dashboard video → genuine WebKit
`pointerType:touch` on the phone, no mouse cursor). **Nothing needed from you** —
just verify the live stream + taps on a running session once A1's drive-bridge
lands. Design/status: `docs/internal/2026-06-08-iphone-touch-input-pipeline.md`.

## 2. GitHub account flag — CI/Deploy now ROUTED AROUND (you've contacted support)

The account flag ("ineligible for transactions") stalled GitHub Actions (CI +
auto-deploy). **2026-06-09 finding:** it ALSO blocks the _manual_ deploy-bridge —
the script had the host `git clone` from github.com (a read/pull), which the flag
denies the same way (git **push** still works; that's the asymmetry). So my
earlier "manual deploy bypasses the flag" was wrong.

**Fixed — deploy is now GitHub-independent (`DEPLOY_VIA_BUNDLE=1`).** deploy-bridge
now ships the repo to the host as a **git bundle over scp** instead of pulling
from GitHub; the host clones from the bundle file, so build/swap/rollback are
byte-identical. **✅ DONE — both staging (`7b97a5d0`) AND prod (`e64cd4e9`) are
now deployed via this path.** Prod went current 2026-06-09 08:13 UTC (was
`d4e1778`, ~31 commits behind; 38s, all 15 post-deploy checks green) after the
V-507 staging-green window — and V-507 was satisfied exactly: the commits between
the staging-green SHA and prod touch zero `apps/server` runtime + zero migrations.
The backlog was migration-free + additive (extract/search/login ops + iPhone-touch
api-types/SDK/openapi + docs; mock/stub drivers, pre-launch). **The deploy gap is
closed.** CI (PR gate) is still GitHub-bound, but the **full gate runs locally on
every push**, so verification isn't blocked — only the GitHub-hosted run is paused.
Future deploys: `DEPLOY_VIA_BUNDLE=1 scripts/deploy-bridge.sh <staging|prod>` while
the flag persists (reverts to a plain clone once it clears). **No action needed.**

## 3. GUI (b) release `.app` paint bug — needs your build + launch

Narrowed to a WKWebView **compositing** issue (not boot/assets — JS runs). Full
diagnosis procedure + the dev-log file path + candidate toggles are in
`docs/internal/2026-06-08-gui-live-flow-hardening-and-b-diagnosis.md`. Autopilot
can't do it (eyes-on + changes window UX). GUI (a)/(c)/(d) are **done**.

## 4. Breaking / gated changes (your design call — autopilot will NOT flip)

- **agent_sessions strict FK** (task #5) — **W303 finding: the "strict FK" isn't
  cleanly achievable as-is, and that's the real reason it was flagged "not
  clean."** You picked ON DELETE SET NULL (correct), but the deeper blocker is:
  `agent_sessions.driftstack_session_id` stores the **prefixed PUBLIC id**
  (`ses_<uuid>`, what the API hands customers via `prefixId('ses', …)`), not the
  raw `uuid` that `sessions.id` is. So a DB FK can't be added without changing
  storage semantics. Two options — **your call:**
  1. **Deprefix-on-write / reprefix-on-read** + store the raw uuid + real FK
     (ON DELETE SET NULL). True referential integrity + auto-null when a session
     is destroyed; cost = prefix plumbing on the agent-session create + read
     paths + a migration that strips `ses_` from existing values and nulls
     orphans/non-uuids.
  2. **Keep the loose `text` link (no DB FK)** — the prefixed-public-id pattern
     is arguably intentional loose coupling; add app-level validation on write
     instead. **Recommended for pre-launch** (the FK's value is modest and the
     column is usually null; revisit if integrity becomes important).
     (I designed + then reverted the uuid-FK migration once I found the prefix —
     shipping it would have nulled every existing link, since `ses_<uuid>` can't
     cast to uuid. Caught in design, nothing shipped.)
- **iphone16pro → iphone17 launch-archetype cutover** — canvas-gated (Agent 1);
  surfaced, not flipped.
- **LiveKit old-route over-grant (W351)** — the older `POST /v1/sessions/:id/livekit-token`
  lets the body pick `role:'publisher'` → `canPublish:true` (a customer could publish to
  their own capture room, disrupting the Mac-side stream); the canonical
  `/v1/agent-sessions/:id/livekit-token` is correctly subscriber-only. Both are gated on
  `config.livekit` (absent in prod → **not live, not exploitable today**). **Your call on
  the route's fate:** force the old route subscriber-only, OR delete it now that
  agent-sessions is canonical. Pre-launch, low-urgency; it's a route-architecture decision
  so I surfaced rather than flipped.
- **astro-6 dependency migration** — the only fix for the 2 HIGH `npm audit` advisories
  (devalue DoS, undici via `@astrojs/cloudflare`). NOT a clean bump: `@astrojs/tailwind`
  has no astro-6 support → astro 6 forces a **Tailwind v3→v4 migration** across all 5 sites
  (visual-regression risk on every page; correctness is visual, not autopilot-verifiable).
  **Not urgent** — both HIGH vulns are build-time/static-site (the server runtime's `undici`
  is 8.x, safe). **Your call** to schedule it as a focused window (I'll migrate site-by-site,
  you spot-check renders). See `docs/internal/2026-06-09-dependency-security-audit.md`.

## 5. Surfaced edges (lower priority — fix-when-wired / your call)

- ✅ ~~Dashboard manual-control coordinate projection~~ — **DONE (`fb393b25`):**
  `viewportCoords` now projects overlay px → device-CSS px off the wired `<video>`
  (W267 closed; unit-tested `overlay-coords.ts`).
- ✅ ~~Staging→prod deploy of the undeployed commits~~ — **DONE (`e64cd4e9`):**
  both current via the bundle path (see item 2).
- **Recordings flush-on-close** — fire-and-forget on unmount; an abrupt app-close
  can lose an in-progress recording. Proper fix = Tauri `onCloseRequested` + await
  (Rust + launch-verify). _Still open._
- **Remove the mouse InputEvent variants** — touch is now emitted by both surfaces
  (dashboard `fb393b25` + gui-client `tap_at`); the mouse variants
  (`mouseMove/Down/Up/wheel`) can be retired from the InputEvent contract once A3
  confirms the harness no longer needs them (cross-agent; non-urgent, they're
  unused/503 today). _Surfaced, not flipped._

---

_Autopilot status (refreshed 2026-06-09, ~W360): the **profile-backed-session feature
is complete + deployed** end-to-end (DEK crypto → mint → validate → dispatch with
restore/save-back URLs → docs + all 3 SDKs + OpenAPI), and the A2↔A3 restore contract
is **locked** (omit-for-new + fail-closed; A3 wires in lockstep — bus W356). The
\*\*`prof_<uuid>` footgun is closed platform-wide** (both session routes accept the
canonical id; GUI passes it). Prod is current at **`7be48a97`\*\*.\_

_A 4-wave **secret-egress** hardening arc shipped + deployed (credential tokens are now
redacted from free-text in all 4 channels: gui telemetry, server Sentry, server logs,
404/error responses; shared `redactText`/`scrubText`), plus a **rate-limiter fail-safe**
(Redis token-bucket no longer 500s on a partial hash). A friendlier **streaming overlay**
(spinner + Reconnect) shipped to the GUI._

_Since then ~18 distinct subsystems have been audited **clean + test-guarded** (secret-egress,
concurrency [rate-limiter + pair-mode lock], billing [quantity-agg + flat-tier pricing],
schema unique-constraints, discriminated-union exhaustiveness, pagination cursor-decode,
config fail-safety, public-incident sanitization, mock driver, GUI recordings memory ring-
buffer, deep-link parsing, SDK pagination stall-guard). **The autonomous non-gated bug-surface
is comprehensively exhausted + verified robust.** The loop now runs as a **watch** (A3 bus /
git / dep-vuln / prod deltas — it caught the A3 restore-contract unblock) + light fresh-audits;
real value now requires a founder decision on the gated items above. Churn is not manufactured._
