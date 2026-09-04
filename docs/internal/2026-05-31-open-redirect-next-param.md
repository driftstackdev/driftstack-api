# 2026-05-31 — Open-redirect via `?next=` in the customer-dashboard sign-in (Agent 2)

**Status: CLASS FULLY CLOSED.** All four dashboard nav sites
(login + signup + verify-email + the OAuth-client callback page) sanitize the
user-/server-supplied redirect through `safeNextPath`, AND the API `/start`
endpoint now rejects off-origin `redirect_to` at the source. Real MEDIUM
open-redirect (phishing aid) in the customer dashboard. The hard part — a robust,
behaviourally-tested same-origin sanitizer — is shipped:
`apps/customer-dashboard/src/lib/safe-next.ts` (`safeNextPath`, URL-parser-based)

- `tests/unit/safe-next.test.ts` (bypass coverage, incl. the non-obvious
  `//`-pathname case the tests caught vs a naive `startsWith('/')`). Every
  dashboard page that navigates a `next`/`redirect_to` value now sanitizes through
  it (inline copy — the `<script is:inline define:vars>` block can't import —
  pinned to the lib in each page's content-parity test).

## FIXED — wave 15 (oauth-client callback page + API `/start` source-level guard)

A **4th nav site was missed in the original audit**:
`apps/customer-dashboard/src/pages/auth/oauth-client/callback.astro:105` did
`window.location.href = body.redirect_to || '/'` — navigating the **raw**
server-returned `redirect_to`. `/start` accepts any `z.string().url()` and
round-trips that value through the (HMAC-signed) OAuth state into the callback
JSON, so a forged `/start` call (the route is unauthenticated, IP-gated only) could
mint an authorize URL whose post-sign-in landing bounces a user off-site. Closed on
both layers:

- **client** — callback.astro now navigates `safeNextPath(body.redirect_to,
window.location.origin)` (inline copy; pinned in
  `customer-dashboard-pages-callback-content-parity`).
- **server (source-level)** — `/start` now rejects off-origin targets:
  `if (new URL(parsed.data.redirect_to).origin !== new URL(deps.dashboardOrigin).origin)
throw new BadRequestError(...)`. The schema stays `z.string().url()` (OpenAPI +
  api-types unchanged); the check is a runtime guard in the handler. Pinned in
  `routes-auth-oauth-client-content-parity` + a new off-origin-rejection +
  same-origin-deep-path integration case in `auth-oauth-client.test.ts`.

Build-verified (callback page prerenders; sanitizer + sanitized nav both in the
rendered dist HTML). **No remaining items in this class.**

## FIXED — wave 14 (signup.astro + verify-email.astro)

Both pages now carry the inline `safeNextPath` copy and route every `?next=`
through it. Build-verified (both pages prerender; all four sanitizer sites present
in the rendered dist HTML) and pinned across 7 content-parity test files.

- **verify-email.astro** — post-verify nav was `window.location.href = next ? next
: '/welcome'` (raw). Now `const rawNext = params.get('next'); const next =
safeNextPath(rawNext, origin); window.location.href = rawNext ? next : '/welcome'`
  — gated on the RAW presence so the `/welcome` first-time-onboarding fallback is
  preserved, but the value navigated is the sanitized same-origin path.
- **signup.astro** — three sites: (1) the `/login?next=` fallback-link forward now
  `encodeURIComponent(safeNextPath(nextRaw, origin))`; (2) the verify-email forward
  `verifyUrl = rawNext ? '/verify-email?next=' + encodeURIComponent(next) :
'/verify-email'`; (3) the OAuth `redirect_to` is now `origin +
safeNextPath(params.get('next'), origin)` — origin-prefixed (matches login.astro,
  satisfies the API `/start` `z.string().url()`) AND sanitized (defense-in-depth;
  the bare-relative form would 400 the API).

### Remaining

**None — class fully closed (wave 15).** The API `/start` `redirect_to`
source-level restriction (previously listed here as the last item) shipped this
wave alongside the callback-page fix.

## Confirmed vuln

`apps/customer-dashboard/src/pages/login.astro`:

- `const next = params.get('next')` (line 173) — raw, unsanitized, the only `next`
  definition (in scope for all uses below).
- On successful password login: `window.location.href = next ? next : '/'`
  (line 240) — navigates to the **raw** `next`.

So `https://app.driftstack.io/login?next=https://evil.com` → victim signs in to
the real dashboard → is bounced to `https://evil.com`. Classic phishing aid: the
victim trusts the real login domain, then lands on an attacker page (e.g. a fake
"session expired, re-enter password"). MEDIUM (open-redirect; not auth-bypass — the
real session token stays in the real origin's localStorage, line 236).

Note: the OAuth path's `redirect_to: window.location.origin + (next ? next : '/')`
(line 266) is already SAFE — the `origin +` prefix keeps it same-origin
(`origin + 'https://evil.com'` is a malformed same-origin URL, not evil.com). Only
the raw `window.location.href = next` at line 240 is exploitable.

## Scope (the `next` / `return_to` class)

- **login.astro:240** — CONFIRMED (above).
- **signup.astro** — `params.get('next')` at 167 / 266 / 289 (raw); same pattern,
  needs audit + the same fix (likely navigates raw `next` post-signup).
- **DashboardLayout.astro** (169 `location.replace(u.toString())`, 885/1033
  `window.location.href = …`) and **index.astro:291** (`/login?return_to=`+ret) —
  AUDIT: index navigates to a relative `/login?...` (looks safe); the layout sites
  navigate computed values — confirm none navigate a raw user-controlled param.

## Fix design (robust — do NOT use a regex)

Add a shared same-origin sanitizer and use it at EVERY raw `next`/`return_to`
navigation:

```js
function safeNextPath(next) {
  if (typeof next !== 'string' || next.length === 0) return '/';
  try {
    const u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin) return '/'; // off-origin → drop
    return u.pathname + u.search + u.hash; // same-origin relative
  } catch {
    return '/';
  }
}
```

Use the browser URL parser (not a regex) so it neutralises every bypass:
`//evil.com`, `https://evil.com`, `https:evil.com`, `/\evil.com`, `\/\/evil.com`,
`%2f%2fevil.com`, tab/newline tricks, etc. Apply at login.astro:240 (and 266 stays
correct since the input is already sanitized), signup.astro's navigations, and any
confirmed layout/index site. Preserve legit RELATIVE round-trips (e.g.
`?next=/cli/authorize?…` from the V-267 deep-link).

**Tests:** jsdom regression per page — assert `?next=https://evil.com` (and the
bypass variants above) all fall back to `/`, while `?next=/sessions` is honoured.
Update the login/signup content-parity pins
(`customer-dashboard-pages-login-content-parity`,
`dashboard-signup-login-pages-parity`) — the `window.location.href = next ? next
: '/'` pin (login test :78) must change to the sanitized form.

Recorded in memory `project_open_redirect_next_param`.
