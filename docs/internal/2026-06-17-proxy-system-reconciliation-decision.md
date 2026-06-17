# Proxy-system reconciliation — decision doc (2026-06-17)

Agent 2. Captures a divergence found while completing the dashboard proxy
migration, and recommends how to reconcile it. **The execution touches the
public SDK contract, so this is design-first (not an autopilot rush).**

## The two proxy systems (today)

There are two parallel customer-proxy surfaces in the codebase:

### 1. Legacy "saved-proxies" (planning-133 EG-API) — STUB, never backed

- Routes: `POST/GET/DELETE /v1/proxies` (`apps/server/src/routes/saved-proxies.ts`)
  - `POST/GET /v1/sessions/:id/proxy` (`session-proxy.ts`). Both are
    **unconditional `FeatureUnavailable` (503) stubs** — the EG-API-1.6/1.7
    backend was never built.
- Body shape: **nested** — `{ label, proxy: { type, socks5|openvpn|wireguard: {…} } }`.
- **Exposed in all three SDKs in lockstep** as `EgressResource`
  (`egress.ts` / `egress.py` / `egress.go`): `SaveProxy` / `ListSavedProxies`
  / `DeleteSavedProxy` + `AttachToSession` / `GetSessionProxy`. The SDK headers
  honestly document "503 until a concrete backend is wired; surface is stable so
  consumers can compile ahead."

### 2. Live "account-proxies" (ARC A) — SHIPPED, in prod

- Routes: `GET/POST/PUT/DELETE /v1/account/me/proxies` + `POST :id/test`
  (`apps/server/src/routes/account-me.ts`). Live; secrets wrapped at rest under
  the per-account TMK; SSRF host-guarded; server-side TCP reachability test.
- Body shape: **flat** — `{ label, scheme, host, port, username?, password?,
openvpn?{…}, wireguard?{…} }`. Secrets (`password`, `config_blob`,
  `private_key`) are write-only.
- Session binding: a `proxy_id` resolved at **session create** (ARC A slice 4),
  not an attach-after-create call.
- Consumers: the desktop GUI and (as of 2026-06-17) the customer dashboard
  (`proxies.astro` + the create-profile picker in `profiles.astro`). **No SDK
  surface** — ARC A scoped it server/GUI-only.

## The problem

- The **frontend is fully on the live system**; the **SDKs only expose the
  legacy stub** (which 503s and whose backend won't ship). SDK customers have no
  way to manage the proxies that actually work.
- The two systems have **divergent body shapes** (nested vs flat) and different
  session-binding models (attach-after-create vs proxy_id-at-create).
- `/v1/proxies/*` therefore **cannot be retired** (the Go/TS/Python SDKs
  reference it — retirement would break the public SDK contract). Verified
  2026-06-17; the routes stay mounted so any compile-ahead consumer still gets a
  503, not a 404.

## Options

- **A — Add + deprecate (recommended).** Add a new `accountProxies` resource
  (the live `/v1/account/me/proxies` API: list / create / delete / test) to all
  three SDKs in lockstep, and mark the legacy `EgressResource` saved-proxies
  methods `@deprecated` (keep them — non-breaking). Two surfaces coexist until a
  future major removes the legacy one. SDK users get the real API now.
- **B — Repurpose.** Point `EgressResource` at `/v1/account/me/proxies` with the
  flat shape. Single surface, cleanest long-term, but a **breaking change** to
  method paths/bodies for any current compile-ahead consumer.
- **C — Status quo.** Leave the SDKs as the compile-ahead stub; account-proxies
  stays GUI/dashboard-only. No SDK proxy management.

## Recommendation: Option A

Non-breaking, gives SDK users the live API immediately, and leaves a clean
deprecation path. Execution (each slice gate-green, cred-careful — the SDK only
passes write-only fields; the server wraps them, so the SDK never holds secrets
at rest, same as the dashboard):

1. `accountProxies` resource + types in the **TS** SDK (list/create/delete/test;
   flat `AccountProxyInput`; `AccountProxyMetadata` responses with
   `has_password`/`has_secret`).
2. **Go** lockstep.
3. **Python** lockstep.
4. `@deprecated` doc-comments on the legacy `EgressResource` saved-proxies
   methods pointing at the new resource; update the SDK headers.
5. Cross-SDK parity guards + per-SDK content-parity updates in-commit.
6. (Optional) accept `proxy_id` on the SDK session-create body if not already,
   so the live session-binding path is reachable from the SDK; deprecate
   `AttachToSession`/`GetSessionProxy`.

## Status / gate

- Frontend migration: **DONE + prod-verified** (commits 0c0d2310, 7904ce15,
  d88aa078 — dashboard proxies.astro all 3 schemes + the create-profile picker).
- This reconciliation: **needs the A-vs-B call** (public SDK contract). Founder
  greenlit "do all as recommended" 2026-06-17 → Option A is the default to
  execute unless directed to B. Sequence as the slices above across focused
  fires; do NOT bundle a breaking contract change into a routine wave.
