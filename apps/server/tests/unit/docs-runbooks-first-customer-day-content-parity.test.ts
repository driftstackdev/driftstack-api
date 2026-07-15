// W555.C — drift guard for /docs/runbooks/first-customer-day.md.
// V-519 first-7-days playbook. Drift here either weakens the
// launch-day-vs-first-customer-day distinction (would confuse
// what's been done from what's still to come), drops the
// proactive-outreach trigger inventory (would lose the "value
// proactive over incident-response" posture), or weakens the
// sample-of-1 vs representative-sample boundary (would invite
// arch refactor based on one customer's preference).
//
//   • V-519. Distinct from launch-day-runbook (cutover).
//   • Reference, not script.
//   • First-7-days timeline: Hour 0 + Hour 1-24 + Day 2-7.
//   • Hour 0 watch: Sentry breadcrumbs + Pino logs + DLQ depth
//     + webhook_deliveries.status. Touch: welcome email + status
//     page check-in.
//   • Hour 1-24 active: session latency vs load-test baseline +
//     V-485 tier-features gate + audit-log filter/export.
//   • Proactive outreach triggers: 50% concurrent cap + 3 webhook
//     4xx + any Sentry error + free/duration or paid-cap pressure.
//   • Day 2-7: what worked (private case study with consent) /
//     what didn't (V-NNN P-1/P-2/P-3) / what's next.
//   • Re-review after first customer + every 3 thereafter.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/first-customer-day.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W555.C /docs/runbooks/first-customer-day.md content parity', () => {
  const body = read(LIB);

  it("Header + V-519 + launch-day-vs-first-customer distinction framing pinned: '# First-customer day playbook (V-519)' + 'The day the first paying customer signs up. Distinct from `docs/operations/launch-day-runbook.md` (which covers flipping production from staging-only to publicly accepting customers) — this playbook covers the first 7 days AFTER a real customer shows up, when every event is novel and surprises are most likely.' + 'Reference, not script. Read it before, refer back during.' — pinned so the V-519-playbook + first-paying-customer + distinct-from-launch-day-runbook + 7-days-AFTER + reference-not-script commitment survives", () => {
    expect(body).toMatch(/^# First-customer day playbook \(V-519\)$/m);
    expect(body).toMatch(/The day the first paying customer signs up\. Distinct from/);
    expect(body).toMatch(/`docs\/operations\/launch-day-runbook\.md` \(which covers flipping/);
    expect(body).toMatch(/production from staging-only to publicly accepting customers\) —/);
    expect(body).toMatch(/this playbook covers the first 7 days AFTER a real customer/);
    expect(body).toMatch(/shows up, when every event is novel and surprises are most likely\./);
    expect(body).toMatch(/Reference, not script\. Read it before, refer back during\./);
  });

  it("Signal-trigger framing pinned: '## Signal that triggers this playbook' + 'The very first signup that's not the founder's own test account or a Driftstack-internal smoke test.' + 'Sentry breadcrumb `auth.signup` with `account_id: acc_<uuid>` not matching the founder's known test account list.' + 'Postmark \"signup-welcome\" delivery to a `@example.com` / `@gmail.com` / customer-domain address.' + '`/v1/admin/overview` accounts.active count incrementing past the founder's known-staff baseline.' — pinned so the not-founder's-test + 3-detection-signals (Sentry-auth.signup + Postmark-signup-welcome + /v1/admin/overview-accounts.active) commitment survives", () => {
    expect(body).toMatch(/## Signal that triggers this playbook/);
    expect(body).toMatch(/The very first signup that's not the founder's own test account/);
    expect(body).toMatch(/or a Driftstack-internal smoke test\./);
    expect(body).toMatch(/- Sentry breadcrumb `auth\.signup` with `account_id: acc_<uuid>`/);
    expect(body).toMatch(/not matching the founder's known test account list\./);
    expect(body).toMatch(/- Postmark "signup-welcome" delivery to a `@example\.com` \//);
    expect(body).toMatch(/`@gmail\.com` \/ customer-domain address\./);
    expect(body).toMatch(/- `\/v1\/admin\/overview` accounts\.active count incrementing past/);
    expect(body).toMatch(/the founder's known-staff baseline\./);
  });

  it("Hour 0 watch + touch framing pinned: '## Hour 0 — first 60 minutes' + '### Watch (don't touch)' + '**Sentry breadcrumbs**' + '**Pino structured logs** — `journalctl -u driftstack-server -f`' + 'no V-494 redacted fields appear in plaintext.' + '**DLQ depth** at `/v1/admin/overview` — should remain 0. Any non-zero value during their first hour is a P-1 incident (per V-513 alert rules).' + '**Webhook deliveries**' + '### Touch (intentionally)' + '**Welcome email** — send a personal, non-templated email from `support@driftstack.dev` within 1 hour. Don't be promotional.' + '\"Welcome aboard. I'm John, the founder.' + '**Status page check-in**' — pinned so the Hour-0-Watch-Touch-split + journalctl-driftstack-server + V-494-redacted-fields + DLQ-non-zero=P-1 + V-513-alert-rules + welcome-email-not-promotional + I'm-John-the-founder + status-page-check-in commitment survives", () => {
    expect(body).toMatch(/## Hour 0 — first 60 minutes/);
    expect(body).toMatch(/### Watch \(don't touch\)/);
    expect(body).toMatch(/- \*\*Sentry breadcrumbs\*\*/);
    expect(body).toMatch(/- \*\*Pino structured logs\*\* — `journalctl -u driftstack-server -f`/);
    expect(body).toMatch(/no V-494 redacted fields appear in plaintext\./);
    expect(body).toMatch(/- \*\*DLQ depth\*\* at `\/v1\/admin\/overview` — should remain 0\. Any/);
    expect(body).toMatch(/non-zero value during their first hour is a P-1 incident/);
    expect(body).toMatch(/\(per V-513 alert rules\)\./);
    expect(body).toMatch(/- \*\*Webhook deliveries\*\*/);
    expect(body).toMatch(/### Touch \(intentionally\)/);
    expect(body).toMatch(/- \*\*Welcome email\*\* — send a personal, non-templated email from/);
    expect(body).toMatch(/`support@driftstack\.dev` within 1 hour\. Don't be promotional\./);
    expect(body).toMatch(/"Welcome aboard\. I'm John, the founder\./);
    expect(body).toMatch(/- \*\*Status page check-in\*\*/);
  });

  it('Hour 1-24 monitoring and four current proactive-outreach triggers remain pinned', () => {
    expect(body).toMatch(/## Hour 1–24 — first day/);
    expect(body).toMatch(/### Active monitoring/);
    expect(body).toMatch(/- \*\*Session creation latency\*\* — pull the median \+ p99 from the/);
    expect(body).toMatch(/load-test baseline \(`docs\/load-test\/baselines\/`\) and compare to/);
    expect(body).toMatch(/the customer's actual session creation\. If p99 is >2× baseline,/);
    expect(body).toMatch(/open an internal incident even if the customer hasn't reported/);
    expect(body).toMatch(/anything \(early signal\)\./);
    expect(body).toMatch(/- \*\*Tier-cap behaviour\*\* — does the customer hit a 429 from the/);
    expect(body).toMatch(/V-485 tier-features gate or the rate-limit bucket\?/);
    expect(body).toMatch(/### Proactive outreach/);
    expect(body).toMatch(/- The customer hits 50% of their concurrent cap/);
    expect(body).toMatch(/- The customer's webhook returns >3 4xx responses in a row/);
    expect(body).toMatch(/- Any `level: error` Sentry event tagged with their account_id/);
    expect(body).toMatch(
      /- The customer hits the free-tier duration limit or repeatedly reaches a paid-tier cap/,
    );
    expect(body).not.toMatch(/Trial pack credit drops below 50%/);
    expect(body).toMatch(
      /The customer values\s*\n?\s*proactive support over incident-response support\./,
    );
  });

  it("Day-2-7 + sample-of-1 + audit-metadata framing pinned: '## Day 2–7 — first week' + '### What worked' + 'Document, with consent, in a private case study.' + 'Mind if I share what you've built (anonymized) on our /comparison page or in the changelog?' + '### What didn't' + 'Every friction point becomes a V-NNN slice.' + '**High-friction signup or first-session** → P-1 V-NNN.' + '**Mid-friction docs gap** → P-2 V-NNN.' + '**Low-friction copy / UX rough edge** → P-3 V-NNN.' + 'the first customer is a sample of 1, not a representative sample.' + 'Don't refactor the architecture based on one customer's preference' + 'Playbook authored: V-519 / 2026-05-10.' + 'Playbook re-review cadence: after the first customer (refine based on what was actually relevant) + every 3 customers thereafter until it stabilizes.' — pinned so the Day-2-7-3-categories + private-case-study-consent + 3-priority-V-NNN-slice (P-1/P-2/P-3) + sample-of-1-not-representative + V-519/2026-05-10-authored + every-3-customers-re-review commitment survives", () => {
    expect(body).toMatch(/## Day 2–7 — first week/);
    expect(body).toMatch(/### What worked/);
    expect(body).toMatch(/Document, with consent, in a private case study\./);
    expect(body).toMatch(/Mind if I share what you've built \(anonymized\) on/);
    expect(body).toMatch(/our \/comparison page or in the changelog\?/);
    expect(body).toMatch(/### What didn't/);
    expect(body).toMatch(/Every friction point becomes a V-NNN slice\./);
    expect(body).toMatch(/- \*\*High-friction signup or first-session\*\* → P-1 V-NNN\./);
    expect(body).toMatch(/- \*\*Mid-friction docs gap\*\* → P-2 V-NNN\./);
    expect(body).toMatch(/- \*\*Low-friction copy \/ UX rough edge\*\* → P-3 V-NNN\./);
    expect(body).toMatch(/the first customer is a sample of 1, not a representative/);
    expect(body).toMatch(/sample\./);
    expect(body).toMatch(/Don't refactor the architecture based on one customer's/);
    expect(body).toMatch(/preference/);
    expect(body).toMatch(/- Playbook authored: V-519 \/ 2026-05-10\./);
    expect(body).toMatch(/- Playbook re-review cadence: after the first customer \(refine/);
    expect(body).toMatch(/based on what was actually relevant\) \+ every 3 customers/);
    expect(body).toMatch(/thereafter until it stabilizes\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
