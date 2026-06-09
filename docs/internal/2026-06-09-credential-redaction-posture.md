# Credential-redaction posture — free-text egress channels (W340–W344)

Consolidates the four-wave secret-egress hardening arc into one rule so the leak
class doesn't regress when a new egress channel is added.

## The rule

**Any channel that emits FREE TEXT off the box — logs, telemetry, error
responses, outbound payloads — MUST redact credential tokens before emitting.**
Structured/key-based redaction (pino `redact.paths`, Sentry key denylist,
`scrubInPlace`) only redacts VALUES by sensitive KEY name; it does NOT reach a
token embedded inside a free-text string (an exception message, a breadcrumb
message, a `captureMessage`, an echoed URL in a 404 detail). Those need a
per-match string redactor.

## The redactors

| Surface                                            | Redactor                                     | Where                                  |
| -------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| Server logs / Sentry / error responses — free text | `redactText(s)`                              | `apps/server/src/lib/redact-url.ts`    |
| Server — structured url / query_string field       | `redactUrlQueryTokens` / `redactQueryString` | same file                              |
| GUI telemetry (Sentry) — free text                 | `scrubText(s)`                               | `apps/gui-client/src/lib/telemetry.ts` |

`redactText`/`scrubText` do a surgical per-match regex pass: credential
query-params (`ds_token`, `access_token`, `code`, `api_key`, `secret`,
`password`, `signature`, …) **and** `Bearer <token>` fragments → `[redacted]`,
leaving surrounding prose intact. Do NOT reuse the url-parsers (`redactUrlQueryTokens`)
on free text — they split on the first `?` and absorb trailing prose into the
redacted param.

## What's covered (don't re-audit)

- **Server logs** — `err` serializer (`redactErrSerializer`, W342) + `req.url`
  serializer; pino `redact.paths` for keyed values.
- **Server Sentry** (`scrubSentryEvent`, W341) — `request.url`/`query_string`,
  `scrubInPlace` keyed values, **+ exception/`event.message`/breadcrumb messages**.
- **Server error responses** — 404 detail redacts the echoed URL (W343); 500s
  emit a generic detail (the cause is logged-not-sent; `toProblem` never emits
  the cause).
- **GUI telemetry** (`scrubEvent`, W340) — headers, `request.url`, extra,
  contexts, **+ exception/breadcrumb messages**.
- **Customer dashboard** — no `console.*` in src (nothing to leak).

## Adding a new egress channel

If it carries free text that could include a customer-supplied or upstream URL /
header / token, run it through `redactText` (server) or `scrubText` (gui) before
it leaves the process, and pin the wiring in a content-parity test (un-wiring a
redactor is a silent re-leak — see the W342 logger test which pins BOTH the
function and its `serializers.err` wiring).
