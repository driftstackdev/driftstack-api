// W565.B — drift guard for /docs/internal/v543-customer-success-playbook.md.
// V-543 PLAYBOOK doc 2026-05-11 Wave-22. Drift here either weakens
// the session-success-first-event activation trigger, drops the
// T+0/T+3/T+7/T+30 cadence, or unsets the V-211-anonymity tone
// posture for customer-facing comms.
//
//   • V-543. PLAYBOOK. Activates post-first-paying-customer.
//   • Complements V-519 first-customer-day.md (hour-0/day-1/week-1).
//   • Trigger: session-success-first event (V-518).
//   • Cadence: T+0 welcome + T+3 manual + T+7 free-text + T+30
//     retention.
//   • V-211 anonymity sign-off; support@driftstack.dev reply-to.
//   • 3-level escalation: docs → email → sync call.
//   • 3 bypass-queue (billing + security + sub-processor-outage).
//   • customer_journey schema (V-543.B target).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v543-customer-success-playbook.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W565.B /docs/internal/v543-customer-success-playbook.md content parity', () => {
  const body = read(LIB);

  it("Header + V-543-PLAYBOOK-Wave-22 + V-519-complement + V-518-trigger framing pinned: '# V-543 — customer success playbook' + '**Date:** 2026-05-11' + '**Wave:** 22' + '**Status:** PLAYBOOK — operational document; activates after first paying' + 'customer signs up. Implementation hooks (admin endpoints, scheduled' + 'follow-ups) deferred to V-543.B.' + 'Complements `docs/runbooks/first-customer-day.md` (V-519) which covers' + 'the hour-0 / day-1 / week-1 monitoring posture.' + 'V-543 adds the customer-facing communication side.' + '**Trigger:** a new account completes signup-verification + the first' + 'successful API call (the \"session-success-first\" event already tracked' + 'per V-518).' + '**First touchpoint window:** within 24h of the session-success-first' + 'event.' — pinned so the V-543-PLAYBOOK-Wave-22-2026-05-11 + V-543.B-implementation-deferred + V-519-first-customer-day-hour-0/day-1/week-1-complement + V-518-session-success-first + 24h-first-touchpoint commitment survives", () => {
    expect(body).toMatch(/^# V-543 — customer success playbook$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 22/);
    expect(body).toMatch(
      /\*\*Status:\*\* PLAYBOOK — operational document; activates after first paying/,
    );
    expect(body).toMatch(/customer signs up\. Implementation hooks \(admin endpoints, scheduled/);
    expect(body).toMatch(/follow-ups\) deferred to V-543\.B\./);
    expect(body).toMatch(
      /Complements `docs\/runbooks\/first-customer-day\.md` \(V-519\) which covers/,
    );
    expect(body).toMatch(/the hour-0 \/ day-1 \/ week-1 monitoring posture\. V-543 adds the/);
    expect(body).toMatch(/customer-facing communication side\./);
    expect(body).toMatch(
      /- \*\*Trigger:\*\* a new account completes signup-verification \+ the first/,
    );
    expect(body).toMatch(/successful API call \(the "session-success-first" event already tracked/);
    expect(body).toMatch(/per V-518\)\./);
    expect(body).toMatch(
      /- \*\*First touchpoint window:\*\* within 24h of the session-success-first/,
    );
    expect(body).toMatch(/event\./);
  });

  it("T+0/T+3/T+7/T+30 cadence + tone framing pinned: '### T+0 to T+24h — welcome email' + 'Postmark template `welcome-after-first-session` sent automatically when' + 'Confirms their first session worked.' + 'Two specific links: the admin-panel customer view URL (for them to' + 'bookmark) and a calendar link for a 15-min onboarding call' + '### T+3d — 3-day check-in' + 'Manual review (no automated email yet — Driftstack team eyeballs the' + 'Did they make more than 1 session? If no, the integration may have' + 'hit a wall.' + 'What % of sessions failed? If >20%, investigate' + '### T+7d — week-one feedback ask' + 'Postmark template `week-one-feedback-ask` sent automatically 7 days' + 'One question: \"what's the one thing that would make this 10x more' + 'useful for you?\". No multi-choice survey; pure free-text reply.' + 'within 48h.' + '### T+30d — retention check-in' + 'Are they still active? If session count dropped >50% week-over-week,' + 'Did they upgrade tier?' + '## Communication tone' + 'Plain, direct. No \"I hope this email finds you well\" preamble.' + 'Sign-off is \"Driftstack\" or \"the Driftstack team\", not a personal' + 'name (V-211 anonymity in customer-facing comms).' + 'Reply-to is `support@driftstack.dev`' + 'Email length cap: 100 words for automated touchpoints, 250 for' + 'manual outreach.' — pinned so the welcome-after-first-session-template + 15-min-calendar + T+3-manual-1-session-20%-fail + week-one-feedback-ask-template-free-text-48h-reply + T+30-50%-WoW-drop + V-211-anonymity-sign-off + support@driftstack.dev + 100/250-word-cap commitment survives", () => {
    expect(body).toMatch(/### T\+0 to T\+24h — welcome email/);
    expect(body).toMatch(/Postmark template `welcome-after-first-session` sent automatically when/);
    expect(body).toMatch(/- Confirms their first session worked\./);
    expect(body).toMatch(/- Two specific links: the admin-panel customer view URL \(for them to/);
    expect(body).toMatch(/bookmark\) and a calendar link for a 15-min onboarding call/);
    expect(body).toMatch(/### T\+3d — 3-day check-in/);
    expect(body).toMatch(/Manual review \(no automated email yet — Driftstack team eyeballs the/);
    expect(body).toMatch(/- Did they make more than 1 session\? If no, the integration may have/);
    expect(body).toMatch(/hit a wall\./);
    expect(body).toMatch(/- What % of sessions failed\? If >20%, investigate/);
    expect(body).toMatch(/### T\+7d — week-one feedback ask/);
    expect(body).toMatch(/Postmark template `week-one-feedback-ask` sent automatically 7 days/);
    expect(body).toMatch(/- One question: "what's the one thing that would make this 10x more/);
    expect(body).toMatch(/useful for you\?"\. No multi-choice survey; pure free-text reply\./);
    expect(body).toMatch(/within 48h\./);
    expect(body).toMatch(/### T\+30d — retention check-in/);
    expect(body).toMatch(/- Are they still active\? If session count dropped >50% week-over-week,/);
    expect(body).toMatch(/- Did they upgrade tier\?/);
    expect(body).toMatch(/## Communication tone/);
    expect(body).toMatch(/- Plain, direct\. No "I hope this email finds you well" preamble\./);
    expect(body).toMatch(/- Sign-off is "Driftstack" or "the Driftstack team", not a personal/);
    expect(body).toMatch(/name \(V-211 anonymity in customer-facing comms\)\./);
    expect(body).toMatch(/- Reply-to is `support@driftstack\.dev`/);
    expect(body).toMatch(/- Email length cap: 100 words for automated touchpoints, 250 for/);
    expect(body).toMatch(/manual outreach\./);
  });

  it("3-level escalation + 3-bypass + customer_journey + sub-slices framing pinned: '## Escalation path' + '**Self-serve docs** — the docs site at https://docs.driftstack.io' + '**Email** (`support@driftstack.dev`) — 24h response SLA pre-launch,' + '12h post-launch.' + '**Sync call** — 15min Calendly link' + '**Billing problems** — Stripe webhook failures, charge disputes.' + '**Security incidents** — anything resembling a credential leak or' + 'account takeover. 1-hour response SLA.' + '**Sub-processor outages** — when Postmark / Sentry / Stripe go' + 'down, send a proactive status-page update before customers ask.' + '## Data collected per customer journey' + 'Signup date + first-session date + last-session date.' + 'Sessions count by week (sparkline).' + 'Tier + lifetime cost estimate (V-541 cost model output).' + 'Email touchpoint history' + 'CREATE TABLE customer_journey' + 'account_id          uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE' + 'touchpoints         jsonb NOT NULL DEFAULT '[]'::jsonb' + '## Sub-slices' + '**V-543 (THIS WAVE):** playbook design (this doc).' + '**V-543.B (later):** customer_journey schema' + '**V-543.C (later):** support-thread tracking integration' + 'V-205 + V-211 regex sweep: zero hits.' — pinned so the 3-level-escalation (docs + email-24h-pre/12h-post + 15min-Calendly) + 3-bypass (billing-Stripe + security-1hour-SLA + sub-processor-outage-proactive-status) + customer_journey-table-CASCADE + touchpoints-jsonb-append-only + 3-sub-slice (V-543-design + V-543.B-schema-Postmark-job + V-543.C-support-thread) + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Escalation path/);
    expect(body).toMatch(
      /1\. \*\*Self-serve docs\*\* — the docs site at https:\/\/docs\.driftstack\.io/,
    );
    expect(body).toMatch(
      /2\. \*\*Email\*\* \(`support@driftstack\.dev`\) — 24h response SLA pre-launch,/,
    );
    expect(body).toMatch(/12h post-launch\./);
    expect(body).toMatch(/3\. \*\*Sync call\*\* — 15min Calendly link/);
    expect(body).toMatch(/- \*\*Billing problems\*\* — Stripe webhook failures, charge disputes\./);
    expect(body).toMatch(/- \*\*Security incidents\*\* — anything resembling a credential leak or/);
    expect(body).toMatch(/account takeover\. 1-hour response SLA\./);
    expect(body).toMatch(/- \*\*Sub-processor outages\*\* — when Postmark \/ Sentry \/ Stripe go/);
    expect(body).toMatch(/down, send a proactive status-page update before customers ask\./);
    expect(body).toMatch(/## Data collected per customer journey/);
    expect(body).toMatch(/- Signup date \+ first-session date \+ last-session date\./);
    expect(body).toMatch(/- Sessions count by week \(sparkline\)\./);
    expect(body).toMatch(/- Tier \+ lifetime cost estimate \(V-541 cost model output\)\./);
    expect(body).toMatch(/- Email touchpoint history/);
    expect(body).toMatch(/CREATE TABLE customer_journey/);
    expect(body).toMatch(
      /account_id\s+uuid PRIMARY KEY REFERENCES accounts\(id\) ON DELETE CASCADE/,
    );
    expect(body).toMatch(/touchpoints\s+jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-543 \(THIS WAVE\):\*\* playbook design \(this doc\)\./);
    expect(body).toMatch(/- \*\*V-543\.B \(later\):\*\* customer_journey schema/);
    expect(body).toMatch(/- \*\*V-543\.C \(later\):\*\* support-thread tracking integration/);
    expect(body).toMatch(/- V-205 \+ V-211 regex sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
