# V-663 — customer success comms templates

**Date:** 2026-05-11
**Wave:** 48
**Status:** TEMPLATES — draft copy for every cadence touchpoint defined
in the V-543 playbook. Operator-editable; treat as a starting position
rather than locked copy.

## Purpose

V-543 defined _when_ customer-success touchpoints fire. V-663 defines
_what_ each touchpoint says. The templates here are the input to the
V-543.B implementation slice (Postmark template provisioning + admin-
panel send buttons + scheduled follow-up cron).

Voice notes:

- Driftstack-first person plural ("we"), customer-first second person ("you").
- No founder name, no AI-tooling attribution (V-211 + V-205).
- Lead with what's working / what's next. Reserve apology language for actual incidents.
- Skippable / opt-out always present; never gated.
- Plaintext-first; HTML variants only where formatting demonstrably helps (lists, tables).

## Variable conventions

Templates reference variables in `{{double_braces}}`. The V-543.B
provisioning pass renders them via Postmark's template-render-context
shape. Common variables:

- `{{customer_name}}` — first name from signup, falls back to email
  local-part.
- `{{dashboard_url}}` — deep-link to the customer's dashboard.
- `{{docs_url}}` — deep-link to the relevant docs section per
  touchpoint.
- `{{calendar_url}}` — onboarding call scheduling link (currently
  Cal.com slug; subject to change in V-543.B).
- `{{unsubscribe_url}}` — per-email unsubscribe (mandatory).
- `{{tier_label}}` — current tier display name ("API Builder", etc.).

---

## T+0 — welcome-after-first-session

**Trigger:** `session.completed_successfully` fires for the first time
on an account (V-304a).

**Channel:** Email (Postmark template `customer-success/welcome`).

**Subject:** `Your first Driftstack session worked — what's next`

**Body (plain text):**

```
Hi {{customer_name}},

Your first Driftstack session ran successfully. Quick orientation
on what tends to make integrations stick:

1. Bookmark your dashboard — that's where session activity, profile
   state, and billing live: {{dashboard_url}}

2. The {{tier_label}} tier docs walk through the patterns most
   customers reach for next: {{docs_url}}

3. Optional — we offer a 15-minute onboarding call if you'd like a
   walkthrough of best practices specific to your use case. No sales
   pitch; just answers your questions. Skip if you'd rather not:
   {{calendar_url}}

If anything trips you up, just reply to this email. A human will get
back to you within one business day.

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## T+3d — three-day-checkin

**Trigger:** 3 days after the welcome touchpoint, only if the customer
has run at least one additional session. (No outreach to silent
accounts — V-543 explicit choice.)

**Channel:** Email.

**Subject:** `How's Driftstack treating you so far?`

**Body (plain text):**

```
Hi {{customer_name}},

A few days in — wanted to check in.

What's working: we see {{sessions_count_7d}} sessions on your
account over the past week, with a success rate of {{success_rate_7d}}%.
That's typical for a healthy integration.

A few things customers often miss in week one:

- Webhook deliveries. If you're polling for session state, you're
  paying latency you don't have to. Webhooks fire within 200ms of
  state changes: {{docs_url}}/webhooks
- Profiles. If you're recreating session state per run, persistent
  profiles let you skip the warm-up. {{docs_url}}/profiles
- Cost dashboard. Live spend + projected end-of-month — particularly
  useful if your usage pattern is irregular. {{dashboard_url}}/billing

Anything we can help with? Just reply.

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## T+14d — two-week milestone

**Trigger:** 14 days after first session, only if account is still active.

**Channel:** Email.

**Subject:** `Two weeks of Driftstack — small thing to ask`

**Body (plain text):**

```
Hi {{customer_name}},

Two weeks in. If you have 60 seconds, two short questions that help
us prioritise what to build next:

  1. What's the single biggest thing missing or annoying about
     Driftstack right now?
  2. What's the one thing you wish we'd build by end of quarter?

Reply with one line each (or skip — no follow-up if you don't
answer).

In return, here's what's shipped or coming since you signed up:

  · {{recent_changelog_bullet_1}}
  · {{recent_changelog_bullet_2}}
  · {{recent_changelog_bullet_3}}

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## At-risk: usage-dropped

