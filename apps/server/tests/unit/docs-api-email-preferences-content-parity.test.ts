// Drift guard for apps/docs/src/pages/api/email-preferences.md. Pins
// the customer-facing email-preferences docs — operational-vs-
// transactional 2-category split + 8-opt-outable-event roster +
// 7-always-send roster + DPA-affirmative-choice legal posture +
// GET/PUT 2-endpoint surface + team RBAC member-read-admin-write.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/email-preferences content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("2-category operational-vs-transactional split framing pinned: 'Operational — non-optional. Required for the service to work (signup verification, password reset, billing-failure notice, security notices). You cannot opt out of these.' + 'Transactional / informational — opt-outable. Welcome email, first-session activation milestone, tier-change confirmation, billing receipts, renewal reminders. Customers control these via the endpoints below.' — pinned so the 2-category-split + you-cannot-opt-out-of-operational + customers-control-transactional contract all stay documented. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates, so the operational list no longer names them.)", () => {
    expect(body).toMatch(
      /1\. \*\*Operational\*\* — non-optional\. Required for the service to\s*\n?\s*work \(signup verification, password reset, billing-failure\s*\n?\s*notice, security notices\)\. You cannot opt out of these\./,
    );
    expect(body).toMatch(
      /2\. \*\*Transactional \/ informational\*\* — opt-outable\. Welcome\s*\n?\s*email, first-session activation milestone, tier-change\s*\n?\s*confirmation, billing receipts, renewal reminders\./,
    );
    expect(body).not.toMatch(/trial-pack lifecycle/);
    // S44 negative pins — deleted templates must not be re-documented.
    expect(body).not.toMatch(/subscription-cancellation/);
    expect(body).not.toMatch(/support-ack/);
  });

  it("DPA-affirmative-choice legal posture framing pinned: 'The endpoint surface is intentionally narrow: list current preferences, set one preference. Per-event opt-in is the unit; there's no \"opt out of everything optional\" shorthand because the legal posture (per the DPA) requires that we deliver each opt-out as an affirmative customer choice.' — pinned so the per-event-unit + no-bulk-opt-out + DPA-affirmative-choice-rationale contract all stay documented (drift to a bulk opt-out would weaken the GDPR-compliant affirmative-choice posture)", () => {
    expect(body).toMatch(
      /Per-event opt-in is the unit;\s*\n?\s*there's no "opt out of everything optional" shorthand because\s*\n?\s*the legal posture \(per the \[DPA\]\(https:\/\/driftstack\.dev\/legal\/dpa\/\)\) requires that we\s*\n?\s*deliver each opt-out as an affirmative customer choice\./,
    );
    expect(body).not.toContain('https://driftstack.dev/legal/dpa)');
  });

  it("2-endpoint surface pinned: GET /v1/account/email-preferences (list) + PUT /v1/account/email-preferences (set one) + 204 No Content on PUT. Drift to a different verb / response code would mismatch the dashboard's toggle-immediately-no-save-button UX expectation", () => {
    expect(body).toMatch(/`GET \/v1\/account\/email-preferences`/);
    expect(body).toMatch(/`PUT \/v1\/account\/email-preferences`/);
    expect(body).toMatch(/Response: `204 No Content`\./);
  });

  it('6-opt-outable-event roster pinned: signup-welcome + session-success-first + session-failed-first + tier-changed + billing-receipt + billing-renewal-reminder. All default opt-in. Drift to changing the enum would mismatch the OptOutableEmailEventSchema source-of-truth. (The trial-pack pair was removed with the dead trial_pack lifecycle.)', () => {
    expect(body).toMatch(/\|\s*`signup-welcome`/);
    expect(body).toMatch(/\|\s*`session-success-first`/);
    expect(body).toMatch(/\|\s*`session-failed-first`/);
    expect(body).toMatch(/\|\s*`tier-changed`/);
    expect(body).toMatch(/\|\s*`billing-receipt`/);
    expect(body).toMatch(/\|\s*`billing-renewal-reminder`/);
    expect(body).not.toMatch(/`trial-pack-purchased`/);
    expect(body).not.toMatch(/`trial-pack-expired`/);
  });

  it('5-always-send-NOT-opt-outable roster pinned: signup-verification (required to activate) + password-reset (security-critical) + billing-failure (fires on Stripe invoice.payment_failed, S44-live) + status-incident-created/resolved (only to customers subscribed via /status, separate opt-in) + GDPR Art. 34 security notices. Drift to allowing opt-out of any operational class would break customer-protection invariant + likely violate GDPR for security notices. (S44 2026-07-07 trim removed the subscription-cancellation + support-ack bullets — those templates are deleted.)', () => {
    expect(body).toMatch(/- `signup-verification` — required to activate the account\./);
    expect(body).toMatch(/- `password-reset` — security-critical\./);
    expect(body).toMatch(
      /- `billing-failure` — fires on a failed subscription charge\s*\n?\s*\(Stripe `invoice\.payment_failed`\); tells you when the automatic\s*\n?\s*retry happens, or that none is scheduled\./,
    );
    expect(body).toMatch(
      /- `status-incident-created` \/ `status-incident-resolved` — only\s*\n?\s*to customers explicitly subscribed via `\/status`/,
    );
    expect(body).toMatch(/- Security notices under GDPR Art\. 34/);
  });

  it("Team RBAC member-read + admin-write framing pinned: 'A team member with a valid membership can read the OWNER's preferences by passing X-Driftstack-Account: acc_<owner-uuid>. Both member and admin roles are allowed for the read.' + '403 forbidden — set on an OWNER's preferences via X-Driftstack-Account requires admin role on that team; member is read-only on writes.' — pinned so the X-Driftstack-Account team-member-read + admin-only-write contract all stay documented", () => {
    expect(body).toMatch(
      /A team member with a valid membership can read the OWNER's\s*\n?\s*preferences by passing `X-Driftstack-Account: acc_<owner-uuid>`\.\s*\n?\s*Both `member` and `admin` roles are allowed for the read\./,
    );
    expect(body).toMatch(
      /- `403 forbidden` — set on an OWNER's preferences via\s*\n?\s*`X-Driftstack-Account` requires `admin` role on that team;\s*\n?\s*`member` is read-only on writes\./,
    );
  });

  it("Source-of-truth pointer + dashboard-immediate-toggle framing pinned: 'apps/server/src/services/email.ts:TEMPLATES' + 'OptOutableEmailEventSchema' + 'packages/api-types/src/accounts.ts' + 'apps/server/src/routes/email-preferences.ts' + 'apps/server/src/services/email-preferences.ts' + 'apps/server/src/db/email-preferences-repo.ts' + 'Changes apply immediately on toggle (no save button).' — pinned so the canonical source-of-truth navigation contract stays documented (drift to a different schema/route/service path would orphan this doc from the implementation)", () => {
    expect(body).toMatch(/`apps\/server\/src\/services\/email\.ts:TEMPLATES`/);
    expect(body).toMatch(
      /`OptOutableEmailEventSchema` enum is the canonical opt-outable\s*\n?\s*set/,
    );
    expect(body).toMatch(
      /Routes: `apps\/server\/src\/routes\/email-preferences\.ts`\. Schema:\s*\n?\s*`packages\/api-types\/src\/accounts\.ts:OptOutableEmailEventSchema`\./,
    );
    expect(body).toMatch(/Changes apply immediately on toggle \(no save button\)\./);
  });
});
