// W519.C — drift guard for apps/marketing-site/src/pages/docs/emails-reference.astro.
// V-057.C public email-types reference. Drift here either changes a template
// name (would create marketing↔email.ts-TEMPLATES divergence) or breaks the
// transactional-vs-opt-outable distinction (would create marketing↔
// OptOutableEmailEventSchema divergence).
//
//   • V-057.C doc-comment framing + Postmark approval 2026-05-12 anchor.
//   • Catalog derived from apps/server/src/services/email.ts TEMPLATES +
//     OptOutableEmailEventSchema in @driftstack/api-types.
//   • Auth + account-access 2-template: signup-verification + password-reset
//     (both NOT-opt-outable).
//   • Lifecycle 6-template (all opt-outable): signup-welcome +
//     session-success-first (V-304a) + session-failed-first +
//     tier-changed + trial-pack-purchased + trial-pack-expired.
//   • Billing 4-template: billing-receipt (yes opt-outable) + billing-failure
//     (no) + billing-renewal-reminder (yes, V-304b) + subscription-cancellation (no).
//   • Status + ops 6-template: 4 status-* + session-event-digest + quota-warning.
//   • Team + support 2-template: team-invite + support-ack (both not-opt-outable).
//   • Email-preferences API: GET + PUT /v1/account/email-preferences.
//   • Domain framing: noreply@ + reply-to info@ + SPF/DKIM (S38: DMARC claim retired — no record)
//     + rua/ruf reporting + Postmark single-sender + security@ for impersonation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/emails-reference.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W519.C apps/marketing-site/src/pages/docs/emails-reference.astro content parity', () => {
  const body = read(LIB);

  it('V-057.C + Postmark-approval 2026-05-12 + email.ts-TEMPLATES + OptOutableEmailEventSchema framing pinned. Re-enabled by slice 185 after verifying the V-057.C comment exists at emails-reference.astro:4-8 with the matching shape', () => {
    expect(body).toMatch(
      /\/\/ V-057\.C — public reference for the email types Driftstack sends\s*\n?\s*\/\/ \+ how customers manage them\. Built after Postmark approval went\s*\n?\s*\/\/ live on 2026-05-12 so users have a single page to consult\. The\s*\n?\s*\/\/ catalog below is derived from `apps\/server\/src\/services\/email\.ts`\s*\n?\s*\/\/ TEMPLATES \+ `OptOutableEmailEventSchema` in @driftstack\/api-types\./,
    );
  });

  it("Auth + account-access 2-template framing pinned: signup-verification 'Verify your Driftstack account' triggered by POST /v1/auth/signup (No — required to access the account) + password-reset triggered by POST /v1/auth/password-reset/request (No — user-triggered) — pinned so the 2-auth-template + their triggers + their not-opt-outable status survives", () => {
    expect(body).toMatch(
      /<strong>signup-verification<\/strong> — "Verify your Driftstack account"/,
    );
    expect(body).toMatch(/Signup \(<code>POST \/v1\/auth\/signup<\/code>\)/);
    expect(body).toMatch(/<td>No — required to access the account\.<\/td>/);
    expect(body).toMatch(/<strong>password-reset<\/strong>/);
    expect(body).toMatch(
      /Password reset \(<code>POST \/v1\/auth\/password-reset\/request<\/code>\)/,
    );
    expect(body).toMatch(/<td>No — user-triggered\.<\/td>/);
  });

  it('Lifecycle 6-template framing pinned. Re-enabled by slice 235 after restoring the V-304a anchor on the session-success-first row at emails-reference.astro:63 (anchor + parenthetical had drifted to a bare space-period; the other 5 template rows were intact)', () => {
    expect(body).toMatch(/<h2>Lifecycle \(opt-outable\)<\/h2>/);
    expect(body).toMatch(
      /<tr><td><strong>signup-welcome<\/strong><\/td><td>Sent after verify-email succeeds\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><strong>session-success-first<\/strong><\/td><td>First successful session on the account \(V-304a\)\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><strong>session-failed-first<\/strong><\/td><td>First failed session — gentle nudge with debugging tips\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><strong>tier-changed<\/strong><\/td><td>Tier upgrade or downgrade lands\.<\/td><\/tr>/,
    );
    // Trial-pack rows removed with the dead trial_pack lifecycle.
    expect(body).not.toMatch(/<strong>trial-pack-purchased<\/strong>/);
    expect(body).not.toMatch(/<strong>trial-pack-expired<\/strong>/);
  });

  it('Billing 4-template framing pinned. Re-enabled by slice 236 after restoring the V-304b anchor on the billing-renewal-reminder row at emails-reference.astro:91 (same anchor-dropped-to-bare-space pattern as the slice 235 V-304a restore on the same page)', () => {
    expect(body).toMatch(/<strong>billing-receipt<\/strong>/);
    expect(body).toMatch(/<td>Successful charge \(Stripe \/ crypto\)<\/td>/);
    expect(body).toMatch(
      /<td>Yes — opt-outable per\s*\n?\s*<code>OptOutableEmailEventSchema<\/code>, though most\s*\n?\s*customers leave it on for record-keeping\.<\/td>/,
    );
    expect(body).toMatch(/<strong>billing-failure<\/strong>/);
    expect(body).toMatch(/<td>Payment attempt failed; carries portal URL \+ retry-at\.<\/td>/);
    expect(body).toMatch(/<td>No — needed to recover payment before suspension\.<\/td>/);
    expect(body).toMatch(/<strong>billing-renewal-reminder<\/strong>/);
    expect(body).toMatch(/<td>3-7 days before annual renewal \(V-304b\)\.<\/td>/);
    expect(body).toMatch(/<strong>subscription-cancellation<\/strong>/);
    expect(body).toMatch(/<td>Subscription cancellation processed\.<\/td>/);
  });

  it('Status + ops 7-template framing pinned: status-subscription-confirmation + status-subscription-welcome + status-incident-{created,updated,resolved} (status-incident-updated added 2026-05-16 for V-545.B Phase 2) + session-event-digest + quota-warning', () => {
    expect(body).toMatch(/<strong>status-subscription-confirmation<\/strong>/);
    expect(body).toMatch(
      /<td>Email-list opt-in confirmation from\s*\n?\s*<a href="https:\/\/status\.driftstack\.dev">status page<\/a>\.<\/td>/,
    );
    expect(body).toMatch(
      /<td>The link in this email is itself the\s*\n?\s*opt-in confirmation; status emails carry one-click\s*\n?\s*unsubscribe\.<\/td>/,
    );
    expect(body).toMatch(/<strong>status-subscription-welcome<\/strong>/);
    expect(body).toMatch(/<strong>status-incident-created<\/strong>/);
    expect(body).toMatch(/<strong>status-incident-updated<\/strong>/);
    expect(body).toMatch(/<strong>status-incident-resolved<\/strong>/);
    expect(body).toMatch(
      /<td>Unsubscribe link in body \(single subscription\s*\n?\s*covers create \+ update \+ resolve\)\.<\/td>/,
    );
    expect(body).toMatch(/<strong>session-event-digest<\/strong>/);
    expect(body).toMatch(/<td>Weekly summary of sessions run \+ outcomes\.<\/td>/);
    expect(body).toMatch(/<strong>quota-warning<\/strong>/);
    expect(body).toMatch(/<td>Approaching the tier's concurrency \/ minute cap\.<\/td>/);
    expect(body).toMatch(/<td>No — guards against accidental overage\.<\/td>/);
    // V-anchor-leak invariant: internal version anchors must NOT
    // bleed into customer-rendered marketing copy. The
    // status-incident-updated row previously carried "(V-545.B)"
    // inline — scrubbed in the same slice that added this guard.
    expect(body).not.toMatch(/\(V-545\.B\)/);
  });

  it('Team + support 2-template framing pinned: team-invite (admin invites a new member to the team, NOT opt-outable, invitee needs link to accept) + support-ack (Acknowledgement of a support ticket, NOT opt-outable) — pinned so the 2-team+support template + both-not-opt-outable commitment survives', () => {
    expect(body).toMatch(/<strong>team-invite<\/strong>/);
    expect(body).toMatch(/<td>An admin invites a new member to the team\.<\/td>/);
    expect(body).toMatch(/<td>No — the invitee needs the link to accept\.<\/td>/);
    expect(body).toMatch(/<strong>support-ack<\/strong>/);
    expect(body).toMatch(/<td>Acknowledgement of a support ticket\.<\/td>/);
  });

  it("Email-preferences API framing pinned: GET /v1/account/email-preferences (read current toggles) + PUT /v1/account/email-preferences body {event_type, opted_in} + 'PUT updates one event type at a time. Repeat for each toggle you want to change. The full event-type set is in OptOutableEmailEventSchema in @driftstack/api-types.' — pinned so the 2-endpoint surface + one-event-type-per-PUT + OptOutableEmailEventSchema source-of-truth commitment survives", () => {
    expect(body).toMatch(/GET \/v1\/account\/email-preferences\s+# read current toggles/);
    expect(body).toMatch(
      /PUT \/v1\/account\/email-preferences\s+# body: \{ event_type, opted_in \}/,
    );
    expect(body).toMatch(
      /<code>PUT<\/code> updates one event type at a time\. Repeat for\s*\n?\s*each toggle you want to change\. The full event-type set is in\s*\n?\s*<code>OptOutableEmailEventSchema<\/code> in\s*\n?\s*<code>@driftstack\/api-types<\/code>\./,
    );
  });

  // S38 2026-07-07 (fable-truth-audit follow-on) — the old pin locked a FALSE claim: no _dmarc DNS
  // record exists (dig-verified + the 2026-06-02 internal audit), and
  // the live POSTMARK_REPLY_TO is info@, not support@. The page now
  // states only the verifiable SPF + DKIM posture.
  it('Domain + sender-reputation framing pinned: noreply@ from + info@ reply-to + SPF/DKIM + Postmark-single-sender + security@ impersonation report (S38: DMARC p=quarantine claim retired — no record exists)', () => {
    expect(body).toMatch(
      /Driftstack emails come from <code>noreply@driftstack\.dev<\/code>[\s\S]{0,40}with reply-to <code>info@driftstack\.dev<\/code>\. SPF and DKIM[\s\S]{0,120}Postmark is the single sender/,
    );
    expect(body).not.toMatch(/p=quarantine/);
    expect(body).not.toMatch(/reply-to <code>support@driftstack\.dev/);
  });

  it('4-related-doc cluster: /docs/email-troubleshooting + /docs/status-subscriptions + /docs/api-security-headers + /legal/privacy — pinned so the 4-related-doc navigation surface stays complete (drift to dropping /legal/privacy would orphan the email handling from the privacy policy cross-ref)', () => {
    expect(body).toMatch(
      /<a href="\/docs\/email-troubleshooting">Didn't get an email\? — troubleshooting<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/status-subscriptions">Status-subscribe docs<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/api-security-headers">API security headers<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/privacy">Privacy policy<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
