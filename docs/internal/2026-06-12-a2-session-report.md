# A2 session report — 2026-06-12 (founder-attended + autopilot)

One-page continuity index of everything Agent-2 shipped/surfaced this session.
Details live in the per-commit messages; this is the map.

## Shipped (all gate-green on main)

| Arc                                | Commits                                        | Net                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security fixes                     | `45512fc6`, `22d48843`                         | URL-FRAGMENT credential redaction closed in BOTH redactors (recipe-library + the canonical free-text log/Sentry sanitizer) — OAuth-implicit tokens no longer leak                                                                     |
| pageState evict                    | `6dca621c`                                     | Closed agent sessions evict their in-memory pageState (was a tested-but-never-called method)                                                                                                                                          |
| Simulator GUI arc (founder-driven) | `31d1d966`→`e36b9c20` (6)                      | iOS status bar → drag-region → Driftstack control toolbar (close/minimize/screenshot/rotate) → Drift-mark + profile-name branding → no-overlap status strip → **archetype-driven auto-sizing** (live video dims; no per-device table) |
| `session.profile_save_failed`      | `c474785c`                                     | A3-W1364 contract closed END-TO-END (A3's harness emit landed on this CP half same-day): frame → relay → subscribable webhook; migration 0073                                                                                         |
| Secrets Phase A (cockpit)          | `a5ca8a74`, `3449f046`, `197762cd`, `d11ea8c3` | Complete: encrypted-at-rest store (migration 0074, BYOK pattern, no new env) + owner routes with audited reveal (migration 0075) + admin-panel card + drift-pins                                                                      |
| Doc accuracy                       | `25c80f23`, `6a0b1f9a`, `f66cd5db`             | Deploy readiness re-verified at every delta growth (now 0072–0075, all metadata-safe); webhook-rotation-reminder "dormant" header was a LIVE-surface lie — fixed with its pinned parity test                                          |

## Ops (founder-visible)

- **Blank pages root-caused twice = gost:1080 down** (the hardcoded local-demo egress). Now
  **launchd-supervised** (`dev.driftstack.gost-1080`, KeepAlive, self-heal verified <7s).
  A1 informed (their verify-script pkills now just blip).
- Tauri GUI rebuilt+relaunched 3× for the founder (current install = `000282e0`;
  `e36b9c20` auto-sizing needs the next rebuild).

## Surfaced (founder decisions — NOT auto-done)

1. **Prod API deploy** — one command, delta de-risked on 4 axes, 4 safe migrations.
2. **`deploy-frontend.sh admin-panel`** — puts the secrets cockpit live (Actions still down).
3. **Proxy truth-gap** — GUI-saved/bound proxies do NOT route sessions (server env proxy does);
   wiring = the decided EG-API-1.6 design; prerequisite for the country-flag ask.
4. **Stale local-demo archetype** (`iphone16pro_ios18_6…` in bootstrap sessionDispatch) — flip on nod.
5. **§4.12 IP rate-limiter** — gap set completed at 7 routes (+cli-authorize initiate/exchange).
6. hstspreload submission; toolbar palette revisit ("kinda dark").

## Cross-agent

- A3: `profileSaveFailed` emit landed (lockstep contract); Oxblood `#722F37` palette relayed →
  applied to the MiniBrowser bar (screenshot-verified).
- A1: gost coordination + supervisor handoff posted; no reply needed.

## Audit roster additions (don't re-sweep)

Harness wire-protocol robustness · SDK auto-pagination (3 langs, one unreachable divergence
surfaced) · webhook-delivery SSRF (verified comprehensive, rebind-proof) · profile-store
TTL coupling (latent, trigger documented) · LLM-output parse + recapture scheduler/matrix/atlas ·
cli-authorize (textbook) · webhook-rotation-reminder (clean; header lie fixed). Roster at 22 entries.

## Addendum (~09:00) — the simulator-control saga: fully diagnosed, two ext fixes pending

Founder's "can't control / no changes" decomposed into THREE stacked causes, all now
pinned:

1. **Fork crash on touch** (the tap-killer): the full chain VERIFIED working — GUI
   publish → DataChannel → harness receive (`INPUT-RX` markers, A3) → injection ENABLED →
   `performActions` executes — then the fork aborts in `WebDriver::HTTPRequestHandler::
sendResponse` (`bad_optional_access`, empty `optional<unsigned int>`). Exact stack from
   3 .ips reports → **A3 fixing** (founder corrected routing: fork source = A3; A1 =
   fingerprints).
2. **Tooling kills live sessions**: 115 `pkill MiniBrowser` sites across ~75 scripts
   reaped the founder's sessions on every verify/gate run. Shipped
   `operations/scripts/kill-own-minibrowsers.sh` (never kills `--enable-webdriver=agt_`
   forks; synthetic-tested) + migrated the 12 ops/production sites; **the ~103
   captures/v1-v3 gate sites are A1's to migrate** (helper + recipe handed over).
3. **Window "same as before"**: every session crashed seconds in, so the new
   simulator-window features never got exercised. GUI now spawns the window BESIDE the
   main GUI, has a pin (always-on-top opt-out), and surfaces both formerly-silent
   failure paths (window-creation error + first failed input publish). Install =
   `41b7893f`.

Helper-app bundle (per-window Dock identity) = decided post-launch v1.x. Retest plan
once A3's fork fix lands: launch → window-beside-GUI + pin + tap/type in one pass.

## Addendum (~15:55) — founder live-retest telemetry (simulator control)

Two sessions observed via the armed daemon monitor: BOTH show the full
input chain healthy (INPUT-RX up → injection enabled → FIRST DataChannel
input received — the GUI publish path + harness receiver verified under
the founder's real usage). Session agt_f93eab82 then reaped
`browser_crashed` — the KNOWN fork-side bad_optional_access crash (A3's
fix in flight; fork = A3 scope per founder routing). agt_927565e5 live at
time of writing. Transient "0 frames published" warnings resolve as
capture starts. → A3: the crash class reproduced under founder retest at
~15:54; input-side confirmed NOT the trigger path (input flowed before
the crash on f93e).

## Addendum (~16:55) — frontier proposal demos shipped (frontend arc review point)

The invented-feature production queue is fully drained (hub demo's feature set is in
the GUI; a11y pass landed; Tauri review build at
`apps/gui-client/src-tauri/target/release/bundle/macos/Driftstack.app`). Per the
"extend the demo on frontend changes" workflow, two NEW proposal mocks shipped to the
living design canvas (`docs/internal/visual-demos/`, indexed under "New proposals"):

1. **`recordings-gallery.html`** (ba8406aa) — recordings as a thumbnail gallery
   (durations, play overlays, profile·context labels) + a sticky player rail:
   phase-colored scrubber, per-recording session facts (profile / driver / taps /
   result), export-clip + share. Recordings exist in the GUI today; the gallery is a
   UI proposal over real data.
2. **`proxy-health.html`** (9ba705ed) — egress health board: pool summary strip
   (count / healthy / median latency / geo-coherence), a geo-drift callout when an
   exit country stops matching its pinned profiles, and a per-proxy table with
   reachability, 24h latency sparklines, exit geo, pinned profiles and Test-now.
   SOCKS5 egress + auto-geo-locale exist; the health checks are the backend-later
   half.

Both screenshot-verified in the locked light+violet direction. **Founder review
points now pending:** (a) Tauri app walkthrough, (b) dashboard deploy
(`deploy-frontend.sh customer-dashboard`), (c) thumbs up/down on the two proposals.
Next waves = maintenance/fresh-audit or backend slices (folders/tags sync,
Roadmap-chip features) — the proposal queue is intentionally not being padded
further.

## Addendum (~17:20) — folders/tags backend Phase 1 (organization metadata API)

The named next frontier after the frontend arc's review point: profiles gain
server-side organization metadata so the GUI's folders/tags (client-side
profiles-meta.json today) can sync across devices.

- `profiles.folder` (nullable text) + `profiles.tags` (jsonb, NOT NULL `[]`) —
  additive migration **0076** (idempotent, no backfill; reaches prod with the
  founder-gated 0072+ deploy batch).
- api-types caps mirror the GUI store exactly (folder ≤32, ≤12 unique tags ≤24
  chars) — a value the GUI accepts is never rejected server-side. PATCH
  semantics: `folder: null` clears, `tags` is an exact-set replace.
- Clone copies organization metadata (in-account); V-480 export/import and
  V-666 transfer deliberately don't (a recipient's folder taxonomy is their
  own — documented at the schema).
