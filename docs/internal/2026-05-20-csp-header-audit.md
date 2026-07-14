# CSP + security-header audit (2026-05-20)

## Trigger

TIER 5 backlog slice per FULL AUTOPILOT directive: "Audit
Content-Security-Policy headers in admin panel + customer
dashboard."

## Method

1. Grep `apps/*/public/_headers` for existing CDN-edge header
   configs.
2. Grep `Content-Security-Policy` / `X-Frame-Options` /
   `Referrer-Policy` across the codebase to find both
   set-points and explicit not-set documentation.
3. Per-surface review: which security headers belong on each
   surface based on its content type + rendering posture.

## Findings

### Marketing site + docs site — already have basic headers

`apps/marketing-site/public/_headers` + `apps/docs/public/_headers`
both set on every path:

```text
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

No CSP. Documented in `apps/docs/src/pages/deployment/cdn-strategy.md`
as "CSP for the marketing site is a separate piece of work (V-TBD)".

### API server — explicit no-CSP-by-design

`apps/marketing-site/src/pages/docs/api-security-headers.astro:128`
documents the position: "Driftstack serves no HTML — every endpoint
returns JSON, plain text, CSV, or PDF. CSP would be a no-op." This
is correct; CSP scopes script-src etc. which don't exist in a JSON
response body.

The integration test `apps/server/tests/integration/security-headers.test.ts`
explicitly asserts the API returns no CSP header.

### Customer dashboard + admin panel — GAP (closed in this commit)

**Prior state:** NO security headers on either surface. Both apps
deploy to Cloudflare Pages via the Astro Cloudflare adapter
(`_worker.js` in `dist/`); the `public/` folder has no `_headers`
file. This means customer-facing pages rendering account info / API
keys / billing / audit logs / proxies had no:

- `X-Frame-Options` → clickjacking surface (any site can iframe the
  dashboard + overlay invisible buttons over revoke / pay / delete).
- `X-Content-Type-Options` → MIME-sniffing surface (avatar
  presigned-URL responses could be re-interpreted as HTML).
- `Referrer-Policy` → outbound clicks leak the full path of the
  current dashboard page in `Referer:`.
- `Permissions-Policy` → no explicit deny on camera / mic /
  geolocation / payment / USB — APIs the dashboard never needs.

**Closed in this commit** by adding `_headers` files to:

- `apps/customer-dashboard/public/_headers`
- `apps/admin-panel/public/_headers`

Both set:

```text
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
```

Plus existing cache headers retained.

### Content-Security-Policy — DEFERRED (real work + risk)

CSP belongs on the dashboard + admin panel but adding it without
care risks breaking the page. Pre-launch state:

- **Inline scripts:** every dashboard page uses Astro
  `<script is:inline define:vars={...}>` blocks. CSP `script-src`
  would need either:
  - `'unsafe-inline'` — defeats the entire point of CSP for scripts.
  - per-script nonces via Astro CSP middleware (V-TBD; doesn't
    exist today).
  - hash-based allowlist — brittle, every script change requires
    re-hashing.
- **Sentry CDN:** `@sentry/astro` injects script + connect endpoints
  to `*.ingest.de.sentry.io`. CSP must allowlist these.
- **Stripe portal redirect:** the billing page redirects to
  `billing.stripe.com`; not a CSP issue per se (full nav, not
  iframe), but worth a Frame-Ancestors-DENY confirmation.
- **R2 presigned URLs:** avatar images load from
  `*.r2.cloudflarestorage.com`. CSP `img-src` must allowlist.
- **LiveKit:** future agent-session UI needs WebRTC + WebSocket to
  `wss://mac-NNN.driftstack.dev:8443`. CSP `connect-src` +
  `media-src` allowlist.

**Recommended follow-up slice** (~3-4 hours):

1. Enumerate all inline-script blocks across dashboard pages.
2. Install an Astro middleware that injects a per-request nonce
   and rewrites inline scripts to use that nonce.
3. Build the CSP directive list with explicit allowlists:
   ```
   default-src 'self';
   script-src 'self' 'nonce-{NONCE}' https://js.sentry-cdn.com;
   style-src 'self' 'unsafe-inline';  (Tailwind requires unsafe-inline for some utility patterns)
   img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://lh3.googleusercontent.com https://avatars.githubusercontent.com;
   connect-src 'self' https://api.driftstack.dev wss://*.driftstack.dev:* https://*.ingest.de.sentry.io;
   frame-ancestors 'none';
   form-action 'self' https://checkout.stripe.com https://billing.stripe.com;
   base-uri 'self';
   object-src 'none';
   upgrade-insecure-requests;
   ```
4. Roll out behind a `Content-Security-Policy-Report-Only` header
   first to catch real-world violations without breaking the page.
5. Promote to enforcing `Content-Security-Policy` after a clean
   24-72h report window.

