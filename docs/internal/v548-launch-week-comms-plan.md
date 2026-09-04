# V-548 — launch-week comms plan

**Date:** 2026-05-11
**Wave:** 24
**Status:** PLAN — activates when the team selects a launch date.
Execution sub-slices (V-548.B-D) ship the actual copy + scheduled
emails closer to launch.

## Purpose

The first public launch is a one-shot signal. Getting the comms shape
right pre-launch prevents the "marketing site is up but nobody knows"
failure mode + the "launch landed but nobody is monitoring" failure
mode. V-548 captures the comms cadence + copy targets + monitoring
hooks for launch week.

## Timeline

### T-30 days — soft signaling

- Marketing site is live; signups open in invite-only mode.
- A small list of invited early customers (5-10) gets first-touch
  access. Their feedback shapes the public launch copy.
- No public announcement yet.

### T-7 days — pre-launch readiness

- Internal launch checklist completed (docs/runbooks/launch-day-
  runbook.md, V-516).
- Comms drafts reviewed:
  - Marketing-site hero copy locked.
  - Pricing page locked.
  - Security / DPA / privacy pages locked + legal reviewed.
  - Launch announcement email draft locked.
  - Social-post drafts locked.
  - Status-page post-launch banner template locked.
- All status-page subscribers confirmed.

### T-1 day — final go/no-go

Driftstack team runs the launch-day-runbook pre-checks:

- Production smoke tests green.
- Stripe live mode tested (single test transaction).
- Postmark / Sentry / Cloudflare all "operational" on their own
  status pages.
- Sub-processors list confirmed current.
- Rollback path documented.

GO confirmed → schedule launch comms for T+0.

### T+0 — launch day

Hour 0 (morning UK time):

- Marketing-site signups flip from invite-only to public.
- Launch announcement email sent to pre-registered list.
- Hacker News post submitted (Show HN: Driftstack — iPhone Safari
  automation API).
- LinkedIn + X posts go live.
- Status-page banner: "Driftstack is now publicly available".

Hour 0-6: active monitoring.

- Live Sentry dashboard open.
- Cost dashboard (V-541) reviewed every 30min.
- New signup count tracked manually.
- Any signup that goes to first-session-success → manual welcome reply
  on top of the automated welcome email.

Hour 6-24: monitored, less intensively.

### T+1 to T+7 — launch week

- Daily 09:00 standup-with-self: signup count, top error rates,
  customer feedback themes.
- Daily Sentry review.
- Daily cost-snapshot review.
- T+3 mid-week social repost.
- T+7 launch-week recap blog post (numbers + lessons).

### T+30 — retrospective

- Public retro post: what worked, what didn't.
- Internal retro: same content, plus the things that won't go public
  (sub-processor wobbles, near-misses).
- Sub-processor performance review — did anything degrade under load?

## Channels + copy targets

### Marketing site

- Hero — the one-line value prop. Should answer "what is Driftstack?"
  in one sentence at 5th-grade reading level.
- Pricing — 3 visible tiers + "contact us" for enterprise. Annual /
  monthly toggle.
- Security — links to DPA + sub-processor list + privacy policy.
- Customer-facing docs at https://docs.driftstack.io.

### Email

- Pre-registered subscriber list → launch announcement (single
  Postmark template). 100 words.
- Existing trial accounts → "we're public now; you're in tier-1 for
  the first month at no charge" (Postmark template).
- After launch, automated welcome-after-first-session email per
  V-543 customer-success playbook.

### Social

- LinkedIn — single post. Technical-credible framing. Tag relevant
  sub-processor partners (Hetzner, Neon, Cloudflare).
- X — single post. Punchier; link in reply.
- HN — `Show HN: Driftstack — iPhone Safari automation API`. Body
  links to the launch blog post.

### Blog

- Launch post: who we are + what we built + the 3 use cases we
  support today. ~800 words.
- Lives at driftstack.io/blog/launch (NEW URL; needs marketing-
  site blog scaffolding which is currently a stub).

## Anti-actions

- **No** founder-personal-brand framing in any public copy (V-211
  anonymity).
- **No** tooling references (V-205) — public copy doesn't credit
  development tools.
- **No** mention of Anthropic / Claude / GPT in marketing copy outside
  of the sub-processor disclosure (which is required, not promotional).
- **No** "world-first" / "world's-best" superlatives — credibility
  comes from being specific about what we do.
- **No** revealing the team size or composition.

## Monitoring during launch hour

| Signal                  | Source                         | Threshold for alert                  |
| ----------------------- | ------------------------------ | ------------------------------------ |
| Signup rate             | `/v1/admin/overview`           | Surge >100/hour → check abuse        |
| First-session-success   | session_lifecycle table        | <50% of signups → integration issue  |
| API error rate          | Sentry                         | >2% → investigate                    |
| Postmark queue depth    | Postmark dashboard             | >100 → email delivery degrading      |
| Stripe failures         | Stripe dashboard               | Any failed live charge → investigate |
| Status-page subscribers | `/v1/admin/status-subscribers` | Growth indicator                     |

## Open questions for team review

1. **Launch hour timing.** UK morning (9am UK = 4am ET = 1am PT;
   captures EU + AU + early US) vs US morning (9am ET = 6am PT
   = 2pm UK; captures US East primarily)? Recommendation: 9am UK —
   founder is EU-based, customer ICP is global.
2. **HN posting account.** A personal account (per HN community
   norm) OR the `driftstackdev` org account? Recommendation: the
   personal-account-of-a-team-member (HN penalises submissions from
   anonymous corporate accounts).
3. **Pre-launch email list source.** Build over 30 days via the
   waitlist on the marketing site, OR purchase a relevant audience
   list? Recommendation: waitlist only — bought lists hit Postmark's
   spam filters + erode trust.

## Sub-slices

- **V-548.B** — copy locked: marketing hero + pricing + launch email
  - social drafts + HN body. Lands T-7 days.
- **V-548.C** — Postmark templates `launch-announcement` +
  `trial-promotion`. Lands T-3 days.
- **V-548.D** — launch-day-runbook amendment with the comms-hour-by-
  hour checklist. Lands T-1 day.

## Verification

- File written.
- Cross-references V-516 launch-day-runbook + V-541 cost dashboard +
  V-543 customer success playbook.
- V-205 + V-211 sweep: zero hits.