- OpenAPI auto-follows (imports the zod schemas) + python spec dump regen'd;
  Go SDK structs updated; TS SDK auto-follows api-types; python is untyped
  pass-through. NOTE: the amended commit body under-describes the consumer
  fixes (dashboard mocks, sdk-ts fixtures, Go structs) — they ride the same
  commit.
- Gate lesson recorded: the api-types `Profile` shape is consumed by
  customer-dashboard `mocks.ts` and sdk-typescript test fixtures — change
  them WITH the schema or the push gate's workspace typecheck fails.

Phase 2 (next waves): GUI ProfilesView reads/writes the API fields with
profiles-meta.json demoted to offline cache + one-shot migrate-up; docs page
mention; dashboard profile-list organization UI.

Follow-up (~17:30): the push gate caught TWO more same-commit obligations the
slice owed — (1) W216.A profiles-doc-parity derives required doc fields FROM
CreateProfileRequestSchema/ProfileSchema shapes, so the customer docs page
(docs/profiles.astro) had to gain folder/tags examples + patchable-fields
prose in the same commit (doc-accuracy methodology working exactly as
designed); (2) its W516.C content pin re-pinned to the new 4-PATCH-fields
prose. Both amended into the slice. Full footprint: server + migration +
api-types + Go SDK + dashboard mocks + sdk-ts fixtures + customer docs +
6 pin files — one commit, every channel moves together.