### HSTS — owned at Cloudflare zone level

Cloudflare zone settings handle `Strict-Transport-Security` +
HSTS preload-list participation. Not duplicated per-path in
`_headers` per the existing cdn-strategy doc.

## Verdict

**Pre-launch action shipped in this commit:**
4 of the 5 standard security headers added to customer-dashboard

- admin-panel. Closes the clickjacking + MIME-sniffing + referrer-
  leak gaps end-to-end.

**Pre-launch follow-up (recommended, not blocking):**
CSP rollout in report-only mode for 24-72h, then enforce. Real
work — needs the nonce-middleware + allowlist enumeration. Tracked
as a separate slice.

**Out of scope (this audit):**

- HSTS — Cloudflare zone owns it.
- CORS — API surface; not a dashboard concern.
- Subresource integrity — no third-party-CDN script tags today
  outside Sentry.
- Cross-Origin-Embedder-Policy / Cross-Origin-Opener-Policy —
  no embed surfaces; explicit OFF posture is documented at
  `apps/marketing-site/src/pages/docs/api-security-headers.astro:118`.

## Files touched

- `apps/customer-dashboard/public/_headers` (new)
- `apps/admin-panel/public/_headers` (new)
- `docs/internal/2026-05-20-csp-header-audit.md` (this file)

## 2026-06-05 follow-up — Permissions-Policy gap closed (marketing + docs)

The Permissions-Policy deny (`accelerometer=(), camera=(), geolocation=(), gyroscope=(),
magnetometer=(), microphone=(), payment=(), usb=()`) recommended above shipped on
customer-dashboard, admin-panel, and status-site, but had NOT been applied to marketing-site
or docs (separate Cloudflare Pages projects do not cross-inherit `_headers`). Closed 2026-06-05
(autopilot): added the identical deny-all line to `apps/marketing-site/public/_headers` +
`apps/docs/public/_headers`, bringing the Pages family to 5/5 consistent. Safe — both are
static/content sites that use none of these features (verified: no `getUserMedia` / geolocation /
inline `PaymentRequest`; Stripe checkout is a hosted redirect on the dashboard). Each app's
own `*-public-headers-*` parity test now pins Permissions-Policy, so a future per-app drop is
caught. CSP itself remains intentionally deferred family-wide (unchanged).

## 2026-07-13 follow-up — CSP enforced family-wide

The deferred runtime-origin audit is complete and the compatibility-safe baseline now ships on
all six Cloudflare Pages projects: marketing, customer dashboard, admin, status, docs, and the
generated error reference.

The audit verified:

- Astro emits hundreds of intentional inline application/JSON-LD blocks across the static pages.
  Per-request nonces do not apply to these static builds and a catch-all list of per-page hashes
  would be brittle, so `script-src 'self' 'unsafe-inline'` is an explicit compatibility tradeoff.
  Remote scripts are still forbidden.
- Customer/admin/status browser requests target `https://api.driftstack.dev`; status additionally
  reads `https://r2-public.driftstack.dev`. Marketing's live badge targets the public API and its
  `/cdn-cgi/trace` request is same-origin.
- Optional marketing/dashboard Sentry telemetry is bundled as first-party script and may connect
  only to the EU/global Sentry ingest host families. There are no third-party script tags.
- Stripe checkout and billing portal actions are top-level navigations, not frames, forms, or
  browser fetches. They require no CSP network source.
- Customer/admin avatars can be provider-hosted HTTPS URLs; downloads use blob URLs. The other
  sites use only first-party/data/blob imagery (docs preserves HTTPS images for authored guides).
- Docs Pagefind search compiles its same-origin WebAssembly index on first use, so only that
  surface adds `'wasm-unsafe-eval'`; JavaScript eval remains forbidden.

Every policy now enforces `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`, `frame-src 'none'`, `form-action 'self'`, bounded script/style/image/font/
connect sources, `manifest-src 'self'`, and `upgrade-insecure-requests`. The errors site has no
JavaScript and uses the stricter `script-src 'none'; connect-src 'none'`. A cross-app regression
test pins the exact per-surface contracts and rejects remote script allowances.

## 2026-07-14 follow-up — dashboard one-time URLs send no referrer

The authenticated dashboard now uses `Referrer-Policy: no-referrer` instead of
the family default `strict-origin-when-cross-origin`. OAuth callback, magic-link,
password-reset, and email-verification URLs carry one-time code/state/token query
parameters. The W3C Referrer Policy algorithm sends a full stripped URL for
same-origin requests under `strict-origin-when-cross-origin`, so ordinary
same-origin asset or navigation traffic could copy those credentials into the
static origin's `Referer` logs. `no-referrer` suppresses the header for every
dashboard request. Admin, marketing, docs, and status retain their audited
policies because they do not share this query-credential route family.
