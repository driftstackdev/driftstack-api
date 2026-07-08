// W916 — V-202b/c AccountLifecycle emit dispatcher cross-source
// invariant. Two-hundred-forty-second in the drift-guard series.
// Pins the central customer-facing lifecycle event dispatcher:
//
//   V-202c / V-202b anchor — 'central dispatcher for customer-facing
//   lifecycle events that pair an audit-log emit and/or a
//   transactional email send' (founder verdict 2026-05-05).
//
//   LifecycleEvent discriminated union (6 kinds):
//     - 'session.failed.first'         (V-202c)
//     - 'session.success.first'        (V-304a)
//     - 'subscription.tier_changed'    (V-202b)
//     - 'subscription.renewal_reminder'     (V-327)
//     - 'billing.payment_succeeded'    (S44 2026-07-07; billing-receipt
//       email, V-204 opt-out-aware, TD-001 revival)
//     - 'billing.payment_failed'       (S44 2026-07-07; billing-failure
//       email, never opt-outable — no shouldSend gate by design)
//
//   Contract: best-effort by design. Errors caught + logged warn,
//     never propagate to caller. Caller's primary responsibility
//     (webhook delivery / Stripe handler / session failure) must
//     never be blocked on lifecycle-side work.
//
//   Dedup is per-event-kind:
//     - 'session.failed.first' — accounts.first_failure_email_sent_at
//       atomic check-and-set.
//     - 'subscription.tier_changed' — short-circuits when
//       fromTier === toTier (Stripe sends subscription.updated for
//       non-tier mutations like payment-method swap).
//
//   Email-preference opt-outs honored via
//     EmailPreferencesService.shouldSend.
//
//   AccountLifecycleRepo.findForLifecycle returns 4-field row:
//     id + email + firstFailureEmailSentAt + firstSuccessEmailSentAt.
//
//   AccountLifecycleServiceConfig (3 URLs):
//     - docsBaseUrl (trailing slashes stripped at construction).
//     - billingPortalUrl (V-202b shared with billing portalReturnUrl).
//     - dashboardUrl (V-202b same root as verify-email / login URLs).
//
//   accountAudit is OPTIONAL — when null, audit emit is skipped and
//     only email side runs. Tests that don't exercise audit pass null.
//
//   V-327 renewal_reminder — Stripe invoice.upcoming webhook trigger
//     (~7 days before renewal). Email-only; no audit row. Per
//     privacy.md §3.5 disclosed under 'Information about your
//     subscription'.
//
// stays in lockstep across apps/server/src/services/account-lifecycle.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W916 V-202b/c AccountLifecycle emit dispatcher cross-source invariant', () => {
  // ─── V-202b/c anchor + founder-verdict provenance ────────────

  it("CRITICAL apps/server/src/services/account-lifecycle.ts header pins V-202c / V-202b anchor — 'V-202c / V-202b — central dispatcher for customer-facing lifecycle events that pair an audit-log emit and/or a transactional email send'. The V-202b/c anchors are the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/V-202c \/ V-202b — central dispatcher for customer-facing lifecycle/);
    expect(p).toMatch(/events that pair an audit-log emit and\/or a transactional email send/);
  });

  it("CRITICAL header pins founder verdict — 'Per founder verdict (2026-05-05 ack of V-228 follow-up + V-202c ack)'. The 2026-05-05 founder verdict is the design decision provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/Per founder verdict \(2026-05-05 ack of V-228 follow-up \+ V-202c ack\)/);
  });

  // ─── 6-kind LifecycleEvent discriminated union ───────────────

  it("CRITICAL LifecycleEvent discriminated union has EXACTLY 6 kinds — 'session.failed.first' (V-202c) + 'session.success.first' (V-304a) + 'subscription.tier_changed' (V-202b) + 'subscription.renewal_reminder' (V-327) + 'billing.payment_succeeded' + 'billing.payment_failed' (both S44 2026-07-07, founder-approved TD-001 revival). The 6-kind union covers every customer-facing lifecycle moment. (The trial_pack_purchased/expired pair was removed with the dead trial_pack lifecycle.)", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/export type LifecycleEvent =/);
    expect(p).toMatch(/kind: 'session\.failed\.first';/);
    expect(p).toMatch(/kind: 'session\.success\.first';/);
    expect(p).toMatch(/kind: 'subscription\.tier_changed';/);
    expect(p).toMatch(/kind: 'subscription\.renewal_reminder';/);
    expect(p).toMatch(/kind: 'billing\.payment_succeeded';/);
    expect(p).toMatch(/kind: 'billing\.payment_failed';/);
    // Trial-pack kinds removed — assert they are GONE so the union can't regress.
    expect(p).not.toMatch(/kind: 'subscription\.trial_pack_purchased';/);
    expect(p).not.toMatch(/kind: 'subscription\.trial_pack_expired';/);
  });

  // ─── S44 billing wire — opt-out asymmetry pinned ─────────────

  it('CRITICAL S44 billing.payment_succeeded honors the billing-receipt opt-out; billing.payment_failed DELIBERATELY has no shouldSend gate (billing-failure is critical-path, absent from OptOutableEmailEventSchema). Drift to gating the failure email would let a customer silently miss "your card failed".', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(
      /const allowed = await this\.emailPreferences\.shouldSend\(accountId, 'billing-receipt'\);\s*\n?\s*if \(!allowed\) return;/,
    );
    expect(p).toMatch(/DELIBERATELY no shouldSend gate/);
    // C6 — a per-(event, kind) claim now sits between the account check and
    // the send, but there must still be NO emailPreferences consult on the
    // failure notice (it is critical-path, never opt-outable).
    expect(p).toMatch(
      /private async handlePaymentFailed\([\s\S]+?const account = await this\.repo\.findForLifecycle\(accountId\);\s*\n?\s*if \(account === null\) return;[\s\S]+?await this\.email\.sendBillingFailure\(\{/,
    );
    expect(p).not.toMatch(/shouldSend\(accountId, 'billing-failure'\)/);
  });

  // ─── Best-effort + never-propagate framing ───────────────────

  it("CRITICAL header pins 'Best-effort by design. Errors during dispatch are caught + logged warn and never propagate to the calling service. The caller's primary responsibility (handling the underlying customer event — a webhook delivery, a Stripe handler, a session failure) must never be blocked on lifecycle-side work'. The never-block-the-caller is the API-availability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/Best-effort by design\. Errors during dispatch are caught \+ logged/);
    expect(p).toMatch(/warn and never propagate to the calling service/);
    expect(p).toMatch(/handling the underlying customer event —/);
    expect(p).toMatch(/a webhook delivery, a Stripe handler, a session failure/);
    expect(p).toMatch(/must\s*\n\/\/\s+never be blocked on lifecycle-side work/);
  });

  // ─── Dedup per-event-kind ────────────────────────────────────

  it("CRITICAL session.failed.first dedup framing — 'accounts.first_failure_email_sent_at column with an atomic check-and-set'. The atomic-check-and-set is what prevents duplicate first-failure emails on concurrent webhook re-fires.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/`session\.failed\.first` uses the/);
    expect(p).toMatch(/`accounts\.first_failure_email_sent_at` column with an atomic/);
    expect(p).toMatch(/check-and-set/);
  });

  it("CRITICAL subscription.tier_changed short-circuit framing — 'short-circuits when fromTier === toTier (Stripe sends subscription.updated for non-tier mutations like payment-method swap)'. The short-circuit prevents tier-changed emails on payment-method-only Stripe events.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/`subscription\.tier_changed` short-circuits when/);
    expect(p).toMatch(/fromTier === toTier \(Stripe sends `subscription\.updated` for/);
    expect(p).toMatch(/non-tier mutations like payment-method swap\)/);
  });

  // ─── markFirstFailureEmailSent atomic semantics ──────────────

  it("CRITICAL markFirstFailureEmailSent JSDoc pins 'Atomic dedup gate for session.failed.first. Sets first_failure_email_sent_at = at IF AND ONLY IF the column is currently NULL. Returns true when the caller won the race (proceed with the email send), false when another concurrent caller had already set it'. The race-winner-true contract is what tests assert.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/Atomic dedup gate for `session\.failed\.first`\. Sets/);
    expect(p).toMatch(/`first_failure_email_sent_at = at` IF AND ONLY IF the column is/);
    expect(p).toMatch(/currently NULL\. Returns true when the caller won the race \(proceed/);
    expect(p).toMatch(/with the email send\), false when another concurrent caller had/);
    expect(p).toMatch(/already set it \(skip the email\)/);
  });

  it("CRITICAL markFirstSuccessEmailSent has V-304a anchor + 'same atomic-check-and-set pattern as markFirstFailureEmailSent, but for the first successful session'. The V-304a anchor is the policy-provenance for the success-side mirror.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/V-304a — same atomic-check-and-set pattern as/);
    expect(p).toMatch(/`markFirstFailureEmailSent`, but for the first successful session/);
  });

  // ─── EmailPreferencesService.shouldSend opt-out gate ─────────

  it("CRITICAL email-preference opt-out framing — 'Email-preference opt-outs are honored via EmailPreferencesService.shouldSend'. The shouldSend gate is what makes outbound emails opt-out-aware (V-281 customer-data-portability requirement).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(
      /Email-preference opt-outs are honored via `EmailPreferencesService\.shouldSend`/,
    );
  });

  // ─── AccountLifecycleRow 4-field shape ───────────────────────

  it('CRITICAL AccountLifecycleRow has 4 fields — id + email + firstFailureEmailSentAt (nullable) + firstSuccessEmailSentAt (nullable). The 4-field row carries the dedup state for both first-failure + first-success emails.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/export interface AccountLifecycleRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/email: string;/);
    expect(p).toMatch(/firstFailureEmailSentAt: Date \| null;/);
    expect(p).toMatch(/firstSuccessEmailSentAt: Date \| null;/);
  });

  // ─── 3-URL service config ────────────────────────────────────

  it('CRITICAL AccountLifecycleServiceConfig has 3 URLs — docsBaseUrl + billingPortalUrl + dashboardUrl. The 3-URL config is what templates deep-links into outbound emails — drift to missing one would break a specific email template.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/docsBaseUrl: string;/);
    expect(p).toMatch(/billingPortalUrl: string;/);
    expect(p).toMatch(/dashboardUrl: string;/);
  });

  it("CRITICAL docsBaseUrl trailing-slash stripping — 'Trailing slashes are stripped at construction time. e.g. https://driftstack.dev/docs'. The strip is what makes ${docsBaseUrl}/section template-literal joins safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/Trailing\s*\n\s*\*\s*slashes are stripped at construction time/);
    expect(p).toMatch(/this\.docsBaseUrl = config\.docsBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
  });

  it("CRITICAL billingPortalUrl is V-202b — 'Stripe billing portal URL surfaced in tier-changed + billing-* emails so customers can self-serve subscription management. Same value as the billing service's portalReturnUrl'. The shared-URL contract avoids URL-drift between billing + lifecycle emails.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/V-202b — Stripe billing portal URL surfaced in tier-changed \+/);
    expect(p).toMatch(/billing-\* emails so customers can self-serve subscription/);
    expect(p).toMatch(/management\. Same value as the billing service's `portalReturnUrl`/);
  });

  // ─── accountAudit optional ───────────────────────────────────

  it("CRITICAL accountAudit constructor param is optional (default null) — 'V-202b — optional. When wired, subscription.tier_changed dispatches both an audit-log entry AND the tier-changed email. When null, the audit emit is skipped and only the email side runs. Tests that don't exercise the audit path pass null'. The optional design is what keeps test-bootstrap lightweight.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/V-202b — optional\. When wired, `subscription\.tier_changed`/);
    expect(p).toMatch(/dispatches both an audit-log entry AND the tier-changed email/);
    expect(p).toMatch(/When null, the audit emit is skipped and only the email side/);
    expect(p).toMatch(/private readonly accountAudit: AccountAuditService \| null = null,/);
  });

  // ─── V-327 renewal_reminder framing ──────────────────────────

  it("CRITICAL V-327 renewal_reminder framing — 'fires when Stripe's invoice.upcoming webhook arrives (~7 days before renewal). Email-only; no audit row (the upcoming-charge isn't a state change, just a heads-up). Per privacy.md §3.5 we disclose this trigger to customers under \"Information about your subscription\"'. The privacy.md §3.5 anchor is the GDPR-transparency provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/V-327 — fires when Stripe's `invoice\.upcoming` webhook arrives/);
    expect(p).toMatch(/\(~7 days before renewal\)\. Email-only; no audit row \(the/);
    expect(p).toMatch(/upcoming-charge isn't a state change, just a heads-up\)\. Per/);
    expect(p).toMatch(/privacy\.md §3\.5 we disclose this trigger to customers under/);
    expect(p).toMatch(/"Information about your subscription"/);
  });

  it('CRITICAL renewal_reminder 5 fields — amountCents + currency + renewalDate + stripeEventId + stripeInvoiceId. The 5-field event carries enough Stripe-side correlation to dedupe by stripe_event_id at the caller.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(
      /kind: 'subscription\.renewal_reminder';\s*\n\s*amountCents: number;\s*\n\s*currency: string;\s*\n\s*renewalDate: Date;\s*\n\s*stripeEventId: string;\s*\n\s*stripeInvoiceId: string;/,
    );
  });

  // ─── tier_changed event (dual-source since S41) ─────────────

  it("CRITICAL tier_changed event — fromTier (nullable; 'null when previous tier could not be resolved') + toTier + effectiveAt + dual-source cross-reference metadata: OPTIONAL stripeEventType/stripeEventId (Stripe-driven) or OPTIONAL cryptoOrderId/cryptoPaymentId (S41 crypto-paid-order-driven; exactly one source's metadata is set). The fromTier-nullable handles 'account row missing' resolution failures gracefully.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'));
    expect(p).toMatch(/null when the previous tier could not be resolved \(account row missing\)/);
    expect(p).toMatch(/fromTier: AccountTier \| null;/);
    expect(p).toMatch(/toTier: AccountTier;/);
    expect(p).toMatch(/Stripe event metadata for cross-reference; passed through to audit payload/);
    // S41 2026-07-07 (founder-approved: wire crypto activation) — the Stripe
    // fields are OPTIONAL and the crypto-order fields exist, so a paid crypto
    // order can drive the same audit-row + tier-changed-email fan-out without
    // mislabelling its cross-reference metadata as stripe_*.
    expect(p).toMatch(/stripeEventType\?: string;/);
    expect(p).toMatch(/stripeEventId\?: string;/);
    expect(p).toMatch(/cryptoOrderId\?: string;/);
    expect(p).toMatch(/cryptoPaymentId\?: string \| null;/);
    expect(p).toMatch(/crypto_order_id: event\.cryptoOrderId,/);
    expect(p).toMatch(/crypto_payment_id: event\.cryptoPaymentId \?\? null,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-lifecycle-emit-dispatcher-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