Follow-up 2 (~17:40): gate 3 caught the marketing-site OWN-dir twin
(apps/marketing-site/tests/unit/docs-profiles-parity.test.ts) of the W516.C
patchable-fields pin — the 3-pin-locations lesson striking on a DOCS page this
time. Rule restated concretely: when touching apps/<app>/src/\*\*, grep for pins
in apps/server/tests/unit AND apps/<app>/tests/unit AND the cross-app rollups
BEFORE the commit (`grep -rln '<changed-file-basename>' apps/server/tests/unit
apps/<app>/tests`). Swept 'are patchable' across both dirs — no third
location. Slice now 05a3b1e8, gate 4 in flight.

## Addendum (~17:45) — organization arc complete across all three surfaces

Phase 2 (GUI sync, de2a6759) and Phase 3 (dashboard chips, gating) landed on
top of the backend slice (05a3b1e8). End state: GUI organizes (write-through
PATCH + seed-down), dashboard displays (read-only chips, search haystack),
server stores (migration 0076 — reaches prod with the founder-gated 0072+
deploy). Pre-0076 prod is safe against every piece. Tauri rebuild for the
founder's walkthrough is load-gated (box at 60-120 from the A1 fork rebuild;
watcher armed, builds when <10).

## Addendum (~18:05) — recordings gallery in production + founder verdicts

Founder reviewed the proposal demos: recordings-gallery APPROVED as-is;
proxy-health approved after r2 (wanted per-exit protocol capabilities — r2
added the TCP/UDP-ASSOCIATE/QUIC-h3/WebRTC capability matrix + impact cards).
Fresh GUI installed to /Applications (17:46 build; DMG step flaked —
distribution-only).

The gallery is now PORTED to production (RecordingsView): thumbnail grid +
facts rail, all behavior pins preserved. The port surfaced two real issues,
both fixed in the same commit: (1) BUG — persisted recordings were unplayable
after an app restart (Open disabled on the in-memory frames check even though
the player hydrates from disk on mount); (2) STALE COPY — the UI still said
disk persistence "lands in a follow-up phase" after that phase shipped.
Next port: proxy-health capability board → ProxiesView (UI first; the probe
backend is its own design).

## Addendum (~18:25) — fresh-audit wave on this week's new code + a latent test-rot class

