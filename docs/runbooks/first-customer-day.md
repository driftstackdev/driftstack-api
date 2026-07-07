# First-customer day playbook (V-519)

The day the first paying customer signs up. Distinct from
`docs/operations/launch-day-runbook.md` (which covers flipping
production from staging-only to publicly accepting customers) —
this playbook covers the first 7 days AFTER a real customer
shows up, when every event is novel and surprises are most likely.

Reference, not script. Read it before, refer back during.

## Signal that triggers this playbook

The very first signup that's not the founder's own test account
or a Driftstack-internal smoke test. Detected via:

- Sentry breadcrumb `auth.signup` with `account_id: acc_<uuid>`
  not matching the founder's known test account list.
- Postmark "signup-welcome" delivery to a `@example.com` /
  `@gmail.com` / customer-domain address.
- `/v1/admin/overview` accounts.active count incrementing past
  the founder's known-staff baseline.

## Hour 0 — first 60 minutes

The customer just signed up. Most likely path next: pick a tier
or grab the trial pack. Watch but don't intervene.

### Watch (don't touch)

- **Sentry breadcrumbs** — every breadcrumb tagged with the new
  account_id. Watch for any `level: error` or `level: fatal`
  events. If nothing fires, that's the right outcome.
- **Pino structured logs** — `journalctl -u driftstack-server -f`
  on the Hetzner VM. Filter for the customer's account_id. Check
  that no requests are returning 5xx; that auth-cache hits look
  normal; that no V-494 redacted fields appear in plaintext.
- **DLQ depth** at `/v1/admin/overview` — should remain 0. Any
  non-zero value during their first hour is a P-1 incident
  (per V-513 alert rules).
- **Webhook deliveries** — if the customer registers a webhook
  endpoint, every delivery's HMAC signature should verify on
  their side. Track via the `webhook_deliveries.status` column;
  watch for `failed` rows.

### Touch (intentionally)

- **Welcome email** — send a personal, non-templated email from
  `support@driftstack.dev` within 1 hour. Don't be promotional.
  "Welcome aboard. I'm John, the founder. If anything looks off
  or unexpected, reply directly to this email and I'll personally
  look at it." Sets the support expectation as: real human, fast,
  unfiltered.
- **Status page check-in** — verify `/trust/incidents` shows no
  active incident; verify the StatusBadge on the marketing site
  is green. Customers who land on /trust during their first hour
  expect to see operational health.

## Hour 1–24 — first day

The customer is exploring. Sessions get created, webhooks fire,
maybe profiles are minted. This is the highest-novelty window —
every code path being exercised for the first time against a real
customer's actual workload.

### Active monitoring

- **Session creation latency** — pull the median + p99 from the
  load-test baseline (`docs/load-test/baselines/`) and compare to
  the customer's actual session creation. If p99 is >2× baseline,
  open an internal incident even if the customer hasn't reported
  anything (early signal).
- **Tier-cap behaviour** — does the customer hit a 429 from the
  V-485 tier-features gate or the rate-limit bucket? If yes, was
  the error message helpful (named the right scope / tier
  feature)? Capture the customer's reaction in Sentry breadcrumbs.
- **Audit log** — `/v1/account/audit-log` should accumulate
  every action the customer takes. Verify they can filter
  (V-484) and export (V-297) without issues.

### Proactive outreach

If you observe ANY of:

- The customer hits 50% of their concurrent cap
- The customer's webhook returns >3 4xx responses in a row
- Any `level: error` Sentry event tagged with their account_id
- Trial pack credit drops below 50%

→ send a proactive Slack/email check-in: "Hey, I noticed X. Want
to chat about what you're trying to do?" The customer values
proactive support over incident-response support.

## Day 2–7 — first week

The novelty has worn off; the customer's workload patterns
emerge. Three categories of follow-up:

### What worked

Document, with consent, in a private case study. The first
customer's success or failure shapes the marketing surface for
months. Ask: "Mind if I share what you've built (anonymized) on
our /comparison page or in the changelog?" Most early adopters
agree if you frame it as "helps other prospective customers
evaluate."

### What didn't

Every friction point becomes a V-NNN slice. Triage:

- **High-friction signup or first-session** → P-1 V-NNN.
- **Mid-friction docs gap** → P-2 V-NNN.
- **Low-friction copy / UX rough edge** → P-3 V-NNN.

The scope of "first-customer-driven V-NNN slices" is bounded:
the first customer is a sample of 1, not a representative
sample. Don't refactor the architecture based on one customer's
preference — but DO fix anything they bumped into that other
customers will also bump into.

### What's next

After 7 days the customer is no longer "new." Move them off
this playbook into normal customer-support operations
(`docs/runbooks/incidents.md` for any further issues; support
replies are personal, from `info@driftstack.dev` — the auto-ack
template was trimmed S44 2026-07-07, founder-approved).
Schedule a 30-day check-in: "How's it going? Any rough edges
since week 1?"

## Cross-references

- `docs/operations/launch-day-runbook.md` — V-279 launch-day
  cutover (the day BEFORE first customer)
- `docs/runbooks/incidents.md` — V-499 incident classification
  - customer-bug triage flow
- `docs/runbooks/observability.md` — V-513 monitoring layout +
  alert rules
- `docs/deployment/dr-runbook.md` — disaster recovery procedures
- `apps/server/src/services/email.ts` — V-486 + V-304 email
  templates (signup-welcome, session-success-first,
  tier-changed; the support-ack template was trimmed S44
  2026-07-07)
- `apps/marketing-site/src/data/sub-processors.ts` — V-308a +
  V-478 sub-processor change-log (notify the customer of any
  amendments during their first week)

## Audit metadata

- Playbook authored: V-519 / 2026-05-10.
- Pre-launch: forward-looking; will see its first real run when
  the first paying customer signs up post-BV/KvK milestone.
- Playbook re-review cadence: after the first customer (refine
  based on what was actually relevant) + every 3 customers
  thereafter until it stabilizes.
