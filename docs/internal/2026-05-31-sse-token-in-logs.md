# 2026-05-31 — SSE `?ds_token=` (and OAuth `?code=`) leaking into logs (Agent 2)

**Status: app-log + ALL Sentry sinks FIXED this wave; nginx access log + the
token-in-URL design SURFACED.** Found by a fresh credential-hygiene audit of the
logging path. The SSE/EventSource auth pattern carries the bearer token in the URL
query string (`?ds_token=`), and the OAuth callback carries `?code=` — both were
reaching logs in plaintext.

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

## REMAINING (surfaced)

1. **nginx access log** — infra. Use a custom `log_format` that logs `$uri`
   (path only) instead of `$request`, or a `map` that strips `ds_token`/`code` from
   `$query_string`. Update the `infra-*-content-parity` pins with the change.
2. **Better long-term design** — don't put the real bearer in the URL at all. Mint a
   **short-lived, single-use SSE ticket** at connection time (exchange the bearer for
   a one-time ticket via a normal `Authorization`-header request, then open the
   EventSource with `?ticket=`). A leaked ticket is then near-worthless (single-use,
   seconds-long TTL). This is the proper fix for the class; the redaction above is
   the immediate mitigation. Founder/architecture call.

Recorded in memory `project_sse_token_in_logs`.
