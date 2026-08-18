// W406.C — drift guard for apps/server/src/services/account-lifecycle.ts.
// V-202b/c central dispatcher for customer-facing lifecycle events
// pairing audit-emit + transactional email. Drift here either breaks
// the atomic dedup gate (duplicate first-failure email) or scrambles
// the tier-changed short-circuit (Stripe subscription.updated for
// non-tier mutations spams audit + email).
//
//   • V-202c / V-202b framing pinned: single emit(accountId, event)
//     abstraction (founder verdict 2026-05-05); V-202c session.failed.
//     first; V-202b subscription.tier_changed.
//   • Best-effort posture: dispatch errors warn-logged + swallowed;
//     caller's primary path (Stripe handler / session failure / etc)
//     never blocked.
//   • Per-event dedup: session.failed.first uses
//     accounts.first_failure_email_sent_at atomic check-and-set;
//     tier_changed short-circuits when fromTier === toTier (Stripe
//     non-tier mutation noise).
//   • Email-preference opt-outs honored via
//     EmailPreferencesService.shouldSend.
//   • LifecycleEvent: 6-kind union (session.failed.first /
//     session.success.first / subscription.tier_changed /
//     subscription.renewal_reminder / billing.payment_succeeded /
//     billing.payment_failed — the billing pair is S44 2026-07-07,
//     founder-approved TD-001 revival). (trial_pack_purchased/expired
//     removed with the dead trial_pack lifecycle.)
//   • V-304a session.success.first: atomic-check-and-set first-success
//     dedup (mirror pattern of failed.first).
//   • V-202b handleTierChanged: short-circuit on fromTier===toTier;
//     system actor in audit (trigger is Stripe webhook).
//   • V-327 handleRenewalReminder: C6 claim-before-send dedup on
//     (stripeEventId, kind) via repo.claimBillingEmail, backed by
//     migration 0099_billing_email_dedup.sql. Claimed after the opt-out
//     and account checks, immediately before the send.
//     V-803 — this bullet used to assert the opposite, that no dedup by
//     event id existed because a duplicate email was cheaper than the
//     machinery. The it() block below has contradicted it since C6
//     landed: the file argued with itself and both halves were green,
//     because nothing compares a pin's prose to its own assertions.
//   • formatCents: Stripe zero-decimal currencies set (16 codes) +
//     USD/EUR/GBP symbols + ISO 4217 fallback.
//   • docsBaseUrl trailing-slash stripped at construction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W406.C apps/server/src/services/account-lifecycle.ts content parity', () => {
  const body = read(LIB);

  it('V-202c / V-202b framing pinned: single emit() abstraction (founder verdict 2026-05-05)', () => {
    expect(body).toMatch(
      /V-202c \/ V-202b — central dispatcher for customer-facing lifecycle\s*\n?\s*\/\/\s*events that pair an audit-log emit and\/or a transactional email send\./,
    );
    expect(body).toMatch(
      /Per founder verdict \(2026-05-05 ack of V-228 follow-up \+ V-202c ack\):\s*\n?\s*\/\/\s*the V-202b\/c wires use a single `emit\(accountId, event\)` abstraction\s*\n?\s*\/\/\s*so call sites stay consistent as the set of lifecycle events grows\./,
    );
  });

  it('Contract notes pinned: best-effort + per-event dedup + email-preference opt-outs', () => {
    expect(body).toMatch(
      /Best-effort by design\. Errors during dispatch are caught \+ logged\s*\n?\s*\/\/\s*warn and never propagate to the calling service\./,
    );
    expect(body).toMatch(
      /Dedup is handled per-event-kind\. `session\.failed\.first` uses the\s*\n?\s*\/\/\s*`accounts\.first_failure_email_sent_at` column with an atomic\s*\n?\s*\/\/\s*check-and-set; `subscription\.tier_changed` short-circuits when\s*\n?\s*\/\/\s*fromTier === toTier \(Stripe sends `subscription\.updated` for\s*\n?\s*\/\/\s*non-tier mutations like payment-method swap\)\./,
    );
    expect(body).toMatch(
      /Email-preference opt-outs are honored via `EmailPreferencesService\.shouldSend`\./,
    );
  });

  it('LifecycleEvent: 6-kind union (session.failed.first / session.success.first / subscription.tier_changed / renewal_reminder / S44 billing.payment_succeeded / S44 billing.payment_failed)', () => {
    expect(body).toMatch(/export type LifecycleEvent =/);
    expect(body).toMatch(/\| \{\s*\n?\s*kind: 'session\.failed\.first';/);
    expect(body).toMatch(/\| \{\s*\n?\s*kind: 'session\.success\.first';/);
    expect(body).toMatch(/\| \{\s*\n?\s*kind: 'subscription\.tier_changed';/);
    expect(body).not.toMatch(/kind: 'subscription\.trial_pack_purchased';/);
    expect(body).not.toMatch(/kind: 'subscription\.trial_pack_expired';/);
    expect(body).toMatch(
      /\/\/ V-327 — fires when Stripe's `invoice\.upcoming` webhook arrives\s*\n?\s*\/\/ \(~7 days before renewal\)\. Email-only; no audit row[\s\S]+?kind: 'subscription\.renewal_reminder';/,
    );
    // S44 2026-07-07 — the billing pair: receipt honors the V-204
    // opt-out; failure is never opt-outable (no shouldSend gate).
    expect(body).toMatch(
      /S44 2026-07-07 \(founder-approved; TD-001 revival\) — fires on\s*\n?\s*\/\/ Stripe `invoice\.payment_succeeded`[\s\S]+?kind: 'billing\.payment_succeeded';/,
    );
    expect(body).toMatch(
      /S44 2026-07-07 \(founder-approved\) — fires on Stripe\s*\n?\s*\/\/ `invoice\.payment_failed`\. Email-only and NEVER opt-outable[\s\S]+?kind: 'billing\.payment_failed';/,
    );
    expect(body).toMatch(/retryAt: Date \| null;/);
  });

  it('AccountLifecycleRow: 4 fields (id/email + firstFailureEmailSentAt + firstSuccessEmailSentAt nullable dedup flags)', () => {
    expect(body).toMatch(/export interface AccountLifecycleRow \{/);
    expect(body).toMatch(/firstFailureEmailSentAt: Date \| null;/);
    expect(body).toMatch(/firstSuccessEmailSentAt: Date \| null;/);
  });

  it('AccountLifecycleRepo: 3 methods (findForLifecycle + markFirstFailureEmailSent atomic check-and-set + V-304a markFirstSuccessEmailSent)', () => {
    expect(body).toMatch(/export interface AccountLifecycleRepo \{/);
    expect(body).toMatch(
      /findForLifecycle\(accountId: string\): Promise<AccountLifecycleRow \| null>;/,
    );
    expect(body).toMatch(
      /Atomic dedup gate for `session\.failed\.first`\. Sets\s*\n?\s*\*\s*`first_failure_email_sent_at = at` IF AND ONLY IF the column is\s*\n?\s*\*\s*currently NULL\. Returns true when the caller won the race \(proceed\s*\n?\s*\*\s*with the email send\), false when another concurrent caller had\s*\n?\s*\*\s*already set it \(skip the email\)\./,
    );
    expect(body).toMatch(
      /markFirstFailureEmailSent\(accountId: string, at: Date\): Promise<boolean>;/,
    );
    expect(body).toMatch(
      /V-304a — same atomic-check-and-set pattern as\s*\n?\s*\*\s*`markFirstFailureEmailSent`, but for the first successful session\./,
    );
    expect(body).toMatch(
      /markFirstSuccessEmailSent\(accountId: string, at: Date\): Promise<boolean>;/,
    );
  });

  it("emit(): try/catch warn-log 'lifecycle event dispatch failed (best-effort, swallowed)' + 6-case switch", () => {
    expect(body).toMatch(
      /switch \(event\.kind\) \{\s*\n?\s*case 'session\.failed\.first':\s*\n?\s*await this\.handleSessionFailedFirst\(accountId, event\);\s*\n?\s*return;\s*\n?\s*case 'session\.success\.first':/,
    );
    expect(body).toMatch(/'lifecycle event dispatch failed \(best-effort, swallowed\)',/);
  });

  it('handleSessionFailedFirst: atomic mark BEFORE send (race resolution); opt-out check via shouldSend; docsUrl link to /sessions#failure-handling', () => {
    expect(body).toMatch(
      /const allowed = await this\.emailPreferences\.shouldSend\(accountId, 'session-failed-first'\);\s*\n?\s*if \(!allowed\) return;/,
    );
    expect(body).toMatch(
      /\/\/ Atomic mark BEFORE send\. If two concurrent first-failures race, the\s*\n?\s*\/\/ second one's UPDATE finds the column already set and returns false;\s*\n?\s*\/\/ the second caller skips the email\./,
    );
    expect(body).toMatch(
      /const won = await this\.repo\.markFirstFailureEmailSent\(accountId, new Date\(\)\);\s*\n?\s*if \(!won\) return;/,
    );
    expect(body).toMatch(/docsUrl: `\$\{this\.docsBaseUrl\}\/sessions#failure-handling`,/);
  });

  it('V-304a handleSessionSuccessFirst: mirror atomic-check-and-set pattern; docsUrl link to /quickstart', () => {
    expect(body).toMatch(
      /V-304a — fires once per account on the first successful session\.\s*\n?\s*\*\s*Same atomic-check-and-set pattern as handleSessionFailedFirst\./,
    );
    expect(body).toMatch(
      /const won = await this\.repo\.markFirstSuccessEmailSent\(accountId, new Date\(\)\);\s*\n?\s*if \(!won\) return;/,
    );
    expect(body).toMatch(/docsUrl: `\$\{this\.docsBaseUrl\}\/quickstart`,/);
  });

  it('V-202b handleTierChanged: short-circuit on fromTier===toTier; audit emit with system actor; opt-out aware email send', () => {
    expect(body).toMatch(
      /\/\/ Short-circuit no-op transitions — Stripe sends customer\.subscription\.updated\s*\n?\s*\/\/ for non-tier mutations \(payment-method swap, cancel-at-period-end toggle\)\.\s*\n?\s*\/\/ Spamming the audit log \+ email on those would defeat the point\.\s*\n?\s*if \(event\.fromTier === event\.toTier\) return;/,
    );
    expect(body).toMatch(
      /\/\/ Audit emit first \(always wanted when wired\)\. System actor because\s*\n?\s*\/\/ the trigger is Stripe's webhook, not a customer action\./,
    );
    expect(body).toMatch(
      /accountId,\s*\n?\s*actorType: 'system',\s*\n?\s*actorAccountId: null,\s*\n?\s*actorKeyId: null,\s*\n?\s*action: 'subscription\.tier_changed',/,
    );
    expect(body).toMatch(
      /const allowed = await this\.emailPreferences\.shouldSend\(accountId, 'tier-changed'\);/,
    );
    expect(body).toMatch(/fromTier: event\.fromTier \?\? 'unknown',/);
  });

  it("V-327 handleRenewalReminder: C6 claim-before-send dedup; opt-out via 'billing-renewal-reminder'", () => {
    // C6 — the renewal reminder now claims a per-(event, kind) dedup row.
    expect(body).toMatch(
      /V-327 — fires on Stripe `invoice\.upcoming` webhook \(~7 days before\s*\n?\s*\*\s*renewal\)\. Email-only — no audit row[\s\S]+?C6 — claims a per-\(event, kind\)\s*\n?\s*\*\s*dedup row before sending/,
    );
    expect(body).toMatch(
      /const allowed = await this\.emailPreferences\.shouldSend\(accountId, 'billing-renewal-reminder'\);/,
    );
    expect(body).toMatch(
      /const won = await this\.repo\.claimBillingEmail\(\{[\s\S]+?kind: 'billing-renewal-reminder',[\s\S]+?\}\);\s*\n?\s*if \(!won\) return;/,
    );
  });

  it('formatCents: 16-entry Stripe zero-decimal currencies set + USD/EUR/GBP symbols + ISO 4217 fallback', () => {
    expect(body).toMatch(
      /\/\/ Zero-decimal currencies per Stripe's docs:\s*\n?\s*\/\/ https:\/\/stripe\.com\/docs\/currencies#zero-decimal/,
    );
    expect(body).toMatch(
      /const ZERO_DEC = new Set\(\[\s*\n?\s*'BIF',\s*\n?\s*'CLP',\s*\n?\s*'DJF',\s*\n?\s*'GNF',\s*\n?\s*'JPY',\s*\n?\s*'KMF',\s*\n?\s*'KRW',\s*\n?\s*'MGA',\s*\n?\s*'PYG',\s*\n?\s*'RWF',\s*\n?\s*'UGX',\s*\n?\s*'VND',\s*\n?\s*'VUV',\s*\n?\s*'XAF',\s*\n?\s*'XOF',\s*\n?\s*'XPF',\s*\n?\s*\]\);/,
    );
    expect(body).toMatch(
      /if \(ZERO_DEC\.has\(code\)\) \{\s*\n?\s*return `\$\{cents\.toLocaleString\('en-US'\)\} \$\{code\}`;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/if \(code === 'USD'\) return `\$\$\{dollars\}`;/);
    expect(body).toMatch(/if \(code === 'EUR'\) return `€\$\{dollars\}`;/);
    expect(body).toMatch(/if \(code === 'GBP'\) return `£\$\{dollars\}`;/);
  });

  it('Constructor: docsBaseUrl trailing-slash stripped; nullable accountAudit (when null, audit emit skipped + email-only)', () => {
    expect(body).toMatch(/this\.docsBaseUrl = config\.docsBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
    expect(body).toMatch(
      /V-202b — optional\. When wired, `subscription\.tier_changed`\s*\n?\s*\*\s*dispatches both an audit-log entry AND the tier-changed email\.\s*\n?\s*\*\s*When null, the audit emit is skipped and only the email side\s*\n?\s*\*\s*runs\./,
    );
    expect(body).toMatch(/private readonly accountAudit: AccountAuditService \| null = null,/);
  });

  it('handleTrialPackPurchased + handleTrialPackExpired removed with the dead trial_pack lifecycle', () => {
    expect(body).not.toMatch(/handleTrialPackPurchased/);
    expect(body).not.toMatch(/handleTrialPackExpired/);
    expect(body).not.toMatch(/sendTrialPack/);
    expect(body).not.toMatch(/'trial-pack-purchased'/);
    expect(body).not.toMatch(/'trial-pack-expired'/);
  });

  it('AccountLifecycleServiceConfig: 3 URL fields (docsBaseUrl + V-202b billingPortalUrl + V-304a dashboardUrl)', () => {
    expect(body).toMatch(/export interface AccountLifecycleServiceConfig \{/);
    expect(body).toMatch(/docsBaseUrl: string;/);
    expect(body).toMatch(
      /V-202b — Stripe billing portal URL surfaced in tier-changed \+\s*\n?\s*\*\s*billing-\* emails so customers can self-serve subscription\s*\n?\s*\*\s*management\. Same value as the billing service's `portalReturnUrl`\./,
    );
    expect(body).toMatch(/billingPortalUrl: string;/);
    expect(body).toMatch(
      /V-304a — Customer dashboard URL surfaced in the first-successful-\s*\n?\s*\*\s*session email\. Same root as the verify-email \/ login URLs\./,
    );
    expect(body).toMatch(/dashboardUrl: string;/);
  });

  it('imports: AccountTier + Logger + EmailService + EmailPreferencesService + AccountAuditService types', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
    expect(body).toMatch(
      /import type \{ EmailPreferencesService \} from '\.\/email-preferences\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
