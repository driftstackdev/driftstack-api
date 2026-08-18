# GUI client audit — current state vs file 128 spec

**V-236 — PHASE 1 of GUI client launch arc per founder direction 2026-05-06.**

> **HISTORICAL SNAPSHOT — "Current:" below means current _as of the date in the
> line above_, not today.** V-801 verified that everything this document lists as
> outstanding has since shipped, each confirmed to exist in the tree rather than
> assumed: the hard toolchain pin (`src-tauri/rust-toolchain.toml`), OS-keychain
> API-key storage (`src/lib/settings.ts`), the create-profile modal
> (`src/views/ProfilesView.tsx`), tier and concurrent-cap display with button
> gating (`src/views/SessionsView.tsx`), crash-only Sentry telemetry
> (`src/lib/telemetry.ts`), the first-run wizard (`src/views/FirstRunWizard.tsx`),
> and `tauri-plugin-updater` in `src-tauri/tauri.conf.json`.
>
> Read the gap lists and the P0/P1/P2 tables below as a record of what the audit
> found on that date, not as a to-do list. The document is kept intact rather than
> line-edited because its value now is the snapshot; rewriting the "Current:"
> lines in place would destroy the only thing it still is.

Walks `apps/gui-client/` systematically. For each of the 13 audit dimensions: current state, gap vs file 128 spec, recommended priority for closure (P0 launch-blocking / P1 launch-recommended / P2 post-launch / T2-T3-surface for items needing founder ack).

The headline finding: **the GUI client is more complete than the launch checklist suggested.** Sessions / profiles (read + delete) / proxies / recordings / connectivity / settings all wire to live Driftstack API endpoints. Auth chain is live; brand consistency is locked. The remaining launch-blockers are narrow + concrete.

## Audit dimensions

### 1. Tauri framework version + Rust toolchain pin

**Current:** Tauri 2.0–2.1 (`@tauri-apps/cli@^2.1.0` in `package.json:18`; `tauri = "2.0"` in `Cargo.toml:18`). Rust edition 2021. `README.md` mentions "Rust 1.95+" as soft requirement; no `rust-toolchain.toml` for hard pin.

**Gap:** Reproducible-build pin missing. A new contributor on Rust 1.94 or pre-1.95 might hit subtle build issues.

**Priority:** **P1** — small (5 min): add `rust-toolchain.toml` with `[toolchain] channel = "1.95.0"`.

### 2. Frontend stack

**Current:** React 18.3 + TypeScript 5.7 (strict) + Tailwind 3.4 + Vite 5.4. No component library — custom `@layer components` in `src/styles/index.css:31–90` define `.btn-primary` / `.btn-secondary` / `.btn-danger` / `.mono` / `.status-pip` / `.section-label`. Semantic colour tokens in `tailwind.config.ts:16–49`.

**Gap:** None — stack matches file 128 + `apps/customer-dashboard/` conventions.

**Priority:** **None** — already done.

### 3. Runnable today

**Current:** Both paths fully functional.

