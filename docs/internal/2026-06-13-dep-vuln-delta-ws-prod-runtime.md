# Dependency vuln delta — `ws` moderate (prod-runtime) — surfaced 2026-06-13

**Status:** SURFACED. A clean autonomous fix is blocked by an npm-workspaces dedup quirk
(detail below) → needs a deliberate dep-maintenance pass. Attempted + cleanly reverted this
wave (no lockfile change shipped).

**Severity:** MODERATE, and currently **LOW active exposure** — the prod-runtime consumer
(fleet-events WebSocket) is `FLEET_CONTROL_PLANE_ENABLED`-gated and unwired in prod today.
But `ws` _will_ be exposed at go-live, so fix before launch.

## The delta

`npm audit --omit=dev --workspace apps/server` flags **`ws@8.18.0`**:

- **GHSA-58qx-3vcg-4xpx** — "ws: Uninitialized memory disclosure", affects `ws 8.0.0 – 8.20.0`.
- **Patched in `8.20.1` / `8.21.0`** (semver-compatible 8.x — no breaking change).
- `ws` is a **prod-runtime** dep: pulled transitively by `@fastify/websocket@11.2.0`
  (which requires `ws ^8.16.0`) — the library behind the fleet-events control-plane WS. It is
  also a direct devDep of `apps/server` (`"ws": "^8.18.0"`, test usage) and a transitive of
  jsdom (gui-client) + miniflare (admin-panel deploy tooling). All dedupe to one hoisted
  `ws@8.18.0`.
- **NEW since the 2026-06-12 dep CVE audit** (which covered only high/critical and the
  astro/undici deploy-tooling chain; `ws` moderate was not itemized).

## Why a clean fix is blocked (the npm-workspaces dedup quirk)

Tried two minimal approaches; **both left the lockfile inconsistent**, so I reverted:

1. Root `"overrides": { "ws": "^8.20.1" }` + `npm install` → only bumped the jsdom-path `ws`
   to 8.21.0; the **server / `@fastify/websocket` deduped `ws` stayed at 8.18.0** (vuln NOT
   cleared).
2. Also bumping the `apps/server` direct devDep range to `^8.20.1` + `npm install` → npm
   left `ws@8.18.0 deduped **invalid**: "^8.20.1"` (declared range unsatisfied by the resolved
   version — a broken lockfile state).

Incremental `npm install` refuses to re-dedupe the already-hoisted `ws@8.18.0`. The reliable
fix is a **full lockfile regen** (`rm package-lock.json && npm install`), which produces a
large diff and is unsafe to do mid-autopilot against the shared lockfile with a parallel
writer on `main`.

## Recommended fix (deliberate dep-maintenance pass, low-load + sole-writer window)

1. Set the security floor: root `overrides: { "ws": "^8.20.1" }` (canonical transitive pin),
   optionally also bump `apps/server` devDep `ws` to `^8.20.1` for clarity.
2. `rm package-lock.json && npm install` (full re-resolve) so the deduped `ws` moves to 8.21.0
   everywhere; confirm `npm ls ws` shows no `8.18.0` / no `invalid`.
3. Verify `npm audit --omit=dev --workspace apps/server` no longer flags `ws`.
4. Full local suite (`npm test`) green, then push as its own commit (large lockfile diff →
   keep it isolated, fetch immediately before push to avoid a parallel-writer lockfile
   conflict).

## Other audit findings (triage — NOT new / not prod-runtime)

- **`esbuild` HIGH** (`apps/server`, via `tsx`) — build/dev-time only. The advisories are
  RCE via `NPM_CONFIG_REGISTRY` in a **Deno** module + arbitrary file read on a **Windows
  dev server**; we run neither in prod (darwin, no Deno, no esbuild dev-server in prod) →
  effectively non-exploitable. Bump opportunistically in the same dep pass (`npm audit fix`
  covers it non-breaking).
- **`brace-expansion` MODERATE** — build-time glob; low real risk.
- **`astro` / `undici` / `wrangler` / `vite` / `miniflare` HIGHs** — the known
  **deploy/build-tooling** chain (Cloudflare static-site tooling); the server's own
  `undici@8.4.0` is NOT in the vulnerable range. Founder-deferred astro-6 migration covers
  these (see `project_server_dependency_cve_audit_clean` + the arc-state). Do NOT re-alarm.
