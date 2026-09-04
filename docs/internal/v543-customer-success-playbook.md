# V-543 — customer success playbook

**Date:** 2026-05-11
**Wave:** 22
**Status:** PLAYBOOK — operational document; activates after first paying
customer signs up. Implementation hooks (admin endpoints, scheduled
follow-ups) deferred to V-543.B.

## Purpose

Pre-launch, customer success is hypothetical. Post-launch, it's a
load-bearing discipline that decides whether the first 10 customers
churn or anchor. This playbook defines the cadence + escalation path

- data-collection points so the first 10 days after signup follow a
  deliberate motion rather than reactive triage.

Complements `docs/runbooks/first-customer-day.md` (V-519) which covers
the hour-0 / day-1 / week-1 monitoring posture. V-543 adds the
customer-facing communication side.

## When this playbook activates

- **Trigger:** a new account completes signup-verification + the first
  successful API call (the "session-success-first" event already tracked
  per V-518).
- **First touchpoint window:** within 24h of the session-success-first
  event.

The session-success-first event is the key signal — verification-email
clicks alone don't mean the customer integrated the SDK + made the API
work. Waiting for the first real session avoids cold-outreach to
people who signed up and never came back.

## Cadence

### T+0 to T+24h — welcome email

Postmark template `welcome-after-first-session` sent automatically when
the session-success-first event fires:

- Confirms their first session worked.
- Points at the docs site + the SDK README for their language.
- Two specific links: the admin-panel customer view URL (for them to
  bookmark) and a calendar link for a 15-min onboarding call (optional,
  skippable).

Skippable. The link is in the email; clicking is opt-in.

### T+3d — 3-day check-in

Manual review (no automated email yet — Driftstack team eyeballs the
account's usage):

- Did they make more than 1 session? If no, the integration may have
  hit a wall. Surface for a personal outreach email.
- What % of sessions failed? If >20%, investigate which error codes
  dominate — usually a config issue the customer hasn't surfaced.
- Any sub-processor errors (Postmark bounces, Stripe declines)? If
  yes, proactive outreach with the specific issue.

### T+7d — week-one feedback ask

Postmark template `week-one-feedback-ask` sent automatically 7 days
after session-success-first:

- One question: "what's the one thing that would make this 10x more
  useful for you?". No multi-choice survey; pure free-text reply.
- Goes to a real human reply-to inbox. The team commits to responding
  within 48h.

### T+30d — retention check-in

Manual review:

- Are they still active? If session count dropped >50% week-over-week,
  reach out. Don't wait for them to cancel.
- Did they upgrade tier? If yes, send a templated congrats + a calendar
  link for a 30-min "what's working / what's next" call.

## Communication tone

- Plain, direct. No "I hope this email finds you well" preamble.
- Sign-off is "Driftstack" or "the Driftstack team", not a personal
  name (V-211 anonymity in customer-facing comms).
- Reply-to is `support@driftstack.dev` — a real inbox the team checks
  daily.
- Email length cap: 100 words for automated touchpoints, 250 for
  manual outreach. Long emails get skimmed; short emails get read.

## Escalation path

The customer support flow has 3 levels:

1. **Self-serve docs** — the docs site at https://docs.driftstack.io
   answers the top 80% of questions. SDK READMEs + the OpenAPI
   reference + the runbooks index cover common flows.
2. **Email** (`support@driftstack.dev`) — 24h response SLA pre-launch,
   12h post-launch.
3. **Sync call** — 15min Calendly link surfaced only when (a) the
   customer explicitly asks for one, or (b) the team triggers it
   based on a 3-day or 30-day signal.

Issues that bypass the queue:

- **Billing problems** — Stripe webhook failures, charge disputes.
  Direct to the Driftstack team immediately; affect revenue + trust.
- **Security incidents** — anything resembling a credential leak or
  account takeover. 1-hour response SLA.
- **Sub-processor outages** — when Postmark / Sentry / Stripe go
  down, send a proactive status-page update before customers ask.

## Data collected per customer journey

The admin panel's customer-view should surface (V-543.B implementation
target):

- Signup date + first-session date + last-session date.
- Sessions count by week (sparkline).
- Tier + lifetime cost estimate (V-541 cost model output).
- Email touchpoint history (which automated emails sent, when, plus any
  manual outreach logged).
- Open support threads (count + last activity).
- Free-text "watch list" reason if the team flagged the account for
  attention (e.g. "asked about Selenium replacement on call 2026-06-01").

Stored in a new `customer_journey` table (proposed; V-543.B schema
work):

```sql
CREATE TABLE customer_journey (
  account_id          uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  first_session_at    timestamptz,
  last_session_at     timestamptz,
  watchlist_reason    text,
  watchlist_added_at  timestamptz,
  touchpoints         jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

`touchpoints` is an append-only JSON array of
`{ kind, sent_at, template?, note? }` entries.

## Sub-slices

- **V-543 (THIS WAVE):** playbook design (this doc).
- **V-543.B (later):** customer_journey schema + admin customer-view
  surface enhancements + automated touchpoint emails (Postmark templates
  - scheduled-job that fires them on the session-success-first / 7-day
    triggers).
- **V-543.C (later):** support-thread tracking integration if the team
  picks a support tool (Plain / HelpScout / direct-Postmark-only).

## Open questions for team review

1. **Onboarding-call cadence.** Always offer the 15-min call in the
   welcome email (default behaviour) OR only when the team manually
   flags an account as worth a call (more selective; reduces calendar
   load)? Recommendation: default-offer; skippable link.
2. **Reply-to identity.** `support@driftstack.dev` (team-shared inbox)
   OR per-conversation rotation across the team? Recommendation:
   shared inbox for v1; rotate when the team grows past 2 people.
3. **Week-one feedback survey vs free-text.** Single free-text question
   (current proposal) vs. NPS + 1-2 multi-choice? Recommendation:
   free-text — NPS at <10 customers is statistical noise.

## Verification

- File written.
- V-205 + V-211 regex sweep: zero hits.
- Cross-references: V-518 session-success-first event (already
  implemented); V-519 first-customer-day.md (already exists).
