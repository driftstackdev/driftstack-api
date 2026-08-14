# Incident Runbooks (V-499)

This document is the operating manual for everything that goes wrong
in production after launch. It defines:

- the **classification ladder** (P-0 / P-1 / P-2 / P-3) and the
  response posture for each;
- the **customer-reported bug triage** flow;
- the **security incident response** flow (including breach
  notification timelines under GDPR Art. 33–34);
- the **sub-processor incident propagation** flow (forwarding
  upstream incidents to customers per Art. 28);
- the **CSE (Customer-Side Engineering) escalation tree** — i.e.
  which incidents page the founder, which can wait until business
  hours, which auto-resolve;
- the **post-incident review template** (lightweight blameless
  retro that produces a `docs/decisions.md` entry, a tech-debt
  entry, and a V-NNN follow-up if remediation requires code).

Pre-launch posture: the founder is the entire on-call rotation.
There is no second responder. This document is written assuming
that constraint and is the basis for the eventual
runbook-as-customer-facing-trust-signal at /trust.

> Cross-references:
>
> - DR (loss-of-data / loss-of-host) procedures: `docs/deployment/dr-runbook.md`
> - Launch-day playbook: `docs/operations/launch-day-runbook.md`
> - Status posture: `apps/status-site/`
> - Trust center: `apps/marketing-site/src/pages/trust/incidents.astro`

---

## 1. Severity classification

Severity is set at **first report**, not at root-cause discovery.
Re-rate as new information arrives — escalations are normal.

| Severity | Scope                                                    | Examples                                                                                                             | Response time               |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| P-0      | Service is down OR data is being corrupted / exfiltrated | `/v1/status` returning 5xx for >2 min; suspected unauthorized DB access; live API keys leaked publicly; cert expired | Immediate — drop everything |
| P-1      | Major feature broken for all customers                   | Session creation fails for everyone; webhook delivery fully halted; billing webhooks no longer signing; 5xx >1%      | <30 min                     |
| P-2      | Major feature broken for a subset OR minor for all       | Specific archetype failing; UI broken on Safari; one customer's audit log truncated; perf regression doubling p99    | Same business day           |
| P-3      | Cosmetic / docs / single-customer minor                  | Typo in dashboard; wrong copy; non-blocking deprecation warning; quirky CSV export ordering                          | Within 5 business days      |

