# Local self-serve watch stack — runbook

Bring up the local stack so the founder opens the gui-client, **creates a
profile, and watches that session stream live**. Server-side dispatch is fully
merged (`2de1b5ac` primitive → `17ec0f37` route caller → `885d0561` activation);
this is the local bring-up + the one node-seed row.

LOCAL DEV ONLY — never run against prod. The dispatch path is gated by
`FLEET_CONTROL_PLANE_ENABLED`, which stays OFF in production.

## Components

| Component        | How                                                                | Owner   |
| ---------------- | ------------------------------------------------------------------ | ------- |
| LiveKit `--dev`  | `livekit-server --dev` (ws://localhost:7880, devkey/secret)        | A3 (up) |
| gost SOCKS5      | `gost -L socks5://:1080`                                           | A3 (up) |
| Postgres + Redis | local dev services (DATABASE_URL / REDIS_URL)                      | A2      |
| API server       | `:3000`, `FLEET_CONTROL_PLANE_ENABLED=true` + `MFA_ENCRYPTION_KEY` | A2      |
| Seed node row    | `seed-local-fleet-node.ts` (below) → prints the node uuid          | A2      |
| Harness daemon   | `DriftstackHarnessd` with `DRIFTSTACK_MAC_NODE_ID=<uuid>`          | A3      |
| gui-client       | Tauri app pointed at `http://localhost:3000`                       | Founder |

## Steps

1. **A2 — seed the harness node row** (mints the uuid the daemon must use):

   ```sh
   DATABASE_URL=postgres://localhost/driftstack \
   MFA_ENCRYPTION_KEY=<base64 32-byte key> \
   FLEET_NODE_PUBLIC_KEY_BASE64URL=w_vAYfR1QbAEp-ZjiGRorRj4T265Zey2n2lzzg7lg8o \
   npx tsx apps/server/src/scripts/seed-local-fleet-node.ts
   ```

   Note the printed `node uuid`. (The pubkey above is A3's W296 key; LiveKit
   creds default to devkey/secret/ws://localhost:7880.)

2. **A2 — run the API server** on `:3000` with the SAME `MFA_ENCRYPTION_KEY`,
   `FLEET_CONTROL_PLANE_ENABLED=true`, and the local LiveKit env. Bootstrap then
   constructs the `FleetControlRegistry` + the demo `sessionDispatch` config
   (archetype `iphone16pro_ios18_6_safari18_6`, `https://example.com`, local gost
   proxy with `udp_associate:true`).

3. **A3 — run the daemon** pointed at the local CP, using the uuid from step 1:

   ```sh
   DRIFTSTACK_NODE_SIGNING_KEY_PATH=~/.driftstack/node-dev.b64 \
   DRIFTSTACK_CONTROL_ENDPOINT=ws://localhost:3000/v1/fleet/events \
   DRIFTSTACK_MAC_NODE_ID=<uuid-from-step-1> \
   DRIFTSTACK_REQUIRE_PROXY=1 \
   .build/debug/DriftstackHarnessd
   ```

   It connects-as-node over the fleet-events WSS (the registry now has it).

4. **Founder — gui-client → create a profile → start a session.** session-create
   dispatches the `sessionAssign` to the connected node; the harness spawns the
   fork (browses example.com through gost), captures, and publishes. The
   gui-client's `AgentSessionPanel` subscribes via the session's `livekit` block
   → **the founder watches it live.**

## Notes

- **nodeId is the minted uuid, not a chosen string** — `fleet_nodes.id` is a
  uuid; A3's daemon `iss`/header must equal it (W163).
- v0 dispatch = on-create, only if the node is connected (no queue; A3 W298).
- Interactive control (click/type) is still item-9-gated — this is passive watch.
- To tear down: stop the daemon + server; the node row can stay (idempotent
  re-runs would create duplicates, so seed once).

---

## Current state (2026-06-08) — STREAMING GREEN + ops notes

Streaming is verified working end-to-end: a dispatched agent-session spawns the
fork → loads its page through the proxy → captures → publishes a LiveKit video
track (`num_publishers=1`), egressing through the founder's upstream SOCKS5. Both
A2 (dispatch + sessionEnd + viewer) and A3 (W428 publish-ordering fix + W435
capture warm-up) verified it; A3 W450 conceded the earlier "blank page" theory
was a non-authoritative standalone-probe artifact (real daemon sessions load
pages — proven via the gost egress log: `example.com:443`, `webkit.org` 851 KB).

### Watch it (self-serve)

```sh
bash scripts/watch-live.sh --open
```

Creates a fresh agent-session, waits for the track, writes + opens
`/tmp/watch-live.html`. Re-run anytime (sessions idle-reap ~5 min). Needs
`DRIFTSTACK_DEMO_API_KEY` (a read+write key) in the gitignored repo-root `.env`.

### Egress proxy (the founder's upstream SOCKS5)

`scripts/demo-egress-gost.sh` runs `gost -L socks5://:1080 -F socks5://<upstream>`
(chained to the founder's working SOCKS5; creds only in gitignored `.env`
`DRIFTSTACK_DEMO_SOCKS5_*`). The server's session dispatch + the daemon both use
`127.0.0.1:1080`, so all egress routes through the real upstream with no
component holding the creds. Re-run if the chained gost dies.

### ⚠️ Gotchas (learned the hard way)

- **A `:3000` server restart KILLS the harness daemon** — its WSS drops and it
  exits (no auto-reconnect). After ANY server restart you MUST relaunch the
  daemon. **Do not restart the server casually while the demo is live.**
- **Daemon relaunch recipe** (harness domain; founder-authorized for A2):
  ```sh
  cd harness
  set -a; source ../operations/scripts/production-env/launch-env-v1.sh; set +a   # fork __XPC_ vars + hooks
  export DRIFTSTACK_SOCKS5_PROXY=127.0.0.1:1080                                    # local gost (NOT the dead external)
  unset DRIFTSTACK_SOCKS5_USER DRIFTSTACK_SOCKS5_PASS                              # gost has no upstream auth
  nohup bash scripts/run-self-serve-daemon.sh a74c2abf-c4fd-4562-9975-87e875d26db9 >/tmp/daemon.log 2>&1 &
  ```
  (binary is already the fixed build `d85d6b2a`; node id `a74c2abf-…`.)
- **Archetype is pinned to `iphone16pro_ios18_6_safari18_6`** — the daemon runs
  BUNDLED static archetypes only (`DRIFTSTACK_ARCHETYPE_DIR` unset), so 18.7 /
  iphone17 do NOT load (dispatch reaches the node but the session never starts).
  Exposing more archetypes needs the daemon launched with `DRIFTSTACK_ARCHETYPE_DIR`
  pointed at `reference/` (or 18.7/17 bundled) — harness config, not server config.

### Remaining (not demo blockers)

- **GUI archetype expansion** (A1-cleared iphone16pro_18.7 + iphone17): blocked on
  the daemon `DRIFTSTACK_ARCHETYPE_DIR` above + a prod-safe GUI launch path.
- **Profile-backed persistent state** (cookie restore/save): founder DEK decision
  (host-key-envelope-now vs KMS-later; A2 recommends host-key-now — server side built).

## GUI finish-line status (updated 2026-06-08, founder away)

After the reboot (which cleared the LaunchServices corruption — see below), the
desktop GUI **works in dev mode** (`npm run tauri:dev`): renders, authenticates,
polls `/v1/profiles` + `/v1/sessions`, and launches sessions. Tracking the four
items the founder flagged (W232):

- **(a) Stretched stream view — ✅ FIXED + drift-guarded** (`24b3eac4`, guard
  `b2ff0acf`). `AgentSessionPanel` container was `w-full` + portrait aspect →
  height = width × 2.17 on a wide window. Now `h-full max-h-full max-w-full` +
  aspectRatio → fills height, narrow portrait width, centered; `object-contain`
  video. Visual confirmation still pending a founder session-watch.
- **(b) Release `.app` webview-paint bug — OPEN, dev-mode is the workaround.**
  The installed `.app` runs perfectly (process alive, polls data — server log
  proves it) but the window doesn't composite (black, no error). Dev mode paints
  fine → release-bundle-specific. NEXT (needs eyes-on, hence deferred while away):
  build current `main` (the `base:'./'` experiment is reverted) as a release
  `.app`, reinstall, **delete the keychain item** (so the setup screen shows with
  no prompt), launch, screenshot — if the setup screen paints, the paint bug is
  resolved; if still black it's a deeper WKWebView compositing issue.
- **(c) Keychain re-prompt per build → store local key in settings.json.**
  CONFIRMED this needs Rust: the key is stored via the `keyring` crate
  (`src-tauri/src/lib.rs` `secret_save`/`secret_load`/`secret_delete`), invoked
  from `src/lib/settings.ts`. PLAN (founder-go gated — security-model change +
  needs a launch to verify, so not auto-shipped while away): make storage
  conditional on deployment — for **self-hosted/localhost** baseUrls store the key
  in the tauri-plugin-store `settings.json` (plaintext; acceptable for a local dev
  key, ends the per-build prompt); for **cloud** (`api.driftstack.dev`, `ds_live_`
  keys) KEEP the `keyring` path (encrypted). Touch points: a
  `useKeychainForBaseUrl(baseUrl): boolean` predicate in settings.ts; branch
  `loadSettings`/`saveSettings`/the migration on it; the Rust `secret_*` commands
  stay for the cloud path. Tradeoff to confirm: plaintext local key in
  `~/Library/Application Support/dev.driftstack.gui/settings.json` vs the recurring
  prompt. (The prompts were largely amplified by repeated rebuild churn — with a
  stable build it's one "Always Allow" per build.)
- **(d) In-app dev logs / stability.** The release build is silent (no logger).
  Options: (1) `tauri-plugin-log` + `@tauri-apps/plugin-log` `attachConsole()` →
  webview console to a logfile + stdout (robust, but Rust dep + capabilities +
  launch-verify); (2) a pure-JS console/error ring-buffer in a toggleable in-app
  panel (no Rust; unit-testable; needs UI + launch-verify). Either is a
  founder-present build wave.

**Root cause of the whole GUI saga (for the record):** repeated local rebuilds
each got a fresh ad-hoc code signature → keychain ACL re-prompts + `ditto`/
`lsregister` polluted LaunchServices (~20 duplicate `Driftstack.app` registrations
incl. dangling `/Volumes/dmg.*`) → `-600` won't-activate / black window. A reboot
rebuilds LaunchServices clean. PREVENTION: build with `tauri build --bundles app`
(no DMG mount→register→dangle cycle), reinstall ONCE, don't churn rebuilds.
