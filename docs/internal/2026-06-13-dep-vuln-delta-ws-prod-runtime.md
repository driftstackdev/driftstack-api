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

Tried **three** minimal approaches; **all left the prod-path `ws` unfixed or the lockfile
inconsistent**, so each was cleanly reverted:

1. Root `"overrides": { "ws": "^8.20.1" }` + `npm install` → only bumped the jsdom-path `ws`
   to 8.21.0; the **server / `@fastify/websocket` deduped `ws` stayed at 8.18.0** (vuln NOT
   cleared).
2. Also bumping the `apps/server` direct devDep range to `^8.20.1` + `npm install` → npm
   left `ws@8.18.0 deduped **invalid**: "^8.20.1"` (declared range unsatisfied by the resolved
   version — a broken lockfile state).
3. (2026-06-13, 3rd attempt) Canonical single-dep bump `npm install ws@^8.21.0 -w apps/server`
   → created a SECOND `ws@8.21.0` for the apps/server direct devDep but kept the
   `@fastify/websocket` transitive at `ws@8.18.0` (it only needs `^8.16.0`, satisfied by 8.18.0,
   so npm won't move the deduped/hoisted copy). The vuln path was still 8.18.0; advisory still
   present.

**Incremental fixes are exhausted** — `npm install` will not re-dedupe the already-hoisted
`ws@8.18.0` that `@fastify/websocket` transitively pins.

**⚠️ 4th attempt (2026-06-13, bounded experiment, cleanly reverted) — `overrides:{ws:^8.20.1}` +
full regen ALSO FAILS, AND storms.** Ran `overrides:{ws:^8.20.1}` + `rm package-lock.json &&
npm install`: (a) produced a **101-package version-change storm** (1555/4628 lockfile lines) — far
too broad to ship autonomously; AND (b) the advisory was **STILL present** — `npm ls ws` still
showed `ws@8.18.0 deduped` in the `@fastify/websocket` path (only the jsdom path moved to 8.21.0).
So a top-level `overrides:{ws:...}` does NOT force the deduped transitive even on a clean regen.
**Conclusion: the ws fix is NOT autopilot-able via override/regen — both ineffective AND storming.**

## Recommended fix (HUMAN-reviewed dep PR — not autopilot)

The cleanest real fix (try first): **bump `@fastify/websocket`** to a release whose own `ws`
dependency floor is ≥ 8.20.1 (`npm view @fastify/websocket versions` + check its `dependencies.ws`)
— that moves the transitive naturally without a forced override. If no such release exists, use the
**nested override** form `overrides: { "@fastify/websocket": { "ws": "^8.21.0" } }` (scopes the
override to the consumer, which the flat form failed to do), regenerate, and confirm
`npm ls ws` shows NO `8.18.0`. Either way:

1. `npm audit --omit=dev --workspace apps/server` no longer flags `ws`.
2. Review the regen/diff (the flat-override regen stormed 101 packages — a scoped fix should be far
   smaller; review whatever churn remains).
3. Full local suite (`npm test`) green, push as its own isolated commit (fetch immediately before
   push to avoid a parallel-writer lockfile conflict). Fold in the build-time `esbuild` HIGH then.

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
