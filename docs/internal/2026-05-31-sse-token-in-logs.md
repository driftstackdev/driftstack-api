# 2026-05-31 — SSE `?ds_token=` (and OAuth `?code=`) leaking into logs (Agent 2)

**Status: app-log + ALL Sentry sinks + nginx access log now FIXED (2026-07-01);
the token-in-URL design itself (REMAINING item 2 below) is unchanged.** Found by a
fresh credential-hygiene audit of the logging path. The SSE/EventSource auth
pattern carries the bearer token in the URL query string (`?ds_token=`), and the
OAuth callback carries `?code=` — both were reaching logs in plaintext.

## The leak (confirmed by reading the sinks)

`middleware/auth.ts::requireAuthEventSource` accepts the bearer token from
`?ds_token=` because the browser `EventSource` API can't set an `Authorization`
header (a deliberate, documented pattern). But a credential in the URL fans out to
every place that logs the request URL:

1. **Fastify auto request log** — `req.url` includes the query string. The pino
   `redact` list (V-494) covers `req.headers.authorization`/`cookie` etc. but NOT
   the URL string, so `?ds_token=<bearer>` was logged verbatim on every SSE request.
2. **Sentry** — the SDK auto-attaches `event.request.url` + `query_string`; and
   `lib/sentry.ts` _explicitly_ passed `request.url` into `captureException` context
   and into 4 breadcrumb sites (2 messages + 2 `data.url`). The key-name scrubber
   (`scrubInPlace`) doesn't redact a token embedded inside a URL string or a
   breadcrumb message, so all of these leaked.
3. **nginx access log** — `infra/nginx/api.driftstack.dev.conf` uses the default
   `combined` format, whose `$request` logs the full request line incl. the query
   string → the token lands in `/var/log/nginx/api.driftstack.dev.access.log`.

Severity: MEDIUM — credential-in-logs. Bounded by who can read logs, but logs are
broadly accessible, long-retained, and often shipped to third parties; tokens there
are live bearers.

## FIXED this wave (verified)

New `lib/redact-url.ts`: `redactUrlQueryTokens(url)` + `redactQueryString(qs)` parse
the query (not regex) and replace the value of credential params (`ds_token`,
`token`, `access_token`, `code`, `api_key`, …) with `[redacted]`, preserving path +
benign params. Wired in:

- **logger.ts** — a pino `req` serializer that sanitizes the logged `url` (preserves
  Fastify 5's default `method/url/host/remoteAddress/remotePort` shape). Empirically
  verified that Fastify 5.8 uses the `loggerInstance`'s `req` serializer for its
  built-in request logging (probe: a custom serializer is applied and the token does
  NOT appear in the log line).
- **sentry.ts** — `scrubSentryEvent` now sanitizes `event.request.url` +
  `query_string`; and all 5 explicit `request.url` passes (captureException context +
  the 4 breadcrumb message/data sites) are wrapped in `redactUrlQueryTokens`.

Tests: `redact-url.test.ts` (helper boundaries + case-insensitivity), an extended
`sentry-scrub.test.ts` (url/query_string scrub via `__test_scrubSentryEvent`), and
updated `lib-sentry-content-parity` + `sentry-v494-scrub-cross-source-invariant`
pins.

## FIXED 2026-07-01

1. **nginx access log** — a fresh customer-dashboard audit re-surfaced this exact
   gap independently (both routes carrying `?ds_token=`:
   `/v1/agent-sessions/:id/transcript` and `/v1/account/me/notifications`).
   Rather than a custom `log_format`/`map` (more nginx-config surface to get
   subtly wrong, unverifiable locally since this box has no nginx binary to
   `nginx -t` against), applied the SAME `access_log off;` precedent this
   codebase already uses for the identical problem on `/v1/fleet/events`
   (fleet.driftstack.dev.conf): a per-location `access_log off;` for both
   paths in both `api.driftstack.dev.conf` and `staging.driftstack.dev.conf`.
   Sufficient because the app-level structured log (already redacted per the
   FIXED section above) remains the source of truth for IP/timing/status on
   these routes — nginx's raw `combined` log was a redundant, unredacted
   second copy. `infra-content-parity` +
   `infra-bootstrap-deploy-nginx-systemd-content-parity` pins still pass
   unchanged (regex `.toMatch`, not exact-length, so new location blocks
   don't break them). Deployed + `nginx -t`-verified on both prod + staging.

## REMAINING (surfaced, not yet built)

1. **Better long-term design** — don't put the real bearer in the URL at all. Mint a
   **short-lived, single-use SSE ticket** at connection time (exchange the bearer for
   a one-time ticket via a normal `Authorization`-header request, then open the
   EventSource with `?ticket=`). A leaked ticket is then near-worthless (single-use,
   seconds-long TTL). This is the proper fix for the class; the redaction + nginx
   fixes above close every currently-known log-leak vector, so this is a genuine
   architecture upgrade (new auth contract for 2 routes) rather than a live gap —
   Founder/architecture call, not a unilateral A2 change.

Recorded in memory `project_sse_token_in_logs`.
