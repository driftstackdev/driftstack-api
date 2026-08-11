# Postmark go-live runbook (V-665 / V-486 follow-up)

Founder approval gate satisfied **2026-05-12**. This runbook walks the
operator through activating Postmark on prod + staging, smoke-testing
the welcome + password-reset templates, and confirming the
fire-and-forget failure-categorisation path still behaves correctly.

The code side is **already wired** — `apps/server/src/services/email.ts`
returns a real `PostmarkClient` when the three env vars are present
and a no-op stub otherwise. Going live is purely an ops operation:
set the env vars, restart, smoke-test.

## Pre-flight

- [ ] Postmark server token issued in the **Driftstack** server
      workspace (Postmark dashboard → Servers → API tokens).
- [ ] `From:` address verified at the Sender Signatures level
      (`hello@driftstack.dev` is the canonical sender — verify the
      signature, do not use a `noreply@` domain on first send; Postmark's
      reputation system flags hard-bounce-prone defaults).
- [ ] `Reply-To:` mailbox monitored (`support@driftstack.dev` →
      Helpdesk / Linear).
- [ ] `MessageStream` `outbound` exists in the Postmark server (default
      transactional stream).

## Step 1 — wire env on prod + staging

Write the three vars to `/opt/driftstack/api/.env` on each app server.
Values come from `1Password / Driftstack / Postmark prod token` —
**not** from this runbook, the repo, or any chat transcript.

```
POSTMARK_API_TOKEN=<paste from 1Password>
POSTMARK_FROM=hello@driftstack.dev
POSTMARK_REPLY_TO=support@driftstack.dev
```

Restart the api service:

```sh
systemctl restart driftstack-api
```

Tail the boot logs and confirm the "Postmark not configured" warn
line is **absent** and the `email` component logs nothing at boot
(silent success).

## Step 2 — smoke test

From a workstation with the prod env loaded (or via `scripts/
smoke-postmark.mjs` — see below), fire one of each template at a
**verified test mailbox** (use `qa+postmark@driftstack.dev` or an
alias you own — Postmark will hard-bounce non-existent addresses
and a sustained hard-bounce rate trips the account into
review).

```sh
node scripts/smoke-postmark.mjs \
  --to qa+postmark@driftstack.dev \
  --templates signup-verification,password-reset,signup-welcome
```

Expected:

- 3 `email sent` info logs in the api journal, one per template.
- 3 messages visible in the Postmark Activity view (status `sent`).
- 0 `email send failed` warns.

If any template fails:

- Category `pending-approval` (code 412) → wait for Postmark
  account-approval email; nothing to fix code-side.
- Category `inactive-recipient` (code 405) → the test recipient was
  previously hard-bounced; use a fresh address or remove the
  inactive-recipient entry from the Postmark dashboard.
- Category `invalid-request` (code 422) → template variables
  missing or malformed — capture the message and file a ticket.
- Category `transport` → network / Postmark outage; chaos script
  `scripts/chaos/01-postmark-outage.sh` exercises this path.

## Step 3 — verify customer-flow integration

Use the dashboard's "Resend verification email" UI on a fresh
test account to confirm the **real** customer-side path
(`POST /v1/auth/resend-verification` → `services/auth-flows.ts` →
`emailService.sendSignupVerification`) lights up Postmark Activity.

Then trigger a password reset via the **forgot password** flow:
`POST /v1/auth/password-reset/request` with the test account email
(note the hyphen — `password/reset/request` 404s).
Confirm `password-reset` template appears in Postmark Activity within
~5s.

## Step 4 — alerting

The fire-and-forget warn lines carry a `category` field; ensure the
Sentry alert rule for `email.send failed` filters out `pending-
approval` (expected during the first ~24h) and pages on:

- `category=transport` sustained > 5 in 5 min (Postmark or upstream
  network broken).
- `category=account-inactive` (code 406) — Postmark suspended us.
- `category=unknown` (anything we haven't taxonomized) — investigate.

## Rollback

If hard-bounce rate spikes or Postmark flags the account, set
`POSTMARK_API_TOKEN=` (empty) on the affected server and restart.
`config.ts:readPostmarkConfig` returns `null` when any of the three
vars are missing, which puts the service back into no-op stub mode.
Emails stop firing; the rest of the API continues unaffected.

## Related

- `apps/server/src/services/email.ts` — service implementation +
  `classifyEmailError`.
- `apps/server/src/lib/config.ts:readPostmarkConfig` — env-var
  parsing.
- `docs/internal/postmark-approval-request.md` — the original
  submission, kept for audit history.
- `scripts/chaos/01-postmark-outage.sh` — outage drill.
- `scripts/smoke-postmark.mjs` — go-live smoke test.
