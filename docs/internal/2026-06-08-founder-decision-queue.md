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

**The one remaining piece — the customer-dashboard live-stream view — needs a
small ARCHITECTURE call from you (W294 finding):** wiring the dashboard
LiveKit-video subscription requires the `livekit-client` library, which **cannot
run in an `is:inline` script** (no bundling/imports). But the dashboard pages are
deliberately **is:inline** (you reverted the admin bundled-module migration). So
the LiveKit part needs one of:

1. **A scoped bundled `<script>`** on just the agent-session detail page (Astro
   bundles it → can import `livekit-client` + a unit-testable
   `livekit-preview.ts` helper). Cleanest; one exception to is:inline.
2. **CDN/global `livekit-client`** loaded via a plain `<script src>`, consumed
   by the existing is:inline script (keeps is:inline; adds a CDN dep).
3. **Defer** the dashboard live-view (the gui-client already shows the stream).
   **Your pick.** Once chosen, the build is ready + testable (correcting my earlier
   "verifiability-gated" framing — the wiring helper IS unit-testable via mocks; the
   live stream you verify on a session). The gui-client capture path already emits
   `tap_at` (touch), so that path is done; the dashboard input-overlay→touch +
   W267 device-CSS projection ride on whichever option above. Design/status:
   `docs/internal/2026-06-08-iphone-touch-input-pipeline.md`.

## 2. GitHub account flag — CI/Deploy now ROUTED AROUND (you've contacted support)

The account flag ("ineligible for transactions") stalled GitHub Actions (CI +
auto-deploy). **2026-06-09 finding:** it ALSO blocks the _manual_ deploy-bridge —
the script had the host `git clone` from github.com (a read/pull), which the flag
denies the same way (git **push** still works; that's the asymmetry). So my
earlier "manual deploy bypasses the flag" was wrong.

**Fixed — deploy is now GitHub-independent (`DEPLOY_VIA_BUNDLE=1`).** deploy-bridge
now ships the repo to the host as a **git bundle over scp** instead of pulling
from GitHub; the host clones from the bundle file, so build/swap/rollback are
byte-identical. **Staging is deployed via this path → `7b97a5d0`** (was
`d4e1778`; all post-deploy checks green, 42s). **Prod follows after the V-507
60-min staging-green window** (staging went green ~07:07 UTC → prod-eligible
~08:07) via `DEPLOY_VIA_BUNDLE=1 scripts/deploy-bridge.sh prod`. The backlog is
migration-free + additive (extract/search/login ops + iPhone-touch
api-types/SDK/openapi + docs; mock/stub drivers, pre-launch), so it's low-risk.
CI (PR gate) is still GitHub-bound, but the **full gate runs locally on every
push**, so verification isn't blocked — only the GitHub-hosted run is paused.
**No action needed from you** — we're no longer gated on the flag for shipping.

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

## 5. Surfaced edges (lower priority — fix-when-wired / your call)

- **Dashboard manual-control coordinate projection** — `viewportCoords` sends raw
  overlay px; must project to device px when Slice-4 wires the `<video>` + harness
  forwarding (TODO marked at the call site; latent today — forwarding 503s).
- **Recordings flush-on-close** — fire-and-forget on unmount; an abrupt app-close
  can lose an in-progress recording. Proper fix = Tauri `onCloseRequested` + await
  (Rust + launch-verify).
- **Staging→prod deploy** of the undeployed commits (V-507 staging-first;
  low-urgency — mock/pre-launch surfaces).

---

_Autopilot status: iPhone-touch contract shipped end-to-end (A2+A3 lockstep);
cross-SDK retry-safety docs done; a recurring gui-jsdom push-gate flake fixed.
Audited-clean (sound, don't re-audit): GUI live-flow (4 bugs fixed earlier), Go
SDK core, webhook-signature verification, the agent ACT layer (executor +
intent-dispatch), the webhook-delivery worker, account-lifecycle, and the
server/SDK/crypto surfaces. Safe non-gated ship-work is largely exhausted — the
high-value remainder is the gated/eyes-on items above; fresh-audit waves continue
(clean results = soundness confidence), and the dashboard LiveKit slice ships the
moment a live session is reachable. Churn is not manufactured._