Per the audit-roster directive (target genuinely NEW code), self-audited the
organization-metadata chain: dashboard `escapeHtml` verified attribute-safe
(customer tags can't break out of `data-profile-search`); GUI/server caps
verified mutually consistent (client clamps to exactly what the server
rejects). One real coverage gap closed: the jsonb `tags` column had ZERO
real-driver testing (route/service suites use the in-memory repo) — added a
real-PG round-trip test (array-not-string, defaults, exact-set update,
null-clears).

Running it with DATABASE_URL exposed a latent class: **all 6
db-\*-keyset-drizzle real-PG tests broken** by the postgres-js 3.4.9
dependabot bump — raw `Date` binds now throw on the prepared path. Nothing
caught it because GitHub Actions (their only unconditional runner) has been
down since 06-08 and local runs skip without DATABASE_URL. All 6 fixed
(`toISOString()` binds) + verified green against local PG (migrated through
0076). **⚠️ FOUNDER: the Actions outage is now demonstrably masking
dependency regressions — repo Settings → Actions needs the look.**

GUI rebuilt + reinstalled to /Applications (both approved ports included);
founder notified.

## Addendum (~18:40) — CORRECTION + the real (worse) finding: vacuous real-PG tests

The previous addendum's attribution was WRONG and is hereby corrected:
postgres-js 3.4.9 has been installed since repo scaffolding (lockfile
history), and raw-Date-bind crashes were already a documented class here
(scheduled-jobs W441 note). The Date-bind crash in the keyset tests was
there FROM BIRTH (2026-05-26).

The real finding: **CI's build-test job never migrates the schema** — the
postgres service is empty, so every db-\*-keyset-drizzle test's
`dbReachable` probe fails and the test silently vacuous-passes. The 7 (a
7th, rate-limit-overrides, was missed yesterday) "real Postgres" tests had
never executed anywhere until the local DATABASE_URL run. Shipped: ci.yml
migrate step before vitest; all 7 guards now THROW under CI
(vacuous-pass forbidden) while keeping the quiet local skip; the 7th
file's two Date binds fixed; the wrong in-source attribution corrected.

Founder takeaway softened accordingly: the Actions outage didn't mask a
dependency regression — but reviving CI is still what makes these tests
(and the new loud guards) actually bite.

## Addendum (night arc, ~20:00) — GUI beauty/fidelity run, slices landed

Founder directive (~19:00): GUI to "truly beautiful and fully featured",
all-night autopilot, demos are the spec. Landed since (each gate-green):

1. Grid view DEFAULT + FolderPicker (select-not-retype) across bulk bar,
   organize editor, create wizard.
2. iPhone-silhouette cards + registry device line + egress strip with UDP
   badge (new shared proxy-probe-cache; honest 'untested' state).
3. Simulator cockpit: previously-DORMANT useLatencyPing wired (live RTT),
   egress line threaded, honest identity block + fps counter
   (requestVideoFrameCallback).
4. Privacy banner (production-trust-surface wording only — demo's stronger
   claims stay founder+legal-gated).
5. /v1/egress/echo (probe design step 1; unauth+IP-limited, cf-ipcountry
   geo) + openapi/spec/pins; goes live with the founder-gated prod deploy.
6. Create-wizard fidelity: templates (save/load presets), demo tab cards,
   honest coherence ring, Notes FolderPicker; tag-clamp 400 edge fixed.
7. Simulator Snapshot (frame → PNG in Downloads) + Record (1fps off the
   live stream into the shared store; provider mounted in the simulator
   root; Pause SKIPPED — no pause intent exists, fake control).
8. Hub stats strip + folder/tag chips restored on the now-default grid
   (the founder's literal complaint).

Judgments logged: wizard Quick-Session button SKIPPED (creating ≠
launching; hub header owns Quick Session — demo parity loses to UX sense
here). E-2 exit-geo probe planned to the function signature (ureq over
SOCKS5 → echo); cargo work load-gated (box at 70-130 all night, A1 fork
rebuilds). Tauri rebuild queued on the load watcher — founder's app
refreshes with everything at once.

Process: three working-tree-bleed gate failures tonight → rule hardened:
edits reach tsc-clean before any push gates, tree frozen during gates.

## Bus reply (~21:05) — A2 facts for the touch→CSS coordinate investigation (A1 W2436 / A3 W1854)

A1/A3 flagged "A2's W1420 DPR" in the coordinate-scaling residual. The
A2-side mapping, verified at source + pinned by the LK.6.d pure tests:

- `livekit-input-capture.ts pointerToViewport` maps a GUI pointer event to
  the **video element's INTRINSIC pixel space** (`videoWidth/videoHeight`),
  with object-contain letterbox compensation (bars → null). The math is
  correct FOR THAT SPACE.
- The module contract comment says the Mac side expects "the fork's
  logical px". These coincide ONLY if the published stream's intrinsic
  size == the fork's logical (CSS) viewport. **If the harness captures the
  window at Retina/device scale (e.g. 776 or 804 wide vs the 402-px
  logical viewport), the GUI publishes capture-scaled coords and the
  scale (~1.93×) enters exactly at this seam** — consistent with A1's
  776-vs-402 measurement.
- Decision point (needs A3's capture-side fact): EITHER the harness
  divides injected coords by its own capture scale (it KNOWS the factor;
  zero contract change), OR the input contract grows the logical-viewport
  dims so the GUI can normalize (contract change, both sides). A2 ready
  to ship either; not flipping unilaterally mid-investigation.
- Test vector for A3: stream 776×1688, GUI click at CSS (200,400) inside
  an un-letterboxed element rendered at 388×844 → GUI publishes
  (400,800) in capture px; if injected raw as viewport px → lands ~2× off.
