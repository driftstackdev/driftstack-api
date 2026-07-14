# 2026-05-31 — `PERMISSIVE_CORS=true` is live in production (Agent 2)

**Status: RESOLVED 2026-07-14.** The six-origin production allow-list was completed
and production was verified with `PERMISSIVE_CORS=false` on 2026-06-05. The
remaining latent regression path is now closed in code: bootstrap refuses to
start when `PERMISSIVE_CORS=true && NODE_ENV=production`. Development and test
retain the documented WebView escape hatch.

The sections below preserve the original incident evidence and sequencing
rationale. At the time, refusing boot before the allow-list repair would have
broken status/admin. That prerequisite is now fulfilled.

## Confirmed (empirical) — prod reflects ANY origin with credentials

```
$ curl -sI -X OPTIONS https://api.driftstack.dev/v1/account \
    -H 'Origin: https://attacker.test' -H 'Access-Control-Request-Method: GET'
access-control-allow-origin: https://attacker.test
access-control-allow-credentials: true
```

Any website gets `Access-Control-Allow-Origin: <itself>` + `…-Allow-Credentials:
true` from the production API. That is the textbook unsafe CORS combination.

## Root cause (confirmed on the server)

`apps/server/src/lib/app.ts:631` registers `@fastify/cors` with
`origin: deps.permissiveCors === true ? true : [<allow-list>]` + `credentials:
true`. `deps.permissiveCors` is `process.env.PERMISSIVE_CORS === 'true'`
(`bootstrap.ts`). The prod env file `/opt/driftstack/api/.env` has:

```
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://app.driftstack.dev,https://driftstack.dev,https://www.driftstack.dev,https://docs.driftstack.dev
PERMISSIVE_CORS=true        ← the dev/webview escape hatch, left ON in prod
```

So a correct allow-list IS configured, but `PERMISSIVE_CORS=true` shadows it with
`origin: true` (echo-any). The flag is documented (`bootstrap.ts:1371`) as opt-in
"because it widens the CSRF surface" — it was meant for dev/Tauri-webview Origin
variants, not production.

## Severity: MEDIUM (latent-CRITICAL)

Today's exploitability is **limited** because the API authenticates with a **bearer
token**, not an ambient cookie: `middleware/auth.ts` reads the token from the
`Authorization` header (or `?ds_token=` for SSE) only — there is no cookie-based
auth for data routes. A cross-origin attacker page cannot read the victim's
`Authorization` token (it lives in the dashboard origin's localStorage, unreadable
cross-origin), and the cookies that `credentials:true` _does_ send (the path-scoped
`ds_oauth_pkce` handshake cookie; any web-session cookie) are not accepted as auth
for data endpoints. So evil.com cannot steal authed data or perform authed CSRF
right now — it can only read responses to **unauthenticated** requests (already
public) and send non-auth cookies.

**Latent-CRITICAL:** the CORS comment claims `credentials: true` is "required by the
customer dashboard's cookie-based session (Article-13 auth)" — but the middleware is
bearer-only, so either that cookie session is vestigial or planned. **If any data
route is ever switched to accept the session cookie as auth, this misconfiguration
becomes full cross-origin account-data theft + CSRF.** Fix it before that happens,
and reconcile the misleading comment.

## Why a blind `PERMISSIVE_CORS=false` flip BREAKS prod

The configured allow-list is **incomplete** — the permissive flag was masking that:

- `apps/status-site/src/pages/incident.astro` + `subscribe.astro` fetch
  `api.driftstack.dev` from the browser, but **`https://status.driftstack.dev` is NOT
  in `CORS_ALLOWED_ORIGINS`** → incident reads + email subscribe would CORS-break.
- `apps/admin-panel/src/lib/api-base-url.ts` → the admin SPA calls the API, but
  **`https://admin.driftstack.dev` is NOT in the list** → admin panel would break.

## Remediation (founder / focused session — outward-facing prod change)

1. Complete `CORS_ALLOWED_ORIGINS` to the full first-party browser-origin set:
   `https://app.driftstack.dev, https://driftstack.dev, https://www.driftstack.dev,
https://docs.driftstack.dev, https://status.driftstack.dev,
https://admin.driftstack.dev` (the GUI's `tauri://localhost` + `localhost` are
   already hardcoded regexes in the non-permissive branch). Confirm this is the
   complete set of web properties that call the API from a browser.
2. Set `PERMISSIVE_CORS=false` (or remove it) in `/opt/driftstack/api/.env`; restart.
3. Verify: each of the 6 origins above gets reflected `ACAO`; `https://evil.test`
   gets **no** `ACAO`; service healthy; dashboard + admin + status + GUI all still
   work.
4. Then it is safe to deploy a stronger code guard that **forces non-permissive in
   production** (refuse/ignore `PERMISSIVE_CORS=true` when `NODE_ENV=production`).
   Doing that BEFORE step 1 would break status/admin; doing a refuse-to-boot would
   crash prod — hence the warn-only guard shipped now (below).

## Original warn-only mitigation (superseded 2026-07-14)

`apps/server/src/lib/cors-posture.ts` `corsPostureWarning(permissiveCors, nodeEnv)`

- `cors-posture.test.ts`, wired into `bootstrap.ts` so boot logs an **error-level
  warning** when `PERMISSIVE_CORS=true && NODE_ENV=production`. Behavior is unchanged
  (non-breaking); the misconfiguration is now loud in logs/Sentry instead of silent —
  which is exactly what let it ship unnoticed. The behavior fix waits on step 1.

Recorded in memory `project_permissive_cors_in_prod`.

## Final fail-closed guard (2026-07-14)

`assertCorsPosture()` uses the same audited truth table but throws the existing
non-secret diagnostic for permissive production. Bootstrap invokes it before
constructing the serving app. A single environment regression can therefore no
longer shadow `CORS_ALLOWED_ORIGINS` and continue serving arbitrary-origin
credentialed CORS. Pure tests cover all four meaningful production/dev/test
pairs and a structural guard pins the bootstrap dependency.
