# Runbooks index (V-522)

Operational reference. Each runbook below is a standalone
document for one specific operating concern — pick the right
one by what's happening, not by chronology.

## Pre-launch + launch sequencing

These read in sequence, in the days leading up to commercial
activation:

| Runbook                                                                        | Triggers                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/launch/pre-launch-checklist.md`](../launch/pre-launch-checklist.md)     | The complete pre-launch audit + priority queue (V-279). Read this first; it's the gate.                                        |
| [`docs/operations/launch-day-runbook.md`](../operations/launch-day-runbook.md) | The day you flip from staging-only to publicly accepting paying customers. T-24h checks + T-0 cutover (V-279 + V-516).         |
| [`first-customer-day.md`](first-customer-day.md)                               | The 7 days AFTER the first paying customer signs up. Hour-0 watch / day-1 monitoring / week-1 feedback categorisation (V-519). |

## Day-to-day operations

These read by-incident, when something specific is happening:

| Runbook                                                                              | Triggers                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`incidents.md`](incidents.md)                                                       | Customer-reported bug, security event, sub-processor incident propagation, or any P-0/P-1 surface. Severity ladder + GDPR Art. 33–34 timeline + CSE escalation tree (V-499). |
| [`observability.md`](observability.md)                                               | Configuring Sentry alerts, synthetic checks, load-test cadence, DLQ triage workflow (V-513).                                                                                 |
| [`../deployment/dr-runbook.md`](../deployment/dr-runbook.md)                         | Disaster recovery — host loss, DB corruption, cert failure, sub-processor outage. 11 numbered scenarios with concrete commands.                                              |
| [`../deployment/runbook.md`](../deployment/runbook.md)                               | Routine ops — logs, restart, scale, deploy.                                                                                                                                  |
| [`../deployment/stripe-webhook-testing.md`](../deployment/stripe-webhook-testing.md) | Stripe webhook signature rotation, IPN testing.                                                                                                                              |
| [`v295c-status-site-cf-pages.md`](v295c-status-site-cf-pages.md)                     | Status site (Cloudflare Pages) deploy, posting an incident.                                                                                                                  |
| [`gui-release.md`](gui-release.md)                                                   | Cutting a desktop-client release. The org forbids Actions from creating releases, so one must exist before the build; the tag must equal the app version.                    |
| [`cost-monitoring.md`](cost-monitoring.md)                                           | Cost-alert triage, nightly-job ops, dispatcher reset, threshold tuning, "why doesn't this match my invoice?" script (V-673).                                                 |
| [`crypto-payments.md`](crypto-payments.md)                                           | NowPayments IPN triage, CryptoOrder lifecycle, refund flow, "stuck order" decision tree, pre-merchant-account posture (V-675).                                               |
| [`oauth-ops.md`](oauth-ops.md)                                                       | OAuth client registration, secret rotation, revocation, token-failure triage, security-incident workflow (V-682).                                                            |

## Workspace setup

| Runbook                                                | Triggers                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [`self-hosted-mac-local.md`](self-hosted-mac-local.md) | Set up a complete local stack on macOS (every workspace, drivers, dev/E2E shortcuts). Engineering setup only. |

## Cross-cutting

| Tool                                                                 | Triggers                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`../../scripts/dr-rehearse.sh`](../../scripts/dr-rehearse.sh)       | Local-only DR rehearsal harness — exercises 5 of 11 dr-runbook scenarios that don't need production touchpoints. Refuses to act on production hosts (V-510). |
| [`../../scripts/load-test/run.mjs`](../../scripts/load-test/run.mjs) | Autocannon-based load-test harness with named targets + safety rails (V-495).                                                                                |

## Where to file a new runbook

- **Customer-facing surface** (incident protocol, security
  posture as visible to customers) → `apps/marketing-site/`
  pages under `/security`, `/trust/*`. Internal runbooks STAY
  internal.
- **Pre-launch sequence step** that didn't fit the existing
  runbooks → `docs/operations/<descriptive-name>.md`.
- **Day-to-day operating concern** that's specific enough to
  warrant its own document → `docs/runbooks/<descriptive-name>.md`.
- **Disaster scenario** → add as a new numbered Scenario in
  `docs/deployment/dr-runbook.md`. Don't fragment DR into
  multiple files; it's all one document.

After adding a new runbook, update this README index in the
same commit. The index is the navigation surface.

## Cadence

This index re-reviewed:

- After every Tier-3 architectural change.
- After every customer-facing incident (verifies the runbook
  actually told us what to do).
- Quarterly post-launch.
