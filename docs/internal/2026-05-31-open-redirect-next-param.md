# 2026-05-31 — Open-redirect via `?next=` in the customer-dashboard sign-in (Agent 2)

**Status: login + signup + verify-email all FIXED; only the API `/start`
defense-in-depth REMAINS.** Real MEDIUM open-redirect (phishing aid) in the
customer dashboard. The hard part — a robust, behaviourally-tested same-origin
sanitizer — is done and shipped:
`apps/customer-dashboard/src/lib/safe-next.ts` (`safeNextPath`, URL-parser-based)

- `tests/unit/safe-next.test.ts` (bypass coverage, incl. the non-obvious
  `//`-pathname case the tests caught vs a naive `startsWith('/')`). All three
  dashboard auth pages now sanitize `?next=` through it (inline copy — the
  `<script is:inline define:vars>` block can't import — pinned to the lib in each
  page's content-parity test). The only remaining item is the API `/start`
  `redirect_to` defense-in-depth (below).

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

### Remaining (single item)

API `/start` `redirect_to: z.string().url()` — restrict server-side to
`dashboardOrigin` so a forged client can't pass an off-origin `redirect_to`. This
is the last defense-in-depth layer; the client now always sends a same-origin
value, so it's belt-and-suspenders, not an open hole.

## Confirmed vuln

`apps/customer-dashboard/src/pages/login.astro`:

- `const next = params.get('next')` (line 173) — raw, unsanitized, the only `next`
  definition (in scope for all uses below).
- On successful password login: `window.location.href = next ? next : '/'`
  (line 240) — navigates to the **raw** `next`.

So `https://app.driftstack.dev/login?next=https://evil.com` → victim signs in to
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