Severity downgrades require explicit acknowledgement in the
incident timeline ("18:42 — re-rated P-1 → P-2 because impact is
limited to non-production sessions only").

---

## 2. Customer-reported bug triage

Customer reports arrive through three channels:

1. **dev@driftstack.dev** (founder inbox; see
   `docs/founder-action-queue.md` for routing pattern)
2. **Postmark inbound** — once V-486 ships, support@ goes to
   Postmark and threads back via reply-to
3. **GitHub issues** on the public repo (open-source SDKs)

### Triage steps

1. **Acknowledge within 30 min during business hours, end of next
   business day otherwise.** Acknowledgement is a non-AI human
   reply per Rule J — do not auto-respond. Even a single sentence
   ("Got it, looking now — will have a status update by EOD") is
   enough. The acknowledgement starts the customer's clock.

2. **Reproduce.** If you cannot reproduce in <15 min, ask the
   customer for: `account_id` (`acc_<...>`), `session_id`
   (`sess_<...>`) if relevant, exact request body, exact
   response body, timestamp (UTC), and client SDK version. Do
   **not** ask them to send API keys or screenshots that
   include the `Authorization` header — redact in your reply if
   they paste them anyway, and immediately mark those keys for
   rotation in the next step.

3. **Classify** per the table above.

4. **For P-0 / P-1**: file the incident in the admin panel
   (`/incidents`), or `POST /v1/admin/incidents` with `severity`
   one of `minor` / `major` / `outage` and `public: true`; post
   progress with `POST /v1/admin/incidents/:id/updates` and close
   with `POST /v1/admin/incidents/:id/resolve`. The status-site
   banner follows automatically — `/v1/status` derives
   `overall_status` from open public incidents (V-474 StatusBadge
   wire). Filing it anywhere else moves nothing.

5. **Fix or workaround.** Always prefer an immediate workaround
   the customer can deploy themselves (env flag, alternate
   endpoint, smaller payload) over a code fix that takes hours.
   Communicate the workaround back to the customer same-thread.

6. **Code fix lifecycle:** V-NNN slice in v-log → push to main
   (no PR per founder protocol) → wait for `/version` to flip on
   production → notify customer the fix is live → close incident
   (mark resolved in the timeline) → write post-incident review
   (§6).

7. **If credentials may have been exposed during triage** (e.g.
   customer pasted a key in a reply), follow §3.5 below.

---

## 3. Security incident response

### 3.1 Detection sources

- Sentry alert with `severity=fatal` involving auth, billing, or
  PII handlers
- Unexpected admin_audit_log entries (anyone other than the
  founder using staff endpoints)
- Failed-auth burst exceeding the V-066 rate-limit by >10×
- Hetzner / Neon / Upstash / Cloudflare advisory matching our
  region/version
- Customer report mentioning "leaked", "compromised", "didn't
  authorize", "shouldn't have access"
- Threat-intel feeds (manually monitored — pre-launch this is the
  founder reading `oss-security`, `bugtraq`, vendor advisories
  weekly)

### 3.2 First 60 minutes (P-0 security event)

1. **Contain** before investigating. The attacker keeps moving
   while you grep logs.
   - Suspected credential leak → revoke the affected API key(s)
     via `DELETE /v1/api-keys/:id` (the V-049 endpoint). The
     V-066 cache invalidation runs automatically.
   - Suspected unauthorized session → terminate via
     `DELETE /v1/sessions/:id`.
   - Suspected unauthorized account access → force MFA cycle
     (V-353) on the account, force password reset, terminate all
     sessions for the account.
   - Suspected infra compromise → take the affected service out
     of the load-balancer / DNS rotation. Status site banner red.
2. **Preserve evidence.** Snapshot Postgres point-in-time
   (Neon's PITR is on by default), capture Redis with `BGSAVE`,
   pull last 24h of pino logs (Hetzner journalctl). Do this
   _before_ any cleanup that might destroy state.
3. **Open a private incident document** at
   `docs/internal/incidents/YYYY-MM-DD-<slug>.md` — internal-only,
   never push to a public branch until the post-mortem (§6).
4. **Establish timeline.** UTC timestamps for every observation
   and action. The timeline IS the incident — without it the
   post-mortem is fiction.

### 3.3 GDPR Art. 33–34 notification clock

A "personal data breach" under GDPR is a security incident
leading to "accidental or unlawful destruction, loss, alteration,
unauthorized disclosure of, or access to" personal data.

- **72-hour clock starts when the controller becomes aware**, not
  when the breach happened. Awareness = "reasonable degree of
  certainty that a security incident has occurred that has led
  to personal data being compromised" (WP29 / EDPB).
- **Customers get notified "without undue delay"** if the breach
  is "likely to result in a high risk to the rights and freedoms
  of natural persons" (Art. 34). The 72-hour cap does NOT apply
  to customer notification — it applies to the supervisory
  authority. Customer notification can be even faster.
- For Driftstack, the supervisory authority is the **Dutch DPA
  (Autoriteit Persoonsgegevens, AP)**. Reporting form at
  https://datalekken.autoriteitpersoonsgegevens.nl
- If customer data is the data of another EU data subject, the
  one-stop-shop applies — file with AP and they coordinate with
  other DPAs.

> Pre-launch state: zero paying customers means zero personal data
> on file beyond the founder's own. The notification machinery is
> documented here so it's ready for first-customer-day, not
> retroactively assembled during the incident.

### 3.4 Customer notification template (Art. 34)

Subject: `[Security Notice] Driftstack incident YYYY-MM-DD-<slug>`

Body must contain (Art. 34(2)):

1. The nature of the breach and, where possible, the categories
   and approximate number of data subjects + records concerned.
2. The name + contact of the DPO or other contact point (founder
   - dev@driftstack.dev pre-DPO).
3. The likely consequences.
4. The measures taken or proposed to address the breach,
   including (where appropriate) measures to mitigate possible
   adverse effects.

Tone: factual, no marketing, no apology theatre. Customers
deciding whether to keep using us care about the four bullets
above and nothing else.

### 3.5 Credential exposure (customer-side leak in support thread)

Customer pastes a working API key into an email or GitHub issue.

1. Reply same-thread: "I noticed this thread contains an active
   API key (`key_<prefix>...`). I'm rotating it now — please
   issue a new one at https://app.driftstack.dev/api-keys."
2. Use admin scope (V-330d) to revoke the leaked key on the
   customer's behalf.
3. Search the public web for the key prefix (GitHub code search
   is the most common leak vector). If found, note in the
   incident timeline that exposure may extend beyond the email
   thread.
4. This is **not** a personal-data breach unless the API key
   gates access to personal data of the customer's end users.
   Document the assessment in the timeline.

---

## 4. Sub-processor incident propagation

Driftstack's processing chain (per `apps/marketing-site/src/data/sub-processors.ts`):

- Hetzner (compute, EU)
- Neon (Postgres, EU)
- Upstash (Redis, EU)
- Cloudflare (CDN + DNS + Pages, global w/ EU pop preference)
- Postmark (transactional email)
- Stripe (payments, US — SCC + Stripe DPA)
- Sentry (error tracking, EU region)

When one of these has an incident:

1. **Forward without filtering** to the trust center as soon as
   the upstream incident is confirmed. Customers learn about
   sub-processor incidents from us, not from upstream status
   pages they don't follow. File it with `POST /v1/admin/incidents`
   (`public: true`) and put the upstream status URL in the
   description — there is no sub-processor incident type.
2. **Translate impact.** Hetzner network blip in Falkenstein =
   "API control plane may have elevated latency for the next
   ~30 min" — not "Hetzner Falkenstein is degraded". Customers
   shouldn't have to learn our infra topology to understand the
   notice.
3. **If the upstream incident is a security incident**, treat it
   as a Driftstack security incident under §3 with the upstream
   provider in the timeline. Sub-processor breach = our breach
   from the customer's perspective.
4. **Sub-processor change-log** at
   `apps/marketing-site/src/pages/trust/sub-processors` (V-478)
   already maintains the Article 28(2) trail. New entries land
   there for any change in scope, region, or list — not just for
   incidents.

### Notification SLA

- Major upstream outage (>30 min, customer-impacting) — within
  60 min of confirmation
- Upstream security incident affecting Driftstack data — within
  the §3.3 GDPR timelines (so faster than the upstream may notify
  us — we work from the assumption forward)
- Cosmetic upstream issues (e.g. status page UI down at upstream
  but service unaffected) — no propagation

---

## 5. CSE escalation tree (pre-launch single-on-call)

Driftstack is a single-founder operation. CSE = the founder. The
tree below describes which incidents wake the founder vs. queue
for next morning. It will be re-written when a second engineer
joins (post-Series A, conservatively); for now, the goal is
making the page-or-not decision automatic.

```
    incident
       |
       v
    Sev?
   /  |  \
 P0  P1   P2/P3
  |   |     |
  |   |     `--> append to founder-action-queue.md, no page
  |   |
  |   `--> page during 09:00-22:00 CET, queue 22:00-09:00
  |          (see "graceful overnight" §5.1)
  |
  `--> page 24/7 — phone + Slack + Postmark fallback
        (see "P-0 channels" §5.2)
```

### 5.1 Graceful overnight (P-1)

If a P-1 lands between 22:00 and 09:00 CET on a non-launch
weeknight, the queueing logic is:

- If `/v1/status` is still 200 OK and customer impact is
  ≤25% of the customer base — queue. Customers asleep too.
- If status is degraded OR a customer has actively complained
  ("we're seeing 500s right now") — page anyway, because there's
  active business hours somewhere on the planet for the customer
  even when there isn't here.
- Cert expiry warnings (T-7d) go to the queue, not to a page,
  because cert renewal is a known-procedure under
  `dr-runbook.md` Scenario 8.

### 5.2 P-0 channels

A P-0 must reach the founder within 5 minutes regardless of
hour. Channels in order:

1. **Sentry → Slack #alerts** (primary; Sentry mobile app
   push via V-469-wired projects) — fires on `severity=fatal`
2. **Healthcheck failure** — V-289 wires synthetic checks (every
   60s). Failure for 2 consecutive checks = SMS via Postmark
   adjacent provider (gate: founder phone provider supports
   email-to-SMS; queued as a V-NNN follow-up if not).
3. **Founder phone direct** — listed on the trust center as the
   security-contact (`security@driftstack.dev` forwards). For
   pre-launch this is also the personal phone number, gated.

### 5.3 Failover

If the founder is genuinely uncontactable (sleep, surgery, etc.),
the documented fallback is: customers on a P-0 incident contact
**dev@driftstack.dev** (auto-replies with "founder paged, ETA
unknown") and the system runs in last-known-good state. No
second responder pre-launch — this is honestly disclosed at
`/trust/incidents` so customers select Driftstack with eyes open.
A second-responder commitment is a Tier-3 founder decision
gating Series A.

---

## 6. Post-incident review

Every P-0 and P-1 produces a post-incident review (PIR) within
5 business days of resolution. P-2/P-3 produce a tech-debt entry
only.

### 6.1 Template

```markdown
# PIR: <YYYY-MM-DD-slug>

**Severity at peak:** P-0 / P-1
**Detected at:** <UTC>
**Resolved at:** <UTC>
**Total customer-visible impact:** <minutes / hours>
**Detected by:** <synthetic check / customer report / Sentry alert / founder noticing>

## Timeline

(Pasted directly from the internal incident doc — no edits.
The timeline IS the historical record.)

## Root cause

<2–3 paragraphs. The five-whys, written normally — no bullet
fetishism. End on the architectural or process gap, not the
proximate trigger.>

## What went well

<1–3 bullets. There is always something — even if it's just
"the synthetic check fired before any customer complained".>

## What went poorly

<1–3 bullets. Honest. This is not for marketing.>

## Action items

| ID  | Owner   | Description | ETA    |
| --- | ------- | ----------- | ------ |
| 1   | founder | <thing>     | <date> |
| 2   | founder | <thing>     | <date> |

Each action item that requires code becomes a V-NNN slice.
Each that requires policy change becomes a `decisions.md`
entry. Each that's "just remember this" becomes a memory
write per Rule E (agent self-locks).

## Customer communication

<copy of the Art. 34 notice if security; copy of the trust-center
incident entry otherwise>
```

### 6.2 Blameless invariant

The PIR template has no "person responsible" field by design.
Pre-launch this is moot (one person), but the convention sticks
so post-team it doesn't have to be retrofitted. Root cause is
always systemic ("the test suite didn't cover X", "the runbook
assumed Y"), never individual.

### 6.3 Publishing

PIRs are internal-only by default. Public-facing summary lands
at `/trust/incidents` (V-477) with the timeline + impact +
resolution, no internal-process detail. The decision to publish
the full PIR is per-incident — default lean toward more
disclosure than legally required, less than would teach an
attacker how to repeat the attack.

---

## 7. Runbook for this runbook

This file is meant to evolve. After every incident, ask:

1. Did this runbook tell me what to do?
2. Was anything in the runbook actively wrong?
3. Is there a class of incident this runbook doesn't cover?

Updates land via V-NNN slice with `runbook` in the v-log entry.

Last full review: V-499 / 2026-05-10.
