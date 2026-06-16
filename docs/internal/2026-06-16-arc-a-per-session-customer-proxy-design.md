# ARC A — per-session customer-proxy resolution (design / implementation plan)

Status: **DESIGN — awaiting founder go + the product/security decisions in §6.**
Author: Driftstack · 2026-06-16 · Scope: Agent 2 (server + SDK + GUI).

## 1. The gap (verified in code)

A dispatched agent-session browses through a **single operator-static** SOCKS5
proxy:

- `apps/server/src/routes/agent-sessions.ts:382` — `SessionDispatchConfig.proxy: SocksProxyConfig`.
- `:504` — the dispatch injects `inlineProxyConfig: sessionDispatch.proxy` (the one
  static operator proxy), wired only on the local fleet-demo stack, inert in prod.

Customer proxies exist **only client-side** today: `apps/gui-client/src/lib/proxies.ts`
(Tauri store) + `parse-proxy.ts` + `proxy-probe-cache.ts`. There is **no** server-side
customer-proxy storage (`db/schema.ts` has no proxy-creds table — only `quic_route`),
**no** per-session proxy field on session-create, and **no** dispatch-time resolution.

So a customer cannot say "run THIS session through MY proxy." That is ARC A.

## 2. Why this needs design before code

Proxy credentials (host/port/**username/password**) are secrets. Storing them
server-side crosses the **cross-account DEK boundary** the founder explicitly flagged
("verify rigorously, esp. the cross-account DEK boundary"). Building it wrong = a
credential-leak / cross-account-read class bug on a brand-new at-rest secret. The
encryption must reuse the proven profile-key hierarchy, not invent a new path.

## 3. Proposed design

### 3a. Storage — reuse the profile-DEK hierarchy

New table `account_proxies` (migration, hand-authored idempotent SQL per
[[project_drizzle_migrations_handauthored_not_generated]]):

| column           | type        | notes                                                                       |
| ---------------- | ----------- | --------------------------------------------------------------------------- |
| id               | uuid pk     | `prx_<uuid>` external form                                                  |
| account_id       | uuid FK     | owner; ON DELETE CASCADE                                                    |
| label            | text        | customer-facing name                                                        |
| host, port       | text, int   | non-secret                                                                  |
| scheme           | text        | `socks5`/`http` (enum-checked)                                              |
| username         | text null   | non-secret-ish; store plain                                                 |
| wrapped_password | bytea null  | AES-256-GCM, wrapped by the account TMK (mirror `profile-key-hierarchy.ts`) |
| created_at       | timestamptz |                                                                             |

Encryption mirrors `apps/server/src/lib/profile-key-hierarchy.ts` exactly:
PROFILE_MASTER_KEY → per-account TMK (HKDF) → wrap the proxy password. **Never** return
the password over the API (mirror the BYOK/`has_key` pattern — metadata only:
`has_password: boolean`).

### 3b. API (new `/v1/account/me/proxies` surface, tag `account`)

- `GET    /v1/account/me/proxies` → list (metadata only, no secrets)
- `POST   /v1/account/me/proxies` → create (accepts plaintext password once, wraps it)
- `PUT    /v1/account/me/proxies/:id` → update
- `DELETE /v1/account/me/proxies/:id` → 204
- `POST   /v1/account/me/proxies/:id/test` → server-side reachability/auth probe (discriminated-union result, like BYOK test)

Add to the manual openapi registry (`apps/server/src/lib/openapi.ts`) + a content-parity
test for the route count. SDK lockstep (TS/Go/Python) per the cross-sdk parity guards.

### 3c. Session-create field + dispatch resolution

- Session-create accepts an optional `proxy_id` (validated owned, like `profile_id` at
  `:353-358` — reject unknown/cross-account with 404, the exact pattern strict-FK used).
- At dispatch (`:504`), if `proxy_id` is present: unwrap that account's proxy password
  (TMK), build the `SocksProxyConfig`, inject it as `inlineProxyConfig` **instead of** the
  operator-static one. Resolution happens server-side at the **owner** account scope
  (same ownerAccountId discipline as the profile DEK), so a team member launching never
  reads another account's proxy.
- Absent `proxy_id` → today's behaviour (operator/static), zero regression.

### 3d. SSRF / egress guard

The proxy host is customer-controlled → SSRF risk (point it at `169.254.169.254`,
`localhost`, internal ranges). Before dispatch, validate the host against a denylist
(loopback, link-local, RFC-1918, metadata IPs) — reuse/extend the `isAllowedNavigateURL`
host-guard class already in the webkit egress path. Fail-closed: bad host → reject the
proxy, don't dispatch through it.

### 3e. GUI wiring

`gui-client/src/lib/proxies.ts` gains an optional account-sync (mirror the per-account
org-sync arc [[project_per_account_org_sync_arc]]: server wins on load, local = offline
cache). Session launch can pass the chosen `proxy_id`. Keep client-side proxies working
offline; account proxies are the synced superset.

## 4. Phasing (one safe slice per fire)

1. Migration + `account_proxies` table + repo (encryption mirror) + unit tests. **No API yet.**
2. API CRUD + test endpoint + openapi + parity + 401 verification.
3. SDK lockstep (TS/Go/Python) + parity guards.
4. Session-create `proxy_id` validation + dispatch resolution + **the SSRF guard** + security tests (owner-only unwrap / cross-account 404 / SSRF-host rejection / no-password-echo).
5. GUI account-sync + launch wiring + Tauri rebuild.

## 5. Test/security bar (per the founder's DEK-boundary caution)

Each slice ships its tests in-commit. The §4.4 security suite is mandatory:
member-launches-owner-proxy (allowed, owner-scoped unwrap), non-owner-cross-account (404),
SSRF host rejected, password never echoed (GET returns `has_password` only), TMK isolation
(account A cannot unwrap account B's proxy password).

## 6. Open product/security decisions (founder)

1. **Go / no-go** on building ARC A now (it's multi-fire).
2. Confirm **server-side storage of customer proxy passwords** is wanted (vs keeping them
   client-only forever). This is the crux — it creates a new at-rest secret class.
3. SSRF denylist scope — block RFC-1918/loopback/metadata by default? (Recommended yes;
   a self-hosted customer proxying to their own LAN is the only legit counter-case →
   make it a config flag, default-strict.)
4. Per-session vs per-profile proxy binding (or both)? This plan does per-session
   (`proxy_id` on create); a per-profile default could layer on top later.