- `npm run dev` → Vite browser shell at `http://localhost:1420`. All 10 views route correctly in browser-only mode (useful for fast UI iteration without Tauri's native overhead).
- `npm run tauri:dev` → native macOS desktop window with hot reload against the same Vite backend.

**Gap:** None.

**Priority:** **None** — already done.

### 4. Auth flow state

**Current:** API-key auth (no web session). `client.ts:16–19` builds `Driftstack` SDK client from `apiKey` + `baseUrl`. Settings persisted via Tauri Store plugin to `~/Library/Application Support/dev.driftstack.gui/settings.json` (`settings.ts:22–49`). API key masked in Settings UI but **stored plaintext on disk** (acknowledged in `settings.ts:6–8` with future keychain upgrade queued for "GUI8"). Memoized in React context (`SettingsContext.tsx:46–49`); SDK client rebuilt on apiKey/baseUrl change.

**Gap:** Plaintext-on-disk storage of customer-paid license keys is a customer-trust concern (the GUI client is local-install software — disk forensics or shoulder-surfing reveals the key). File 128 spec implies OS keychain via Tauri APIs.

**Priority:** **T3 founder-ack required** — security/customer-data architecture decision. Three approaches: (a) macOS Keychain via `@tauri-apps/plugin-stronghold` or similar, (b) encrypted-at-rest with OS-derived key, (c) keep plaintext + document explicitly. Surface for founder verdict before implementing.

### 5. Session management

**Current:** Fully wired to `/v1/sessions/*` via `@driftstack/sdk`.

- `SessionsView.tsx:37–91` — `client.sessions.list()` with 5s auto-poll + `client.sessions.create()` for spawn + `client.sessions.destroy(id)` for teardown.
- `LiveSessionView.tsx:114` — `client.sessions.capture(sessionId, { kind: 'screenshot' })` polled at 500ms.
- `client.sessions.getState(sessionId)` for URL + title metadata.
- `client.sessions.interact()` for intent actions (scroll, key) at line 225.
- Coordinate-level input → `/v1/sessions/:id/gui-input` (separate endpoint, requires `gui_control` scope) via `gui-input.ts:44–65`.

**Gap:** None at the wire level. UX polish (loading states, error recovery) is Tier-3.

**Priority:** **None** for wire-level. UX polish is **P2** (post-launch).

### 6. GUI streaming

**Current:** Polling-based base64 PNG over HTTP/JSON via `client.sessions.capture()`. 500ms frame interval; ~50–200 KB per frame on the wire; ~1s end-to-end latency floor (acknowledged in `LiveSessionView.tsx:20–27`). Tap marker UX shows input registered for 600ms (line 470). No WebRTC, no live WebSocket. All frames are live captures from real WebKit fork driver sessions — no mock data path.

**Gap:** Polling is the MVP; WebRTC closes the latency gap when GUI3+ justifies the server-side work. File 128 spec leaves WebRTC as "future" per current understanding; cross-reference file 36 (gui-streaming-architecture.md) for the target shape.

**Priority:** **P2** (post-launch). Polling works for Manual-tier customer-driven session piloting; WebRTC matters more when fleet-driven concurrent streaming becomes a customer expectation.

### 7. Profile management

**Current:** Read + delete fully wired to `/v1/profiles/*` via `@driftstack/sdk`.

- `ProfilesView.tsx:39–92` — `client.profiles.iterate({ limit: 50 })` for listing (async iterator) + `client.profiles.delete(id)` for removal.
- Per-profile description: persistent identity slots with cookies + localStorage.

**Gap:** Create-profile button is stubbed: `aria-disabled="true"` at `ProfilesView.tsx:118`. Comment notes "pending dialog for name + archetype picker." Customer cannot create profiles from the GUI today — they'd have to use the API directly or the customer dashboard.

**Priority:** **P0 launch-blocking.** Manual-tier customers expect profile management end-to-end in the GUI. Estimated ~1-2hr Tier-1 work: form modal with name + archetype picker, calls existing `/v1/profiles POST`, refreshes list on success.

### 8. Tier-aware enforcement

**Current (V-866): SHIPPED. This section recorded it as a P0 launch-blocker long after it was built.**

The GUI reads the tier and both caps off `accountMe` and gates on them. `SessionsView` derives
`concurrent_session_cap` and folds the active agent count in so the header shows "X / Y" and the
New-session button greys at the cap. `ProfilesView` mirrors that gate on Launch, and V-239 gates
New / Duplicate / Import on `profile_cap` with a tier-named reason. Server-side V-073 enforcement
is unchanged; the GUI now pre-empts the 402 rather than surfacing it.

The citation this section offered as proof of absence — `SessionsView.tsx:119`, "no tier
conditional" — is today the line that reads the cap. A line number is the fastest-rotting evidence
a document can carry, and quoting one to prove a NEGATIVE inverts the moment the file changes.

**Gap:** None. The file-128 behaviour described here — display "X of Y concurrent sessions" and
disable-when-full so the customer never meets the 402 unless racing — is what ships.

**Priority:** Closed. The four steps below were the plan, and all four are in the GUI today:

1. Read tier + concurrent cap on settings load (need to confirm endpoint — likely `/v1/account` or similar; if missing, add to `apps/server` first).
2. Display "X / Y concurrent sessions" in `SessionsView.tsx` header.
3. Gate Spawn button on `active < cap`.
4. Lifecycle: refresh after each create/destroy.

The endpoint contract for "give me my tier + cap" needs verification — see Section 14 below.

### 9. Self-hosted variant

**Current:** Single build, dual-mode via runtime config. The first-run wizard asks Cloud or Self-hosted, pins Cloud to `https://api.driftstack.dev`, preserves a custom self-hosted URL, and defaults a fresh self-hosted entry to `http://localhost:3000`. The titlebar derives `cloud` versus `self-hosted` from the configured hostname; cloud customers no longer see a hardcoded self-hosted label. API keys are stored in base-URL-scoped OS keychain entries so deployment switching cannot reuse the wrong bearer credential.

### 10. Update mechanism

**Current:** Implemented with `tauri-plugin-updater`. `tauri.conf.json` points at the GitHub Releases `latest.json` endpoint and injects the updater public key at build time. `src/lib/updater.ts` performs the programmatic startup check, rejects non-newer versions, and exposes a signed install/relaunch flow through `UpdateBanner`. Network errors and missing releases degrade quietly without weakening signature verification.

**Distribution boundary:** the current supported artifact is the signed Apple-silicon `.app`. Customer-distributed builds must satisfy Developer ID, hardened-runtime, notarisation, stapling, and Gatekeeper checks; the updater accepts only signed manifests.

### 11. Telemetry / Sentry

**Current:** Not implemented. No `@sentry/*` imports, no error reporting, no telemetry crates in `Cargo.toml`. Errors are local-only: `DriftstackError` from SDK is displayed inline in `ErrorBanner` or logged to console.

**Gap:** Operational signal: "did the customer hit a crash?" — unknowable without telemetry. Customer-trust signal: zero-telemetry is a privacy feature for self-hosted customers.

**Priority:** **T3 founder-ack required.** Customer-data architecture decision. Driftstack-cloud API has Sentry (V-198 / D-034); should the GUI client also report? Two postures:

- (a) Cloud variant reports to Sentry, self-hosted variant does not (config-driven; matches "your data stays on your premise" pitch for self-hosted).
- (b) Both report; explicit opt-in setting; default off.
- (c) Neither reports; rely on customer-side bug reports.

Surface for founder verdict before implementing.

### 12. Anonymity policy compliance (V-211 mirror)

**Current:** **COMPLIANT.** No founder name in customer-facing strings. No external-tooling references in any visible text. Internal developer comments reference "the founder" generically (e.g. `SessionsView.tsx:6`, `LiveSessionView.tsx:7`, `ProxiesView.tsx:5`) — those are code-comment-only, never reach the customer.

**Gap:** None.

**Priority:** **None** — already compliant.

### 13. Brand consistency (`V-219*` mirror)

**Current:** **LOCKED + COMPLIANT.** All tokens aligned with the Driftstack brand:

- **Oxblood accent** — `#a83b4d` (`tailwind.config.ts:37`) for `.btn-primary`, live indicators, focus rings. Single saturated colour.
- **Geist Sans body font** — `tailwind.config.ts:54–62` with system-ui fallback. Applied to all body text.
- **Berkeley Mono technical accents** — `tailwind.config.ts:67–75` via `.mono` class. Used for session IDs, endpoints, command output.
- **Lowercase "driftstack" wordmark** — `App.tsx:141` renders sentence-case in titlebar.
- **Slate base palette** — slate-950 to slate-400, no hardcoded hex values in components.
- **Status pips** — green/yellow/red traffic-light semantic colours via `.status-pip` class.

**Gap:** None.

**Priority:** **None** — already locked.

## Section 14 — Endpoint contracts the GUI needs

The audit surfaced one cross-cutting question for PHASE 2 P0 work on tier-aware enforcement (Section 8): **what endpoint returns the calling account's tier + concurrent-session cap?**

Possibilities:

- `/v1/sessions GET` already returns the active list; could be augmented with cap + tier in the response envelope.
- `/v1/account` — exists? Need to verify in `apps/server/src/routes/`.
- A new `/v1/account/me` or `/v1/account/limits` endpoint.

If the existing surface doesn't expose this, **the contract addition needs to happen in `apps/server` first** (Tier-1 backend work), then `@driftstack/sdk` regen, then GUI consumption. Per autopilot guardrails: "GUI client connects to driftstack-api endpoints — if new endpoints needed, add them in apps/server first with proper auth/scope, then consume from gui-client."

**P0 dependency chain:**

1. Verify whether `/v1/account` or equivalent exists. If yes, confirm response includes tier + concurrent cap.
2. If not, add minimal `/v1/account/me` endpoint returning `{ tier, concurrent_cap, profiles_used, profiles_cap }`.
3. Wire SDK accessor.
4. Consume in GUI's SessionsView.

## P0 launch-blocking summary

Two concrete P0 items + one cross-cutting backend dependency:

| #   | Item                                     | Estimated effort             | Backend dep                                           |
| --- | ---------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| 1   | Profile create form modal                | ~1-2hr Tier-1                | None (`/v1/profiles POST` exists)                     |
| 2   | Tier-aware enforcement display           | ~2-3hr Tier-1                | Verify `/v1/account` shape; may need backend addition |
| 3   | Backend: confirm or add `/v1/account/me` | ~1hr Tier-1 in `apps/server` | Blocks #2                                             |

Recommended PHASE 2 order:

1. **Section 14 / Item 3 first** — verify the endpoint shape; if missing, land in `apps/server` with proper auth + tests + SDK regen.
2. **Item 1 (profile create form)** — independent of backend, can ship in parallel.
3. **Item 2 (tier-aware enforcement)** — depends on #3.

## P1 launch-recommended summary

| #   | Item                                          | Estimated effort |
| --- | --------------------------------------------- | ---------------- |
| 1   | `rust-toolchain.toml` pin                     | ~5min            |
| 2   | Self-hosted titlebar label conditional on URL | ~30min Tier-1    |

## P2 post-launch summary

- WebRTC streaming (depends on file 36 server-side architecture work).
- Auto-update mechanism (Sparkle / Tauri Updater / GitHub Releases).
- First-run setup wizard (cloud vs self-hosted choice).
- Various UX polish (loading states, error-recovery copy, etc.).

## T3 founder-ack-required surfaces

- **API key at-rest storage** — keychain vs encrypted file vs plaintext + acknowledged. Customer-data architecture decision.
- **Telemetry posture** — cloud-reports-to-Sentry vs self-hosted-no-reporting vs both-with-opt-in. Customer-data + product decision.
- **Distribution mechanism** (when reaching PHASE 3) — signed `.dmg` / Sparkle / GitHub Releases / etc.

These three need founder verdicts before autonomous PHASE 2 work touches them. Drafts will be surfaced in `docs/proposals/` when each P-item lands at the relevant boundary.

## Conclusion

The GUI client is in much better shape than the founder direction's checklist suggested. Sessions / profiles (read+delete) / proxies / recordings / connectivity / settings are live against real API endpoints; brand + anonymity are locked; auth + storage paths work. The launch-blockers are narrow:

- **Profile create form** (~1-2hr UX work).
- **Tier-aware enforcement** (~2-3hr GUI + maybe ~1hr backend if endpoint missing).

PHASE 2 starts with Section 14 endpoint verification, then ships items 1 + 2 in P0 close-out. T3 surfaces (key storage, telemetry, distribution) get founder-ack drafts as they're reached.