**Trigger:** Account had ≥5 sessions/week for 2 weeks, then dropped to
0 sessions for 7 consecutive days (V-543.B-detected pattern).

**Channel:** Email.

**Subject:** `Anything blocking you on Driftstack?`

**Body (plain text):**

```
Hi {{customer_name}},

We noticed your Driftstack usage paused this week. No pressure —
sometimes pauses are intentional (project shipped, holiday, you name
it).

But if something on our end is in the way, we'd like to know:

  · Did a session fail in a way we should fix?
  · Did pricing or quota become an issue?
  · Did you switch to another approach?

A one-line reply is plenty. If you've moved on, that's also useful
data — no follow-up sequence either way.

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## Incident: customer-facing post-incident note

**Trigger:** Manually sent by on-call after an incident affecting the
specific customer's traffic resolves.

**Channel:** Email.

**Subject:** `[Driftstack] Post-incident note — {{incident_short_title}}`

**Body (plain text):**

```
Hi {{customer_name}},

You were on the affected side of an incident we hit yesterday. The
short version:

  · What happened: {{incident_one_line_summary}}
  · Customer impact for your account: {{customer_impact_summary}}
  · Resolution: {{resolution_summary}}
  · Time to detect: {{ttd_minutes}} min
  · Time to recover: {{ttr_minutes}} min

Full incident retro published at:
{{status_page_incident_url}}

We're not asking you to do anything; just wanted you to hear it from
us before you found out elsewhere. If this caused a downstream issue
for you, let us know — we'd like to know about the blast radius.

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## Tier-upgrade: nudge-on-cap-hit

**Trigger:** Customer hits their tier's concurrent-session cap 3+ times
in a 7-day window (signal that they've outgrown the tier).

**Channel:** Email — once per 30 days max per account.

**Subject:** `Bumping into your tier limit — heads up`

**Body (plain text):**

```
Hi {{customer_name}},

Your Driftstack account hit the {{tier_label}} tier's concurrent-session
cap three times this week. Not blocking your work — sessions queue and
run as slots free up — but worth flagging.

If this is a one-off (load test, batch job, etc.), nothing to do.

If it's a sustained pattern, two options:

  · Upgrade to the next tier — instant, prorated to the remaining
    billing period: {{upgrade_url}}
  · Stick with this tier and queue-batch your workload —
    {{docs_url}}/patterns/concurrent

Tier comparison side-by-side: https://driftstack.io/pricing/comparison

— Driftstack

Unsubscribe: {{unsubscribe_url}}
```

---

## Slack-Connect (internal-team): on-the-hour customer health

**Channel:** Slack DM to the on-call engineer (V-543.B-integrated).
Not customer-facing.

**Trigger:** Hourly during business hours; aggregates open customer
signals.

**Format:**

```
:driftstack: Customer health check — {{time_label}}

Active customers: {{active_count}}
At-risk (usage dropped 7d): {{at_risk_count}}
  · {{at_risk_account_1_url}}
  · {{at_risk_account_2_url}}

Tier-cap hits last 24h: {{cap_hit_count}}
Failed sessions / total: {{failed_count}} / {{total_count}}

→ Open dashboard: {{ops_dashboard_url}}
```

---

## Provisioning notes (V-543.B handoff)

When V-543.B wires these templates into Postmark + the admin panel:

1. Each plain-text template above maps to one Postmark template id
   (`customer-success/welcome`, etc.). HTML variants are optional —
   plaintext-first by design.
2. Schedule the cron-driven touchpoints (T+3d, T+14d, at-risk
   detection) on top of the existing V-202d `scheduled_jobs` table.
3. Manual touchpoints (incident note, Slack health check) get
   admin-panel buttons that pre-render the template with the
   relevant account's variables; on-call confirms-and-sends.
4. Every email respects `email_preferences.customer_success_optout`
   (new column V-543.B adds). One-click unsubscribe in every email
   sets this column.

## V-205 + V-211 sweep

- No founder-name tokens — all voice is collective "we / Driftstack".
- No AI-tooling proper-noun strings.
- Variable names use `{{snake_case}}` consistently.

## Sub-slices

- **V-663 (THIS WAVE):** templates locked (this doc).
- **V-543.B (later):** Postmark provisioning + scheduled-job wiring +
  admin-panel send-buttons + opt-out preference column.
